import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../target-app/server.js";
import { EvidenceDir } from "../src/evidence/evidence.js";
import { RunLogger } from "../src/evidence/logger.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { Redactor } from "../src/policy/redact.js";
import { BrowserSession } from "../src/session/session.js";
import { registerInterventionSession, registerSession, unregisterSession, startOperatorServer, type OperatorServer } from "../src/escalation/operator-server.js";
import { InterventionStore } from "../src/escalation/intervention-store.js";
import { makeOperatorEscalator } from "../src/escalation/escalator.js";
import { Capability, type Action, type ReplayResult } from "../src/schema/index.js";
import type { Surface } from "../src/surface/types.js";
import { WebSurface } from "../src/surface/web/web-surface.js";
import { replay } from "../src/replay/executor.js";

const TARGET_PORT = 4651;
const OPERATOR_PORT = 4652;
const ORIGIN = `http://127.0.0.1:${TARGET_PORT}`;
const APP_USER = "OPER01";
const APP_PASSWORD = "demo-pass-01";
const subaccountPath = path.join(process.cwd(), "capabilities", "subaccount-open.v1.json");

let targetServer: Server;

beforeAll(async () => {
  process.env.APP_USER = APP_USER;
  process.env.APP_PASSWORD = APP_PASSWORD;
  targetServer = startServer(TARGET_PORT);
  await waitForCondition(async () => (await fetch(`${ORIGIN}/_health`)).ok, 5000);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => targetServer.close((error) => error ? reject(error) : resolve()));
});

describe("live control transfer and resume", () => {
  it("1. raises a populated intervention with evidence paths and context", async () => {
    const harness = await makeHarness({ earlyApproval: true });
    try {
      const runPromise = runWithEscalator(harness);
      const intervention = await waitForIntervention(harness.operator);
      expect(intervention.reason.code).toBe("RISKY_ACTION_APPROVAL");
      expect(intervention.atStepId).toBe("s1");
      expect(intervention.expected).toContain("type");
      expect(intervention.observed).toContain("human approval");
      expect(intervention.context.url).toContain("/msc/login");
      expect(intervention.context.title).toContain("Operator");
      expect(fs.existsSync(intervention.context.screenshotPath)).toBe(true);
      expect(fs.existsSync(intervention.context.snapshotPath)).toBe(true);
      expect(intervention.runId).toBe(harness.runId);
      await resolve(harness.operator, intervention.id, "abort");
      const result = await runPromise;
      expect(result.status).toBe("failed");
    } finally {
      await dispose(harness);
    }
  });

  it("2. claiming transfers control and automation receives CONTROL_LOST", async () => {
    const harness = await makeHarness({ earlyApproval: true });
    try {
      const runPromise = runWithEscalator(harness);
      const intervention = await waitForIntervention(harness.operator);
      await post(harness.operator, `/api/interventions/${intervention.id}/claim`);
      await expect(harness.surface.act({ type: "navigate", url: `${ORIGIN}/t/alpha/msc/login` }, { risk: "safe", mode: "replay" }))
        .rejects.toMatchObject({ errorClass: "CONTROL_LOST" });
      await resolve(harness.operator, intervention.id, "abort");
      await runPromise;
    } finally {
      await dispose(harness);
    }
  });

  it("3. forwards type input to the same live page and records humanActions", async () => {
    const harness = await makeHarness();
    try {
      await login(harness.session);
      await harness.session.page.goto(`${ORIGIN}/t/alpha/msc/subaccount/new?member=10001`, { waitUntil: "domcontentloaded" });
      await harness.session.page.locator('input[name="f2"]').focus();
      const intervention = await createManualIntervention(harness);
      await post(harness.operator, `/api/interventions/${intervention.id}/claim`);
      const input = await post(harness.operator, `/api/session/${harness.session.sessionId}/input`, {
        kind: "type",
        text: "37",
      });
      expect(input.response.ok).toBe(true);
      expect(await harness.session.page.locator('input[name="f2"]').inputValue()).toBe("37");
      const detail = await json(harness.operator, `/api/interventions/${intervention.id}`);
      expect(detail.humanActions).toEqual([expect.objectContaining({ kind: "type", text: "37" })]);
      await resolve(harness.operator, intervention.id, "abort");
    } finally {
      await dispose(harness);
    }
  });

  it("4. denies a human navigate outside the policy allowlist", async () => {
    const harness = await makeHarness();
    try {
      await login(harness.session);
      const intervention = await createManualIntervention(harness);
      await post(harness.operator, `/api/interventions/${intervention.id}/claim`);
      const before = harness.session.page.url();
      const response = await post(harness.operator, `/api/session/${harness.session.sessionId}/input`, {
        kind: "navigate",
        url: "https://off-allowlist.example/escape",
      });
      expect(response.response.status).toBe(403);
      expect(response.body.error).toBe("POLICY_BLOCKED");
      expect(harness.session.page.url()).toBe(before);
      await resolve(harness.operator, intervention.id, "abort");
    } finally {
      await dispose(harness);
    }
  });

  it("5. rejects input when the human does not hold control", async () => {
    const harness = await makeHarness();
    try {
      await login(harness.session);
      const intervention = await createManualIntervention(harness);
      const response = await post(harness.operator, `/api/session/${harness.session.sessionId}/input`, {
        kind: "type",
        text: "should-not-arrive",
      });
      expect(response.response.status).toBe(409);
      expect(response.body.error).toBe("CONTROL_LOST");
      await resolve(harness.operator, intervention.id, "abort");
    } finally {
      await dispose(harness);
    }
  });

  it("6. resolving resume returns control to automation and the run continues", async () => {
    const harness = await makeHarness({ createdSuccess: true, compactFlow: true });
    try {
      const runPromise = runWithEscalator(harness);
      const intervention = await waitForIntervention(harness.operator);
      await post(harness.operator, `/api/interventions/${intervention.id}/claim`);
      await resolve(harness.operator, intervention.id, "resume");
      const result = await runPromise;
      expect(result.status).toBe("success");
      expect(harness.session.control.holder).toBe("automation");
    } finally {
      await dispose(harness);
    }
  });

  it("7. a human-completed step is detected and advanced without re-running it", async () => {
    const harness = await makeHarness({ safeConfirm: true, createdSuccess: true, compactFlow: true });
    try {
      let failed = false;
      const surface = failFirstConfirm(harness.surface, () => { failed = true; });
      const runPromise = replay(harness.capability, {
        inputs: { memberId: "10001" },
        surface,
        logger: harness.logger,
        evidence: harness.evidence,
        policy: harness.policy,
        escalate: harness.escalator,
      });
      const intervention = await waitForIntervention(harness.operator);
      expect(failed).toBe(true);
      await post(harness.operator, `/api/interventions/${intervention.id}/claim`);
      const button = harness.session.page.locator('input[type="submit"]');
      const box = await button.boundingBox();
      if (!box) throw new Error("Confirm button was not visible");
      await post(harness.operator, `/api/session/${harness.session.sessionId}/input`, { kind: "click", x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await resolve(harness.operator, intervention.id, "resume");
      const result = await runPromise;
      expect(result.status).toBe("success");
      const events = readEvents(harness.logger.logPath);
      expect(events).toContainEqual(expect.objectContaining({ type: "human.resolved", resumeBranch: "postcondition_satisfied" }));
      expect(events.filter((event) => event.type === "step.start" && event.stepId === "s9")).toHaveLength(1);
    } finally {
      await dispose(harness);
    }
  });

  it("8. an unchanged page causes the failed step to be re-run once", async () => {
    const harness = await makeHarness({ safeConfirm: true, createdSuccess: true, compactFlow: true });
    try {
      const surface = failFirstConfirm(harness.surface);
      const runPromise = replay(harness.capability, {
        inputs: { memberId: "10001" },
        surface,
        logger: harness.logger,
        evidence: harness.evidence,
        policy: harness.policy,
        escalate: harness.escalator,
      });
      const intervention = await waitForIntervention(harness.operator);
      await post(harness.operator, `/api/interventions/${intervention.id}/claim`);
      await resolve(harness.operator, intervention.id, "resume");
      const result = await runPromise;
      expect(result.status).toBe("success");
      const events = readEvents(harness.logger.logPath);
      expect(events).toContainEqual(expect.objectContaining({ type: "human.resolved", resumeBranch: "preconditions_satisfied_rerun" }));
      expect(events.filter((event) => event.type === "step.start" && event.stepId === "s9")).toHaveLength(2);
    } finally {
      await dispose(harness);
    }
  });

  // The approval gate is only worth anything if BOTH directions hold: an approved risky step
  // actually executes, and a refused one leaves the system untouched. Asserting on the
  // ReplayResult alone would pass even if the sub-account had been created anyway, so these
  // assert against the live page.
  it("9. approving an irreversible step performs it and the run completes", async () => {
    const harness = await makeHarness({ createdSuccess: true, compactFlow: true });
    try {
      const runPromise = runWithEscalator(harness);
      const intervention = await waitForIntervention(harness.operator);
      expect(intervention.reason.code).toBe("RISKY_ACTION_APPROVAL");
      expect(intervention.atStepId).toBe("s9");
      await post(harness.operator, `/api/interventions/${intervention.id}/claim`);
      await resolve(harness.operator, intervention.id, "approve");

      const result = await runPromise;
      expect(result.status).toBe("success");
      expect(await allFrameText(harness.session)).toContain("SUB-ACCOUNT CREATED");
      expect(harness.session.control.holder).toBe("automation");
    } finally {
      await dispose(harness);
    }
  });

  it("9b. time spent waiting on a human decision does not count against the run's wall clock", async () => {
    const harness = await makeHarness();
    // Two fast steps on the login page; the first pauses for approval. The capability's own
    // wall clock (5 s) is shorter than the human's think time (7 s) - the automation budget
    // bounds the automation, not the reviewer.
    harness.capability.steps = harness.capability.steps.filter((step) => ["s1", "s2"].includes(step.id));
    harness.capability.steps[0].risk = "irreversible";
    harness.capability.successCheckpoint = { kind: "url_matches", pattern: "login" };
    harness.capability.policy.timeoutMs = 5000;
    try {
      const runPromise = runWithEscalator(harness);
      const intervention = await waitForIntervention(harness.operator);
      expect(intervention.reason.code).toBe("RISKY_ACTION_APPROVAL");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 7000));
      await resolve(harness.operator, intervention.id, "approve");

      const result = await runPromise;
      // Without human-wait exclusion this fails TIMEOUT before s2 (elapsed > 5000ms).
      expect(result.status).toBe("success");
    } finally {
      await dispose(harness);
    }
  }, 40000);

  it("10. aborting an approval gate leaves the irreversible action unperformed", async () => {
    const harness = await makeHarness({ createdSuccess: true, compactFlow: true });
    try {
      const runPromise = runWithEscalator(harness);
      const intervention = await waitForIntervention(harness.operator);
      expect(intervention.atStepId).toBe("s9");
      await resolve(harness.operator, intervention.id, "abort");

      const result = await runPromise;
      expect(result.status).toBe("failed");
      // The whole point of the gate: no confirmation screen, so no sub-account was opened.
      expect(await allFrameText(harness.session)).not.toContain("SUB-ACCOUNT CREATED");
    } finally {
      await dispose(harness);
    }
  });
});

/** Frameset pages keep their real content in child frames, so page.content() is not enough. */
async function allFrameText(session: BrowserSession): Promise<string> {
  const parts = await Promise.all(
    session.page.frames().map((frame) => frame.content().catch(() => "")),
  );
  return parts.join("\n");
}

type Harness = {
  runId: string;
  capability: ReturnType<typeof subaccountCapability>;
  policy: PolicyEngine;
  logger: RunLogger;
  evidence: EvidenceDir;
  session: BrowserSession;
  surface: WebSurface;
  store: InterventionStore;
  operator: OperatorServer;
  escalator: ReturnType<typeof makeOperatorEscalator>;
};

async function makeHarness(options: { safeConfirm?: boolean; createdSuccess?: boolean; earlyApproval?: boolean; compactFlow?: boolean } = {}): Promise<Harness> {
  const capability = subaccountCapability();
  if (options.safeConfirm) capability.steps.find((step) => step.id === "s9")!.risk = "safe";
  if (options.createdSuccess) capability.successCheckpoint = { kind: "text_present", text: "SUB-ACCOUNT CREATED", match: "contains", framePath: ["content"] };
  if (options.earlyApproval) {
    capability.steps = [capability.steps[0]];
    capability.steps[0].risk = "irreversible";
    capability.steps[0].onFailure = "escalate";
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-escalation-"));
  const redactor = new Redactor({ secrets: [], piiValues: [] });
  const runId = `phase6-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const logger = new RunLogger(runId, redactor, root);
  const evidence = new EvidenceDir(runId, redactor, root);
  const policy = new PolicyEngine(capability.policy);
  const session = await BrowserSession.launch({ headless: true, viewport: capability.target.viewport, sessionId: `session-${runId}` });
  const surface = new WebSurface({ session, policy, logger, caller: "automation" });
  if (options.compactFlow) {
    await login(session);
    capability.target.entryUrl = `${ORIGIN}/t/alpha/msc/subaccount/new?member={{inputs.memberId}}`;
    capability.steps = capability.steps.filter((step) => ["s5", "s6", "s7", "s8", "s9"].includes(step.id));
    rewriteFramePaths(capability);
  }
  const store = new InterventionStore({ redactor, rootDir: root });
  const operator = await startOperatorServer({ store, policy, port: OPERATOR_PORT });
  const escalator = makeOperatorEscalator({ store, session, logger, evidence, operatorUrl: operator.url, timeoutMs: 10000 });
  return { runId, capability, policy, logger, evidence, session, surface, store, operator, escalator };
}

async function runWithEscalator(harness: Harness): Promise<ReplayResult> {
  return replay(harness.capability, {
    inputs: { memberId: "10001" },
    surface: harness.surface,
    logger: harness.logger,
    evidence: harness.evidence,
    policy: harness.policy,
    escalate: harness.escalator,
  });
}

async function createManualIntervention(harness: Harness) {
  registerSession(harness.session.sessionId, harness.session, { policy: harness.policy });
  const screenshotPath = harness.evidence.screenshotPath("manual");
  const snapshotPath = harness.evidence.domPath("manual");
  fs.writeFileSync(screenshotPath, Buffer.from("manual"));
  fs.writeFileSync(snapshotPath, "<html></html>");
  const id = harness.store.create({
    createdAt: new Date().toISOString(),
    status: "open",
    origin: "replay",
    runId: harness.runId,
    capabilityId: harness.capability.id,
    capabilityVersion: harness.capability.version,
    goal: harness.capability.provenance.goal,
    reason: { code: "STUCK", detail: "manual test intervention" },
    atStepId: "manual",
    stepDescription: "Manual test control",
    expected: "operator input",
    observed: "automation paused",
    context: { url: harness.session.page.url(), title: await harness.session.page.title(), screenshotPath, snapshotPath, recentEvents: [] },
    operatorUrl: harness.operator.url,
    humanActions: [],
  });
  registerInterventionSession(id, harness.session.sessionId, harness.logger);
  return harness.store.get(id)!;
}

function failFirstConfirm(surface: WebSurface, onFailure?: () => void): Surface {
  let first = true;
  return {
    kind: surface.kind,
    sessionId: surface.sessionId,
    observe: () => surface.observe(),
    resolve: (target) => surface.resolve(target),
    act: async (action, context) => {
      if (first && action.type === "click" && action.target.description?.includes("Irreversible Confirm")) {
        first = false;
        onFailure?.();
        throw new Error("simulated stuck Confirm step");
      }
      return surface.act(action, context);
    },
    readText: (target) => surface.readText(target),
    readAttribute: (target, attr) => surface.readAttribute(target, attr),
    url: () => surface.url(),
    title: () => surface.title(),
    screenshot: (options) => surface.screenshot(options),
    domSnapshot: () => surface.domSnapshot(),
    lastDocumentStatus: () => surface.lastDocumentStatus(),
    captureDescriptor: (handle) => surface.captureDescriptor(handle),
  };
}

async function login(session: BrowserSession): Promise<void> {
  await session.page.goto(`${ORIGIN}/t/alpha/msc/login`, { waitUntil: "domcontentloaded" });
  await session.page.locator('input[name="u"]').fill(APP_USER);
  await session.page.locator('input[name="p"]').fill(APP_PASSWORD);
  await session.page.locator('input[type="submit"]').click();
  await session.page.waitForURL(`${ORIGIN}/t/alpha/msc/console`);
}

async function waitForIntervention(operator: OperatorServer) {
  return waitForCondition(async () => {
    const response = await fetch(`${operator.url}/api/interventions`, { cache: "no-store" });
    if (!response.ok) return undefined;
    const items = await response.json() as Array<Record<string, any>>;
    return items.find((item) => item.status === "open");
  }, 10000);
}

async function resolve(operator: OperatorServer, id: string, decision: "resume" | "approve" | "abort"): Promise<void> {
  const result = await post(operator, `/api/interventions/${id}/resolve`, { decision });
  expect(result.response.ok).toBe(true);
}

async function post(operator: OperatorServer, route: string, body?: unknown): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${operator.url}${route}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

async function json(operator: OperatorServer, route: string): Promise<any> {
  const response = await fetch(`${operator.url}${route}`, { cache: "no-store" });
  return response.json();
}

async function dispose(harness: Harness): Promise<void> {
  await harness.operator.close().catch(() => undefined);
  unregisterSession(harness.session.sessionId);
  await harness.session.close();
}

async function waitForCondition<T>(condition: () => Promise<T | false | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value !== false && value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition did not become true within ${timeoutMs}ms`);
}

function readEvents(logPath: string): Array<Record<string, any>> {
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
}

function subaccountCapability() {
  const raw = JSON.parse(fs.readFileSync(subaccountPath, "utf8")) as unknown;
  return Capability.parse(replaceStrings(raw, (value) => value.replaceAll("http://127.0.0.1:4599", ORIGIN)));
}

function replaceStrings<T>(value: T, transform: (value: string) => string): T {
  if (typeof value === "string") return transform(value) as T;
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, transform)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, transform)])) as T;
  return value;
}

function rewriteFramePaths(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rewriteFramePaths(item);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "framePath" && Array.isArray(item)) {
      (value as Record<string, unknown>)[key] = [];
    } else {
      rewriteFramePaths(item);
    }
  }
}
