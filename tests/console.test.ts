import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startConsoleServer, type ConsoleServer } from "../src/console/console-server.js";
import type { RunEvent } from "../src/evidence/logger.js";
import type { RunHost, RunSummary } from "../src/console/run-host.js";

// Port 0: each test gets a fresh port, so a still-open event stream from the previous test
// cannot collide with the next server.
const CONSOLE_PORT = 0;
const balanceArtifact = path.join(process.cwd(), "capabilities", "member-savings-balance.v1.json");

/**
 * A stand-in for RunHost so the server contract can be tested without launching a browser or
 * spending model credits. It records what the routes asked it to do, which is what the tests
 * about validation actually need to assert: a rejected request must never reach the host.
 */
class FakeHost {
  readonly started: unknown[] = [];
  readonly stopped: string[] = [];
  summaries = new Map<string, RunSummary>();
  buffered: RunEvent[] = [];
  frameBuffer: Buffer | null = null;
  private listeners = new Set<(event: RunEvent) => void>();

  seed(runId: string, overrides: Partial<RunSummary> = {}): RunSummary {
    const summary: RunSummary = {
      runId,
      kind: "replay",
      status: "running",
      capabilityName: "member.savings_balance.lookup",
      capabilityPath: balanceArtifact,
      goal: null,
      entryUrl: null,
      tenant: null,
      inject: null,
      inputs: {},
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      discovery: null,
      error: null,
      exitCode: null,
      operatorUrl: null,
      eventCount: 0,
      pendingIntervention: null,
      credentialProfile: null,
      ...overrides,
    };
    this.summaries.set(runId, summary);
    return summary;
  }

  /** Pushes an event to every attached stream, as a real run would mid-flight. */
  emit(event: RunEvent): void {
    this.buffered.push(event);
    for (const listener of this.listeners) listener(event);
  }

  list(): RunSummary[] { return [...this.summaries.values()]; }
  get(runId: string): RunSummary | undefined { return this.summaries.get(runId); }
  events(runId: string): RunEvent[] { return this.summaries.has(runId) ? this.buffered : []; }

  subscribe(runId: string, onEvent: (event: RunEvent) => void, onState: (summary: RunSummary) => void): () => void {
    const summary = this.summaries.get(runId);
    if (!summary) return () => undefined;
    for (const event of this.buffered) onEvent(event);
    onState(summary);
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }

  async frame(): Promise<Buffer | null> { return this.frameBuffer; }
  async stop(runId: string): Promise<boolean> { this.stopped.push(runId); return true; }
  startReplay(request: unknown): RunSummary { this.started.push(request); return this.seed("replay-fake"); }
  startDiscovery(request: unknown): RunSummary {
    this.started.push(request);
    return this.seed("discover-fake", { kind: "discovery", goal: "g", entryUrl: "http://127.0.0.1:1/x" });
  }
}

let server: ConsoleServer;
let host: FakeHost;
let capabilitiesDir: string;
let savedKey: string | undefined;
let savedToken: string | undefined;

beforeAll(() => {
  capabilitiesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-console-"));
  fs.copyFileSync(balanceArtifact, path.join(capabilitiesDir, "member-savings-balance.v1.json"));
  // A file that parses as JSON but is not a capability must not blank the whole catalog.
  fs.writeFileSync(path.join(capabilitiesDir, "broken.json"), JSON.stringify({ name: "nope" }), "utf8");
  fs.writeFileSync(path.join(capabilitiesDir, "notes.txt"), "ignored", "utf8");
});

afterAll(() => {
  fs.rmSync(capabilitiesDir, { recursive: true, force: true });
});

beforeEach(async () => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  host = new FakeHost();
  server = await startConsoleServer({
    port: CONSOLE_PORT,
    capabilitiesDir,
    targetAppUrl: "http://127.0.0.1:4599",
    host: host as unknown as RunHost,
  });
});

afterEach(async () => {
  await server.close();
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
});

const url = (suffix: string): string => `${server.url}${suffix}`;

async function post(suffix: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(url(suffix), {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

describe("capability catalog exposed to the console", () => {
  it("lists only artifacts that parse and lint, and reports their tenants", async () => {
    const listing = await fetch(url("/api/capabilities")).then((r) => r.json());
    expect(listing).toHaveLength(1);
    expect(listing[0].name).toBe("member.savings_balance.lookup");
    expect(listing[0].tenants).toEqual(["base", "beta"]);
    expect(listing[0].inputs.map((input: { name: string }) => input.name)).toContain("memberId");
    expect(listing[0].hasIrreversibleStep).toBe(false);
  });

  it("reports what this install can do so the page can disable discovery with a reason", async () => {
    const config = await fetch(url("/api/config")).then((r) => r.json());
    expect(config.discoveryAvailable).toBe(true);
    expect(config.injectionModes).toContain("app_error");
    expect(config.targetAppUrl).toBe("http://127.0.0.1:4599");
  });
});

describe("starting runs", () => {
  it("keeps a capability path inside the catalog directory", async () => {
    const { status } = await post("/api/runs", { kind: "replay", capabilityPath: "../../../../etc/passwd" });
    expect(status).toBe(400);
    expect(host.started).toHaveLength(0);
  });

  it("rejects a replay with no capability", async () => {
    const { status } = await post("/api/runs", { kind: "replay" });
    expect(status).toBe(400);
    expect(host.started).toHaveLength(0);
  });

  it("passes tenant, injection and inputs through to the host", async () => {
    const { status } = await post("/api/runs", {
      kind: "replay",
      capabilityPath: "member-savings-balance.v1.json",
      inputs: { memberId: "10001" },
      tenant: "beta",
      inject: "app_error",
      operator: true,
    });
    expect(status).toBe(201);
    expect(host.started[0]).toMatchObject({
      inputs: { memberId: "10001" },
      tenant: "beta",
      inject: "app_error",
      operator: true,
    });
  });

  it("refuses discovery when no model credentials are configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { status, json } = await post("/api/runs", {
      kind: "discovery",
      goal: "Look up a balance",
      entryUrl: "http://127.0.0.1:4599/t/alpha/msc/login",
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(host.started).toHaveLength(0);
  });

  it("requires a goal and an absolute entry URL for discovery", async () => {
    expect((await post("/api/runs", { kind: "discovery", entryUrl: "http://127.0.0.1:4599/x" })).status).toBe(400);
    expect((await post("/api/runs", { kind: "discovery", goal: "g" })).status).toBe(400);
    expect((await post("/api/runs", { kind: "discovery", goal: "g", entryUrl: "not-a-url" })).status).toBe(400);
    expect(host.started).toHaveLength(0);
  });

  it("caps discovery steps so a runaway loop cannot be requested from the page", async () => {
    await post("/api/runs", {
      kind: "discovery",
      goal: "Look up a balance",
      entryUrl: "http://127.0.0.1:4599/t/alpha/msc/login",
      maxSteps: 5000,
    });
    expect(host.started[0]).toMatchObject({ maxSteps: 60 });
  });
});

describe("observing a run", () => {
  it("404s for a run that does not exist", async () => {
    expect((await fetch(url("/api/runs/missing"))).status).toBe(404);
    expect((await post("/api/runs/missing/stop")).status).toBe(404);
    expect((await fetch(url("/api/runs/missing/stream"))).status).toBe(404);
  });

  it("delegates a stop to the host", async () => {
    host.seed("replay-1");
    const { status, json } = await post("/api/runs/replay-1/stop");
    expect(status).toBe(200);
    expect(json.stopped).toBe(true);
    expect(host.stopped).toEqual(["replay-1"]);
  });

  it("serves the current frame, 204s before one exists, and 404s for an unknown run", async () => {
    host.seed("replay-1");
    // 204, not 404: the run is real, its browser just has not painted yet. A poller that got a
    // 404 every second during startup would log a failure per tick in the devtools console.
    expect((await fetch(url("/api/runs/replay-1/frame"))).status).toBe(204);
    expect((await fetch(url("/api/runs/missing-run/frame"))).status).toBe(404);
    host.frameBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    const response = await fetch(url("/api/runs/replay-1/frame"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/jpeg");
  });

  it("replays buffered history to a viewer that attaches mid-run, then streams live events", async () => {
    host.seed("replay-1");
    host.emit(makeEvent(1, "run.start"));
    host.emit(makeEvent(2, "step.start"));

    const response = await fetch(url("/api/runs/replay-1/stream"));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";

    // The two events above happened before this viewer connected; it must still see them.
    while (!text.includes("step.start")) text += decoder.decode((await reader.read()).value);
    expect(text).toContain("run.start");
    expect(text).toContain("event: run-state");

    host.emit(makeEvent(3, "step.end"));
    while (!text.includes("step.end")) text += decoder.decode((await reader.read()).value);

    await reader.cancel();
    expect(text.match(/event: run-event/g)).toHaveLength(3);
  });
});

function makeEvent(seq: number, type: RunEvent["type"]): RunEvent {
  return { ts: new Date().toISOString(), runId: "replay-1", seq, type };
}
