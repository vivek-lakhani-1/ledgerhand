import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordCapability, writeCapability } from "../src/discover/recorder.js";
import type { DiscoveryTraceEntry } from "../src/discover/agent.js";
import { Capability, lintCapability, TargetDescriptor, type Checkpoint, type TargetDescriptor as TargetDescriptorValue } from "../src/schema/index.js";
import type { Observation, PerceivedControl } from "../src/surface/types.js";

const ORIGIN = "http://127.0.0.1:4641";
const ENTRY_URL = ORIGIN + "/t/alpha/msc/login";

describe("recorder", () => {
  it("compiles a canned trace into a validated capability with parameterization, postconditions, defaults, and risk", () => {
    const trace = cannedTrace();
    const substitutions: string[] = [];
    const capability = recordCapability({
      trace,
      goal: "Look up a member savings balance",
      entryUrl: ENTRY_URL,
      inputs: { memberId: "10001" },
      finish: { summary: "Balance is visible", successCriterion: "Balance 1250.75" },
      runId: "discovery-canned",
      substitutionLog: substitutions,
      name: "member.savings_balance.lookup",
    });

    expect(trace.filter((entry) => entry.tool === "observe")).toHaveLength(1);
    expect(capability.steps).toHaveLength(4);
    expect(capability.steps.map((step) => step.action.type)).toEqual(["navigate", "type", "click", "extract"]);
    expect(capability.steps[1].action).toMatchObject({ type: "type", value: "{{inputs.memberId}}" });
    expect(capability.steps[0].action).toMatchObject({ type: "navigate", url: ORIGIN + "/t/alpha/msc/member/{{inputs.memberId}}" });
    expect(substitutions.some((message) => message.includes("typed literal"))).toBe(true);
    expect(capability.steps.filter((step) => step.action.type !== "extract").every((step) => step.postcondition)).toBe(true);
    expect(capability.steps.find((step) => step.action.type === "click")?.risk).toBe("irreversible");
    expect(capability.outcomes.map((outcome) => outcome.code)).toEqual(expect.arrayContaining([
      "MEMBER_NOT_FOUND",
      "PERMISSION_DENIED",
      "VALIDATION_ERROR",
    ]));
    expect(capability.recoveries.map((recovery) => recovery.id)).toEqual([
      "dismiss_interstitial",
      "reauthenticate",
    ]);

    const parsed = Capability.parse(capability);
    expect(lintCapability(parsed)).toEqual([]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-recorder-"));
    const outputPath = writeCapability(parsed, root);
    expect(outputPath).toBe(path.join(root, "capabilities", "member.savings_balance.lookup.v1.0.0.json"));
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toMatchObject({ name: "member.savings_balance.lookup" });
  });
});

function cannedTrace(): DiscoveryTraceEntry[] {
  const login = observation(ENTRY_URL, "Login", "Login\nMember ID");
  const member = observation(ORIGIN + "/t/alpha/msc/member/10001", "Member 10001", "Member page\nMember ID");
  const typed = observation(ORIGIN + "/t/alpha/msc/member/10001", "Member 10001", "Member page\nMember ID 10001");
  const confirmed = observation(ORIGIN + "/t/alpha/msc/member/10001", "Member 10001", "Confirmed\nBalance 1250.75");
  const textbox = descriptor("textbox", "Member ID");
  const back = descriptor("button", "Back");
  const confirm = descriptor("button", "Confirm");
  const balance = descriptor("cell", "1250.75");
  const checkpoint: Checkpoint = { kind: "text_present", text: "Confirmed", match: "contains", framePath: [] };

  return [
    entry(0, "observe", {}, login, login),
    entry(1, "declare_input", {
      name: "memberId",
      type: "string",
      description: "Member identifier",
      sensitivity: "pii",
      example: "10001",
    }, login, login),
    entry(2, "navigate", {
      url: ORIGIN + "/t/alpha/msc/member/10001",
      why: "Open the member page",
    }, login, member),
    entry(3, "type_text", {
      ref: "c1",
      text: "10001",
      why: "Enter the member identifier",
    }, member, typed, textbox),
    entry(4, "click", {
      ref: "c2",
      why: "Backtrack from an unhelpful branch",
      deadEnd: true,
    }, typed, member, back),
    entry(5, "click", {
      ref: "c3",
      why: "Confirm the member lookup",
    }, member, confirmed, confirm),
    entry(6, "assert_checkpoint", {
      kind: "text_present",
      text: "Confirmed",
      why: "The confirmation is visible",
    }, confirmed, confirmed, undefined, checkpoint),
    entry(7, "extract", {
      ref: "c4",
      outputName: "savingsBalance",
      type: "number",
      description: "Savings balance",
      transform: "currency_to_number",
    }, confirmed, confirmed, balance),
    entry(8, "finish", {
      summary: "Balance is visible",
      successCriterion: "Balance 1250.75",
    }, confirmed, confirmed),
  ];
}

function entry(
  seq: number,
  tool: string,
  args: Record<string, unknown>,
  before: Observation,
  after: Observation,
  descriptor?: TargetDescriptorValue,
  checkpointAsserted?: Checkpoint,
): DiscoveryTraceEntry {
  return {
    seq,
    tool,
    args,
    why: typeof args.why === "string" ? args.why : "",
    ...(descriptor ? { descriptor } : {}),
    urlBefore: before.url,
    urlAfter: after.url,
    observationBefore: before,
    observationAfter: after,
    ...(checkpointAsserted ? { checkpointAsserted } : {}),
  };
}

function descriptor(role: PerceivedControl["role"], name: string) {
  return TargetDescriptor.parse({
    role,
    name,
    framePath: [],
    strategies: [{
      kind: "aria",
      role,
      name,
      exact: true,
      confidence: 0.95,
      origin: "captured",
    }],
    description: role + " " + name,
  });
}

function observation(url: string, title: string, text: string): Observation {
  return {
    url,
    title,
    viewport: { width: 1280, height: 900 },
    frames: [{
      path: [],
      title,
      text,
      controls: [],
    }],
  };
}
