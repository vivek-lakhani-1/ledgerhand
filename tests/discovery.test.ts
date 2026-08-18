import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../target-app/server.js";
import { runDiscovery } from "../src/discover/agent.js";
import { AnthropicModelClient, DiscoveryConfigurationError, ScriptedModelClient } from "../src/discover/model.js";
import { EvidenceDir } from "../src/evidence/evidence.js";
import { RunLogger } from "../src/evidence/logger.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { Redactor } from "../src/policy/redact.js";
import { BrowserSession } from "../src/session/session.js";
import { WebSurface } from "../src/surface/web/web-surface.js";

const TEST_PORT = 4641;
const ORIGIN = "http://127.0.0.1:" + TEST_PORT;
const ENTRY_URL = ORIGIN + "/t/alpha/msc/login";
const APP_USER = "OPER01";
const APP_PASSWORD = "demo-pass-01";

let server: Server;
let previousUser: string | undefined;
let previousPassword: string | undefined;

beforeAll(async () => {
  previousUser = process.env.APP_USER;
  previousPassword = process.env.APP_PASSWORD;
  process.env.APP_USER = APP_USER;
  process.env.APP_PASSWORD = APP_PASSWORD;
  server = startServer(TEST_PORT);
  await waitForHealth();
});

afterAll(async () => {
  if (previousUser === undefined) delete process.env.APP_USER;
  else process.env.APP_USER = previousUser;
  if (previousPassword === undefined) delete process.env.APP_PASSWORD;
  else process.env.APP_PASSWORD = previousPassword;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe("Phase 5 discovery loop", () => {
  it("runs a scripted happy path against the live target and captures descriptors at action time", async () => {
    const run = await runScript([
      call("observe", {}),
      call("declare_input", { name: "memberId", type: "string", description: "Member identifier", sensitivity: "pii", example: "10001" }),
      call("navigate", { url: ENTRY_URL, why: "Start at the operator sign-on page" }),
      call("type_text", { ref: "c6", text: "{{secrets.APP_USER}}", why: "Enter the operator ID" }),
      call("type_text", { ref: "c10", text: "{{secrets.APP_PASSWORD}}", why: "Enter the operator password" }),
      call("click", { ref: "c14", why: "Sign in to the console" }),
      call("type_text", { ref: "c19", text: "{{inputs.memberId}}", why: "Enter the requested member ID" }),
      call("click", { ref: "c23", why: "Retrieve the member record" }),
      call("extract", { ref: "c33", outputName: "savingsBalance", type: "number", description: "Savings balance", transform: "currency_to_number" }),
      call("assert_checkpoint", { kind: "text_present", text: "1250.75", why: "The savings balance is visible" }),
      call("finish", { summary: "The savings balance is visible", successCriterion: "1250.75" }),
    ]);

    expect(run.status, run.reason).toBe("completed");
    expect(run.trace.some((entry) => entry.tool === "type_text" && entry.descriptor)).toBe(true);
    expect(run.trace.some((entry) => entry.tool === "click" && entry.descriptor)).toBe(true);
    expect(run.trace.some((entry) => entry.tool === "extract" && entry.descriptor)).toBe(true);
    expect(run.trace.filter((entry) => entry.descriptor).every((entry) => entry.descriptor?.strategies.length)).toBe(true);
    expect(run.trace.find((entry) => entry.tool === "click" && entry.args.why === "Retrieve the member record")?.descriptor?.framePath).toEqual(["content"]);
    expect(run.trace.find((entry) => entry.tool === "click" && entry.args.why === "Retrieve the member record")?.checkpointAsserted).toMatchObject({ kind: "text_present", text: "1250.75" });

    const transcript = fs.readFileSync(path.join(run.evidenceDir, "discovery", "transcript.jsonl"), "utf8");
    expect(transcript).toContain("model.tool_call");
    expect(transcript).not.toContain(APP_USER);
    expect(transcript).not.toContain(APP_PASSWORD);
  });

  it("returns an is_error tool result for an unknown ref without appending that action", async () => {
    const run = await runScript([
      call("observe", {}),
      call("click", { ref: "c999", why: "Guess at a control" }),
      call("request_human_help", { reason: "The ref was not present", whatIWasTrying: "Continue safely" }),
    ]);

    expect(run.status).toBe("escalated");
    expect(run.trace.some((entry) => entry.tool === "click")).toBe(false);
    const transcript = fs.readFileSync(path.join(run.evidenceDir, "discovery", "transcript.jsonl"), "utf8");
    expect(transcript).toContain("\"is_error\":true");
    expect(transcript).toContain("re-observe");
  });

  it("denies an off-allowlist action without appending it to the trace", async () => {
    const run = await runScript([
      call("observe", {}),
      call("navigate", { url: "https://off-allowlist.example/escape", why: "Try to leave the app" }),
      call("request_human_help", { reason: "Policy denied navigation", whatIWasTrying: "Leave the target app" }),
    ]);

    expect(run.status).toBe("escalated");
    expect(run.trace.some((entry) => entry.tool === "navigate" && entry.args.url === "https://off-allowlist.example/escape")).toBe(false);
    const transcript = fs.readFileSync(path.join(run.evidenceDir, "discovery", "transcript.jsonl"), "utf8");
    expect(transcript).toContain("Denied by policy");
  });

  it("escalates when the model requests human help", async () => {
    const run = await runScript([
      call("request_human_help", { reason: "The page is ambiguous", whatIWasTrying: "Find the member search control" }),
    ]);

    expect(run.status).toBe("escalated");
    expect(run.reason).toContain("ambiguous");
  });

  it("uses the no-progress stopping rule before maxSteps", async () => {
    const run = await runScript([
      call("observe", {}),
      call("observe", {}),
      call("observe", {}),
      call("observe", {}),
    ], 10);

    expect(run.status).toBe("escalated");
    expect(run.reason).toContain("Three consecutive observations");
    expect(run.modelCalls).toBe(3);
  });

  it("throws a typed construction error without an Anthropic credential", () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      expect(() => new AnthropicModelClient()).toThrow(DiscoveryConfigurationError);
    } finally {
      if (apiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = apiKey;
      if (authToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = authToken;
    }
  });
});

function call(name: string, input: Record<string, unknown>) {
  return { name, input };
}

async function runScript(calls: Array<{ name: string; input: Record<string, unknown> }>, maxSteps = 25): Promise<{
  status: string;
  trace: Awaited<ReturnType<typeof runDiscovery>>["trace"];
  reason?: string;
  evidenceDir: string;
  modelCalls: number;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-discovery-"));
  const runId = "discovery-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  const redactor = new Redactor({ secrets: [APP_PASSWORD], piiValues: [] });
  const logger = new RunLogger(runId, redactor, root);
  const evidence = new EvidenceDir(runId, redactor, root);
  const policy = new PolicyEngine({ allowedOrigins: [ORIGIN], allowedPathPatterns: ["/**"], maxRisk: "safe" });
  const session = await BrowserSession.launch({
    headless: true,
    viewport: { width: 1280, height: 900 },
    sessionId: "session-" + runId,
  });
  const surface = new WebSurface({ session, policy, logger, caller: "automation" });
  const model = new ScriptedModelClient(calls);
  try {
    const result = await runDiscovery({
      goal: "Look up the member savings balance",
      entryUrl: ENTRY_URL,
      inputs: { memberId: "10001" },
      surface,
      policy,
      logger,
      evidence,
      model,
      maxSteps,
    });
    return { ...result, evidenceDir: evidence.runDir, modelCalls: model.callsUsed };
  } finally {
    await session.close();
  }
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ORIGIN + "/_health");
      if (response.ok) return;
    } catch {
      // The dedicated test port may still be binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Target app did not become healthy");
}
