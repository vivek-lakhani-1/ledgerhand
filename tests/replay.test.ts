import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "../target-app/server.js";
import { EvidenceDir } from "../src/evidence/evidence.js";
import { RunLogger } from "../src/evidence/logger.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { Redactor } from "../src/policy/redact.js";
import { BrowserSession } from "../src/session/session.js";
import { Capability, type ReplayResult } from "../src/schema/index.js";
import type { Surface } from "../src/surface/types.js";
import { WebSurface } from "../src/surface/web/web-surface.js";
import { replay } from "../src/replay/executor.js";

const TEST_PORT = 4649;
const ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
const APP_USER = "OPER01";
const APP_PASSWORD = "demo-pass-01";

let server: Server;
const balanceFixturePath = path.join(process.cwd(), "capabilities", "member-savings-balance.v1.json");
const subaccountFixturePath = path.join(process.cwd(), "capabilities", "subaccount-open.v1.json");

beforeAll(async () => {
  process.env.APP_USER = APP_USER;
  process.env.APP_PASSWORD = APP_PASSWORD;
  server = startServer(TEST_PORT);
  await waitForHealth();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(async () => {
  await resetInjection();
});

describe("deterministic replay against the live target app", () => {
  it("1. happy path returns typed success outputs", async () => {
    const run = await runCapability(balanceCapability());

    expect(run.result.status).toBe("success");
    if (run.result.status !== "success") return;
    expect(run.result.outputs.savingsBalance).toBe(1250.75);
    expect(run.result.outputs.memberName).toBe("Ada Exampleton");
    expect(run.result.stepsExecuted).toBe(6);
  });

  it("2. not_found is a terminal business outcome, not a failure", async () => {
    await inject("not_found");
    const run = await runCapability(balanceCapability());

    expect(run.result.status).toBe("business_outcome");
    if (run.result.status !== "business_outcome") return;
    expect(run.result.code).toBe("MEMBER_NOT_FOUND");
    expect(run.result).toHaveProperty("outputs");
    expect(run.result).not.toHaveProperty("error");
  });

  it("3. restricted member is a PERMISSION_DENIED business outcome", async () => {
    const run = await runCapability(balanceCapability(), { memberId: "10009" });

    expect(run.result.status).toBe("business_outcome");
    if (run.result.status !== "business_outcome") return;
    expect(run.result.code).toBe("PERMISSION_DENIED");
    expect(run.result.atStepId).toBe("s5");
  });

  it("4. validation injection is a VALIDATION_ERROR business outcome", async () => {
    await inject("validation");
    const run = await runCapability(subaccountCapability());

    expect(run.result.status).toBe("business_outcome");
    if (run.result.status !== "business_outcome") return;
    expect(run.result.code).toBe("VALIDATION_ERROR");
    expect(run.result.outputs.validationMessage).toContain("Initial deposit must be at least");
  });

  it("5. slow content is absorbed by condition waits without retry leakage", async () => {
    await inject("slow");
    const run = await runCapability(balanceCapability());

    expect(run.result.status).toBe("success");
    expect(run.events.filter((event) => event.type === "retry")).toHaveLength(0);
  });

  it("6. interstitial is dismissed by the capability recovery", async () => {
    await inject("interstitial");
    const run = await runCapability(balanceCapability());

    expect(run.result.status).toBe("success");
    expect(run.events).toContainEqual(expect.objectContaining({ type: "recovery.applied", recoveryId: "dismiss_interstitial" }));
  });

  it("7. session expiry is repaired by reauthentication", async () => {
    await inject("session_expired");
    const run = await runCapability(balanceCapability());

    expect(run.result.status).toBe("success");
    expect(run.events).toContainEqual(expect.objectContaining({ type: "recovery.applied", recoveryId: "reauthenticate" }));
  });

  it("8. application error is a SURFACE_ERROR with the target reference", async () => {
    await inject("app_error");
    const run = await runCapability(balanceCapability());

    expect(run.result.status).toBe("failed");
    if (run.result.status !== "failed") return;
    expect(run.result.error.class).toBe("SURFACE_ERROR");
    expect(run.result.error.observed).toContain("REF 0x5A2");
  });

  it("9. invalid input fails before any browser surface call", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-replay-input-"));
    const redactor = new Redactor({ secrets: [], piiValues: [] });
    const logger = new RunLogger(`input-${Date.now()}`, redactor, root);
    const evidence = new EvidenceDir(logger.runId, redactor, root);
    let touched = false;
    const surface = new Proxy({} as Surface, {
      get: () => {
        touched = true;
        return async () => {
          throw new Error("surface should not be touched for invalid input");
        };
      },
    });
    const result = await replay(balanceCapability(), {
      inputs: { memberId: "" },
      surface,
      logger,
      evidence,
      policy: policyFor(balanceCapability()),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.class).toBe("INPUT_INVALID");
    expect(touched).toBe(false);
  });

  it("10. an off-allowlist entry URL is blocked before navigation", async () => {
    const cap = balanceCapability();
    cap.target.entryUrl = "http://off-allowlist.invalid/t/alpha/msc/login";
    const run = await runCapability(cap);

    expect(run.result.status).toBe("failed");
    if (run.result.status !== "failed") return;
    expect(run.result.error.class).toBe("POLICY_BLOCKED");
  });

  it("11. irreversible Confirm requires approval and escalates without an escalator", async () => {
    const run = await runCapability(subaccountCapability());

    expect(run.result.status).toBe("escalated");
    if (run.result.status !== "escalated") return;
    expect(run.result.reason).toBe("RISKY_ACTION_APPROVAL");
    expect(run.result.atStepId).toBe("s9");
  });

  it("12. three happy-path runs are deterministic in outputs and step order", async () => {
    const runs = await Promise.all([
      runCapability(balanceCapability()),
      runCapability(balanceCapability()),
      runCapability(balanceCapability()),
    ]);
    const successful = runs.map((run) => {
      expect(run.result.status).toBe("success");
      if (run.result.status !== "success") throw new Error("expected success");
      return {
        outputs: run.result.outputs,
        steps: run.events.filter((event) => event.type === "step.start").map((event) => event.stepId),
      };
    });

    expect(successful[1]).toEqual(successful[0]);
    expect(successful[2]).toEqual(successful[0]);
  });
});

type LoggedEvent = { type: string; [key: string]: unknown };
type RunHarness = { result: ReplayResult; events: LoggedEvent[] };

async function runCapability(cap: ReturnType<typeof balanceCapability>, inputs?: { memberId: string }): Promise<RunHarness>;
async function runCapability(cap: ReturnType<typeof subaccountCapability>, inputs?: { memberId: string }): Promise<RunHarness>;
async function runCapability(cap: ReturnType<typeof balanceCapability> | ReturnType<typeof subaccountCapability>, inputs = { memberId: "10001" }): Promise<RunHarness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-replay-"));
  const redactor = new Redactor({ secrets: [], piiValues: [] });
  const runId = `replay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const logger = new RunLogger(runId, redactor, root);
  const evidence = new EvidenceDir(runId, redactor, root);
  const policy = policyFor(cap);
  const session = await BrowserSession.launch({
    headless: true,
    viewport: cap.target.viewport,
    sessionId: `session-${runId}`,
  });
  const surface = new WebSurface({ session, policy, logger, caller: "automation" });
  let result: ReplayResult;
  try {
    result = await replay(cap, { inputs, surface, logger, evidence, policy });
  } finally {
    await session.close();
  }
  const events = fs.readFileSync(logger.logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedEvent);
  return { result, events };
}

function balanceCapability() {
  return portCapability(balanceFixturePath);
}

function subaccountCapability() {
  return portCapability(subaccountFixturePath);
}

function portCapability(filePath: string) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  const replaced = replaceStrings(raw, (value) => value.replaceAll("http://127.0.0.1:4599", ORIGIN));
  return Capability.parse(replaced);
}

function replaceStrings<T>(value: T, transform: (value: string) => string): T {
  if (typeof value === "string") return transform(value) as T;
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, transform)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, transform)])) as T;
  }
  return value;
}

function policyFor(cap: ReturnType<typeof balanceCapability> | ReturnType<typeof subaccountCapability>): PolicyEngine {
  return new PolicyEngine(cap.policy);
}

async function inject(mode: string): Promise<void> {
  const response = await fetch(`${ORIGIN}/_inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`Injection failed: ${response.status}`);
}

async function resetInjection(): Promise<void> {
  const response = await fetch(`${ORIGIN}/_reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!response.ok) throw new Error(`Reset failed: ${response.status}`);
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/_health`);
      if (response.ok) return;
    } catch {
      // The dedicated target port may still be binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Target app did not become healthy");
}
