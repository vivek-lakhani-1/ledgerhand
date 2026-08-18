import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveForTenant } from "../src/catalog/tenant.js";
import { EvidenceDir } from "../src/evidence/evidence.js";
import { RunLogger } from "../src/evidence/logger.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { Redactor } from "../src/policy/redact.js";
import { replay } from "../src/replay/executor.js";
import { BrowserSession } from "../src/session/session.js";
import { Capability, type Capability as CapabilityValue, type ReplayResult } from "../src/schema/index.js";
import { lintCapability } from "../src/schema/lint.js";
import { WebSurface } from "../src/surface/web/web-surface.js";
import { startServer } from "../target-app/server.js";

const TARGET_PORT = 4664;
const ORIGIN = `http://127.0.0.1:${TARGET_PORT}`;
const sourceFile = path.join(process.cwd(), "capabilities", "member-savings-balance.v1.json");

let targetServer: Server;

beforeAll(async () => {
  process.env.APP_USER = "OPER01";
  process.env.APP_PASSWORD = "demo-pass-01";
  targetServer = startServer(TARGET_PORT);
  await waitForHealth();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => targetServer.close((error) => error ? reject(error) : resolve()));
});

describe("cross-tenant capability reuse and drift evidence", () => {
  it("resolves beta deltas into a parse- and lint-clean capability", () => {
    const base = capability();
    const beta = resolveForTenant(base, "beta");

    expect(Capability.parse(beta)).toEqual(beta);
    expect(lintCapability(beta)).toEqual([]);
    expect(beta.target.entryUrl).toContain("/t/beta/msc/login");
    expect(beta.steps.find((step) => step.id === "s4")?.action).toMatchObject({
      type: "type",
      target: { labelText: "Account Number:" },
    });
    expect(beta.steps.find((step) => step.id === "s5")?.action).toMatchObject({
      type: "click",
      target: { name: "Search" },
    });
    expect(JSON.stringify(beta.steps.find((step) => step.id === "s5"))).toContain("Balance (USD)");
  });

  it("replays the same base artifact for alpha and beta with the same savingsBalance", async () => {
    const base = capability();
    const alpha = await run(base);
    const beta = await run(base, "beta");

    expect(alpha.result.status).toBe("success");
    expect(beta.result.status).toBe("success");
    if (alpha.result.status !== "success" || beta.result.status !== "success") return;
    expect(alpha.result.outputs.savingsBalance).toBe(1250.75);
    expect(beta.result.outputs.savingsBalance).toBe(alpha.result.outputs.savingsBalance);
  });

  it("writes a proposed override for a beta drift and never auto-applies it", async () => {
    const drifted = capability();
    drifted.target.entryUrl = `${ORIGIN}/t/beta/msc/login`;
    drifted.tenantOverrides = {};
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-drift-"));
    const result = await runWithRoot(drifted, "beta", root);
    expect(result.result.status).toBe("failed");
    if (result.result.status !== "failed") return;
    expect(result.result.error.class).toBe("TARGET_NOT_FOUND");

    const proposalPath = path.join(result.evidenceDir, "proposed-override.json");
    expect(fs.existsSync(proposalPath)).toBe(true);
    const proposal = JSON.parse(fs.readFileSync(proposalPath, "utf8")) as Record<string, unknown>;
    expect(proposal).toMatchObject({ tenant: "beta", stepId: "s4" });
    expect(proposal).toHaveProperty("currentTarget");
    expect(proposal).toHaveProperty("proposedTarget");
    expect(drifted.tenantOverrides).toEqual({});
    expect(JSON.stringify(result.events)).toContain("drift.proposed");
    expect(result.events).toContainEqual(expect.objectContaining({ type: "drift.summary" }));
  });
});

function capability(): CapabilityValue {
  const raw = JSON.parse(fs.readFileSync(sourceFile, "utf8")) as unknown;
  return Capability.parse(replaceStrings(raw, (value) => value.replaceAll("http://127.0.0.1:4599", ORIGIN)));
}

async function run(cap: CapabilityValue, tenant?: string): Promise<RunHarness> {
  return runWithRoot(cap, tenant, fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-tenant-")));
}

async function runWithRoot(cap: CapabilityValue, tenant: string | undefined, root: string): Promise<RunHarness> {
  const redactor = new Redactor({ secrets: [], piiValues: [] });
  const runId = `tenant-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const logger = new RunLogger(runId, redactor, root);
  const evidence = new EvidenceDir(runId, redactor, root);
  const policy = new PolicyEngine(cap.policy);
  const session = await BrowserSession.launch({ headless: true, viewport: cap.target.viewport, sessionId: `session-${runId}` });
  const surface = new WebSurface({ session, policy, logger, caller: "automation" });
  let result: ReplayResult;
  try {
    result = await replay(cap, { inputs: { memberId: "10001" }, tenant, surface, logger, evidence, policy });
  } finally {
    await session.close();
  }
  const events = readEvents(logger.logPath);
  return { result, evidenceDir: result.evidenceDir, events };
}

type RunHarness = { result: ReplayResult; evidenceDir: string; events: Array<Record<string, unknown>> };

function readEvents(logPath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function replaceStrings<T>(value: T, transform: (value: string) => string): T {
  if (typeof value === "string") return transform(value) as T;
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, transform)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, transform)])) as T;
  return value;
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${ORIGIN}/_health`)).ok) return;
    } catch {
      // The dedicated test server may still be binding.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Target app did not become healthy");
}
