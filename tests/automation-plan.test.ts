import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startConsoleServer, type ConsoleServer } from "../src/console/console-server.js";
import type { RunEvent } from "../src/evidence/logger.js";
import { InterventionStateError } from "../src/escalation/intervention-store.js";
import type { RunHost, RunSummary } from "../src/console/run-host.js";

// The automation surface: target presets, the plan decision, draft blocking, promotion, and
// the intervention proxy. A FakeHost keeps browsers and models out of the contract tests.
const CONSOLE_PORT = 0;
const repoCapability = (file: string): string => path.join(process.cwd(), "capabilities", file);

class FakeHost {
  readonly started: any[] = [];
  summaries = new Map<string, RunSummary>();
  interventionList: any[] = [];
  resolved: { runId: string; interventionId: string; decision: string }[] = [];

  seed(runId: string, overrides: Partial<RunSummary> = {}): RunSummary {
    const summary: RunSummary = {
      runId,
      kind: "replay",
      status: "running",
      capabilityName: "meridian.member.balance",
      capabilityPath: repoCapability("meridian.member.balance.v1.json"),
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

  list(): RunSummary[] { return [...this.summaries.values()]; }
  get(runId: string): RunSummary | undefined { return this.summaries.get(runId); }
  events(): RunEvent[] { return []; }
  subscribe(): () => void { return () => undefined; }
  async frame(): Promise<Buffer | null> { return null; }
  async stop(): Promise<boolean> { return true; }
  startReplay(request: unknown): RunSummary { this.started.push(request); return this.seed("replay-fake"); }
  startDiscovery(request: unknown): RunSummary {
    this.started.push(request);
    return this.seed("discover-fake", { kind: "discovery", goal: "g", entryUrl: "http://127.0.0.1:1/x" });
  }
  interventions(): any[] { return this.interventionList; }
  resolveIntervention(runId: string, interventionId: string, resolution: { decision: string }): any {
    const found = this.interventionList.find((entry) => entry.id === interventionId);
    if (!found) throw new Error(`Intervention ${interventionId} was not found on run ${runId}`);
    if (found.status === "resolved") throw new InterventionStateError(`Intervention ${interventionId} is already resolved`);
    this.resolved.push({ runId, interventionId, decision: resolution.decision });
    return { ...found, status: resolution.decision === "abort" ? "aborted" : "resolved" };
  }
}

let server: ConsoleServer;
let host: FakeHost;
let capabilitiesDir: string;
let savedKey: string | undefined;
let savedToken: string | undefined;

beforeEach(async () => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  capabilitiesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-plan-"));
  for (const file of [
    "meridian.member.balance.v1.json",
    "meridian.account.hold.v1.json",
    "member-savings-balance.discovered.v1.json",
  ]) {
    fs.copyFileSync(repoCapability(file), path.join(capabilitiesDir, file));
  }
  host = new FakeHost();
  server = await startConsoleServer({
    port: CONSOLE_PORT,
    capabilitiesDir,
    host: host as unknown as RunHost,
  });
});

afterEach(async () => {
  await server.close();
  fs.rmSync(capabilitiesDir, { recursive: true, force: true });
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

describe("target presets", () => {
  it("lists configured targets with automation counts computed from the catalog", async () => {
    const targets = await fetch(url("/api/targets")).then((r) => r.json());
    expect(targets.length).toBeGreaterThanOrEqual(10);
    const meridian = targets.find((target: any) => target.id === "meridian");
    expect(meridian.approvedCount).toBe(2);
    expect(meridian.automationStatus).toBe("available");
    const local = targets.find((target: any) => target.id === "local-app");
    expect(local.approvedCount).toBe(0);
    expect(local.draftCount).toBe(1);
    expect(local.automationStatus).toBe("draft_only");
    const claims = targets.find((target: any) => target.id === "claimsdesk");
    expect(claims.automationStatus).toBe("not_discovered");
  });
});

describe("planning an automation", () => {
  it("selects an approved automation for a known task and forecasts access and risk", async () => {
    const { status, json } = await post("/api/automation/plan", {
      mode: "automatic",
      targetId: "meridian",
      goal: "Put a fraud hold on member 100987",
    });
    expect(status).toBe(200);
    expect(json.decision.kind).toBe("replay");
    expect(json.decision.capability.name).toBe("meridian.account.hold");
    expect(json.decision.notes.permission).toMatch(/human help/i);
    expect(json.decision.notes.approval).toMatch(/approval/i);
    expect(json.target.id).toBe("meridian");
  });

  it("plans discovery when no approved automation covers the task", async () => {
    const { json } = await post("/api/automation/plan", {
      mode: "automatic",
      targetId: "meridian",
      goal: "Read the reconciliation review setting",
    });
    expect(json.decision.kind).toBe("discovery");
    expect(json.decision.entryUrl).toBe("https://web-sample.interface-hiring.com/signon");
    expect(json.decision.secretNames).toEqual(["MERIDIAN_OPERATOR", "MERIDIAN_PASSWORD"]);
  });

  it("offers an existing similar draft instead of rediscovering the same task", async () => {
    const { json } = await post("/api/automation/plan", {
      mode: "automatic",
      targetId: "local-app",
      goal: "Look up a member's savings balance",
    });
    expect(json.decision.kind).toBe("draft_exists");
    expect(json.decision.draft.name).toBe("member.savings_balance.discovered");
  });

  it("reports no automation in Replay Only mode instead of starting discovery", async () => {
    const { json } = await post("/api/automation/plan", {
      mode: "replay_only",
      targetId: "meridian",
      goal: "Read the reconciliation review setting",
    });
    expect(json.decision.kind).toBe("no_automation");
    expect(json.decision.discoveryPossible).toBe(true);
  });

  it("always explores in Discover Only mode, even when a match exists", async () => {
    const { json } = await post("/api/automation/plan", {
      mode: "discover_only",
      targetId: "meridian",
      goal: "Check member 100987's balance",
    });
    expect(json.decision.kind).toBe("discovery");
  });

  it("scopes an unknown entry URL to a custom single-origin target", async () => {
    const { json } = await post("/api/automation/plan", {
      mode: "automatic",
      entryUrl: "https://legacy.example.com/login",
      goal: "Read the reconciliation review setting",
    });
    expect(json.target.id).toBe("custom");
    expect(json.target.origin).toBe("https://legacy.example.com");
    expect(json.decision.kind).toBe("discovery");
    expect(json.decision.entryUrl).toBe("https://legacy.example.com/login");
  });

  it("rejects a plan without a goal, with an unknown target, or with a cross-target entry URL", async () => {
    expect((await post("/api/automation/plan", { mode: "automatic", targetId: "meridian" })).status).toBe(400);
    expect((await post("/api/automation/plan", { mode: "automatic", targetId: "nope", goal: "g" })).status).toBe(400);
    expect((await post("/api/automation/plan", {
      mode: "automatic",
      targetId: "meridian",
      entryUrl: "https://legacy.example.com/login",
      goal: "g",
    })).status).toBe(400);
  });
});

describe("draft lifecycle", () => {
  it("refuses to replay a draft through the runs API", async () => {
    const { status, json } = await post("/api/runs", {
      kind: "replay",
      capabilityPath: "member-savings-balance.discovered.v1.json",
    });
    expect(status).toBe(403);
    expect(json.error).toMatch(/draft/i);
    expect(host.started).toHaveLength(0);
  });

  it("promotes a draft to approved exactly once, flipping only the approval field", async () => {
    const before = JSON.parse(fs.readFileSync(path.join(capabilitiesDir, "member-savings-balance.discovered.v1.json"), "utf8"));
    const { status, json } = await post("/api/capabilities/member.savings_balance.discovered/approve");
    expect(status).toBe(200);
    expect(json.approval).toBe("approved");
    const after = JSON.parse(fs.readFileSync(path.join(capabilitiesDir, "member-savings-balance.discovered.v1.json"), "utf8"));
    expect(after.approval).toBe("approved");
    expect({ ...after, approval: before.approval }).toEqual(before);
    // A second promotion has nothing to do.
    expect((await post("/api/capabilities/member.savings_balance.discovered/approve")).status).toBe(409);
    // And the approved draft is now replayable.
    const run = await post("/api/runs", { kind: "replay", capabilityPath: "member-savings-balance.discovered.v1.json" });
    expect(run.status).toBe(201);
  });

  it("serves the full artifact for review and 404s on unknown names", async () => {
    const response = await fetch(url("/api/capabilities/member.savings_balance.discovered")).then((r) => r.json());
    expect(response.capability.steps.length).toBeGreaterThan(0);
    expect(response.listing.approval).toBe("draft");
    expect((await fetch(url("/api/capabilities/does.not.exist"))).status).toBe(404);
  });
});

describe("target detection endpoint", () => {
  it("resolves a configured origin to its preset and an unknown one to a custom target", async () => {
    const meridian = await fetch(url("/api/targets/detect?url=https%3A%2F%2Fweb-sample.interface-hiring.com%2Fsignon")).then((r) => r.json());
    expect(meridian.id).toBe("meridian");
    expect(meridian.custom).toBe(false);
    const custom = await fetch(url("/api/targets/detect?url=https%3A%2F%2Flegacy.example.com%2Flogin")).then((r) => r.json());
    expect(custom.custom).toBe(true);
    expect(custom.origin).toBe("https://legacy.example.com");
    // Custom-target discovery credentials come from configuration, not code.
    expect(custom.discoverySecretNames).toEqual(["APP_USER", "APP_PASSWORD"]);
    expect((await fetch(url("/api/targets/detect?url=not-a-url"))).status).toBe(400);
    expect((await fetch(url("/api/targets/detect"))).status).toBe(400);
  });
});

describe("target boundary on runs", () => {
  it("resolves a bare entry URL to its preset, exactly like planning does", async () => {
    // The drift this pins down: the plan endpoint resolved a Meridian URL to the meridian
    // preset (with its credential names) while the run-start path once did not.
    const { status } = await post("/api/runs", {
      kind: "discovery",
      goal: "Read the reconciliation review setting",
      entryUrl: "https://web-sample.interface-hiring.com/signon",
    });
    expect(status).toBe(201);
    expect(host.started[0]).toMatchObject({
      entryUrl: "https://web-sample.interface-hiring.com/signon",
      secretNames: ["MERIDIAN_OPERATOR", "MERIDIAN_PASSWORD"],
    });
  });

  it("applies a credential profile as an explicit pre-run choice, names only", async () => {
    const { status } = await post("/api/runs", {
      kind: "replay",
      capabilityPath: "meridian.account.hold.v1.json",
      targetId: "meridian",
      credentialProfileId: "teller",
    });
    expect(status).toBe(201);
    expect(host.started[0].capability.secretsRequired).toEqual(["MERIDIAN_OPERATOR", "MERIDIAN_PASSWORD"]);
    expect(host.started[0].credentialProfile).toBe("Teller (teller1)");
  });

  it("rejects a replay whose capability is not on the selected target", async () => {
    const { status, json } = await post("/api/runs", {
      kind: "replay",
      capabilityPath: "meridian.account.hold.v1.json",
      targetId: "local-app",
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/selected target/i);
    expect(host.started).toHaveLength(0);
  });

  it("rejects a credential profile without a target and an unknown profile", async () => {
    expect((await post("/api/runs", {
      kind: "replay",
      capabilityPath: "meridian.account.hold.v1.json",
      credentialProfileId: "teller",
    })).status).toBe(400);
    expect((await post("/api/runs", {
      kind: "replay",
      capabilityPath: "meridian.account.hold.v1.json",
      targetId: "meridian",
      credentialProfileId: "root",
    })).status).toBe(400);
  });

  it("derives discovery entry URL and secrets from the selected target", async () => {
    const { status } = await post("/api/runs", {
      kind: "discovery",
      targetId: "meridian",
      goal: "Read the reconciliation review setting",
    });
    expect(status).toBe(201);
    expect(host.started[0]).toMatchObject({
      entryUrl: "https://web-sample.interface-hiring.com/signon",
      secretNames: ["MERIDIAN_OPERATOR", "MERIDIAN_PASSWORD"],
    });
  });

  it("refuses discovery whose entry URL leaves the selected target", async () => {
    const { status, json } = await post("/api/runs", {
      kind: "discovery",
      targetId: "meridian",
      goal: "g",
      entryUrl: "https://legacy.example.com/login",
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/outside the selected target/i);
    expect(host.started).toHaveLength(0);
  });
});

describe("intervention proxy", () => {
  it("lists a live run's interventions and resolves approve/abort", async () => {
    host.seed("replay-1");
    host.interventionList = [{ id: "iv_1", status: "open", reason: { code: "RISKY_ACTION_APPROVAL", detail: "r" } }];
    const listed = await fetch(url("/api/runs/replay-1/interventions")).then((r) => r.json());
    expect(listed).toHaveLength(1);
    const { status, json } = await post("/api/runs/replay-1/interventions/iv_1/resolve", { decision: "approve" });
    expect(status).toBe(200);
    expect(json.status).toBe("resolved");
    expect(host.resolved).toEqual([{ runId: "replay-1", interventionId: "iv_1", decision: "approve" }]);
  });

  it("accepts only approve and abort from the console", async () => {
    host.seed("replay-1");
    host.interventionList = [{ id: "iv_1", status: "open" }];
    expect((await post("/api/runs/replay-1/interventions/iv_1/resolve", { decision: "resume" })).status).toBe(400);
  });

  it("404s unknown runs and interventions, 409s an already-resolved one", async () => {
    expect((await fetch(url("/api/runs/missing/interventions"))).status).toBe(404);
    expect((await post("/api/runs/missing/interventions/iv_1/resolve", { decision: "abort" })).status).toBe(404);
    host.seed("replay-1");
    host.interventionList = [{ id: "iv_done", status: "resolved" }];
    expect((await post("/api/runs/replay-1/interventions/iv_missing/resolve", { decision: "abort" })).status).toBe(404);
    expect((await post("/api/runs/replay-1/interventions/iv_done/resolve", { decision: "abort" })).status).toBe(409);
  });
});
