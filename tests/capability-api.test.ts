import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startConsoleServer, type ConsoleServer } from "../src/console/console-server.js";
import type { RunHost, RunSummary } from "../src/console/run-host.js";
import type { ReplayResult } from "../src/schema/index.js";

const balanceArtifact = path.join(process.cwd(), "capabilities", "member-savings-balance.v1.json");
const discoveredArtifact = path.join(process.cwd(), "capabilities", "member-savings-balance.discovered.v1.json");

/**
 * The invoke route is synchronous over an asynchronous host: it starts a replay and waits for the
 * terminal summary. This fake resolves immediately with whatever the test seeded, which is enough
 * to assert the route's contract - what reaches the host, and what the caller gets back.
 */
class FakeInvokeHost {
  readonly started: Record<string, unknown>[] = [];
  nextResult: ReplayResult | null = null;
  nextError: string | null = null;

  startReplay(request: Record<string, unknown>): RunSummary {
    this.started.push(request);
    return this.summary("replay-fake", "running");
  }

  async wait(runId: string): Promise<RunSummary> {
    const summary = this.summary(runId, this.nextResult ? "finished" : "errored");
    summary.finishedAt = new Date().toISOString();
    summary.result = this.nextResult;
    summary.error = this.nextError;
    return summary;
  }

  list(): RunSummary[] { return []; }
  get(): RunSummary | undefined { return undefined; }
  events(): never[] { return []; }
  subscribe(): () => void { return () => undefined; }
  async frame(): Promise<null> { return null; }
  async stop(): Promise<boolean> { return false; }
  startDiscovery(): RunSummary { return this.summary("discover-fake", "running"); }

  private summary(runId: string, status: RunSummary["status"]): RunSummary {
    return {
      runId,
      kind: "replay",
      status,
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
    };
  }
}

let server: ConsoleServer;
let host: FakeInvokeHost;
let capabilitiesDir: string;

beforeAll(() => {
  capabilitiesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-api-"));
  fs.copyFileSync(balanceArtifact, path.join(capabilitiesDir, "member-savings-balance.v1.json"));
  fs.copyFileSync(discoveredArtifact, path.join(capabilitiesDir, "member-savings-balance.discovered.v1.json"));
});

afterAll(() => {
  fs.rmSync(capabilitiesDir, { recursive: true, force: true });
});

beforeEach(async () => {
  host = new FakeInvokeHost();
  server = await startConsoleServer({
    port: 0,
    capabilitiesDir,
    host: host as unknown as RunHost,
  });
});

afterEach(async () => {
  await server.close();
});

const url = (suffix: string): string => `${server.url}${suffix}`;

async function invoke(name: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(url(`/api/catalog/${name}/invoke`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

describe("the agent-facing catalog", () => {
  it("lists capabilities with their typed input and output contracts", async () => {
    const listing = await fetch(url("/api/catalog")).then((r) => r.json());
    const names = listing.map((item: { name: string }) => item.name);
    expect(names).toContain("member.savings_balance.lookup");
    const lookup = listing.find((item: { name: string }) => item.name === "member.savings_balance.lookup");
    expect(lookup.inputs[0]).toMatchObject({ name: "memberId", type: "string", required: true });
    expect(lookup.outputs.map((output: { name: string }) => output.name)).toContain("savingsBalance");
  });

  it("serves tool schemas without draft capabilities, under API-safe names", async () => {
    const tools = await fetch(url("/api/catalog/tools")).then((r) => r.json());
    const names = tools.map((tool: { name: string }) => tool.name);
    // Anthropic tool names cannot contain dots, so the dotted capability name is mapped.
    expect(names).toContain("member__savings_balance__lookup");
    expect(names.join(",")).not.toContain("discovered");
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    const tool = tools.find((entry: { name: string }) => entry.name === "member__savings_balance__lookup");
    expect(tool.input_schema.required).toContain("memberId");
  });
});

describe("invoking a capability by name", () => {
  it("404s for a name that is not in the catalog", async () => {
    const { status } = await invoke("no.such.capability", { inputs: {} });
    expect(status).toBe(404);
    expect(host.started).toHaveLength(0);
  });

  it("refuses to invoke a draft capability", async () => {
    const { status, json } = await invoke("member.savings_balance.discovered", { inputs: {} });
    expect(status).toBe(403);
    expect(json.error).toMatch(/draft/);
    expect(host.started).toHaveLength(0);
  });

  it("runs the replay and returns its structured result with the run id", async () => {
    host.nextResult = {
      status: "success",
      runId: "replay-fake",
      capability: { id: "cap_member_savings_balance", version: "1.0.0" },
      outputs: { savingsBalance: 1250.75 },
      stepsExecuted: 9,
      durationMs: 4200,
      evidenceDir: "evidence/runs/replay-fake",
    };
    const { status, json } = await invoke("member.savings_balance.lookup", {
      inputs: { memberId: "10001" },
      tenant: "beta",
    });
    expect(status).toBe(200);
    expect(json.runId).toBe("replay-fake");
    expect(json.result.status).toBe("success");
    expect(json.result.outputs.savingsBalance).toBe(1250.75);
    expect(host.started[0]).toMatchObject({ inputs: { memberId: "10001" }, tenant: "beta" });
  });

  it("reports an infrastructure failure as the API's own error, not a replay verdict", async () => {
    host.nextError = "browser died";
    const { status, json } = await invoke("member.savings_balance.lookup", { inputs: {} });
    expect(status).toBe(502);
    expect(json.error).toMatch(/browser died/);
  });
});
