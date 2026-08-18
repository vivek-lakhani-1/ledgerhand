import { describe, expect, it } from "vitest";
import { classifyRisk } from "../src/policy/risk.js";
import { TargetDescriptor } from "../src/schema/index.js";
import type { Action } from "../src/schema/index.js";
import { target } from "./fixtures.js";

const click: Action = { type: "click", target: TargetDescriptor.parse(target) };

describe("classifyRisk", () => {
  it.each(["Confirm", "Submit", "Transfer"])("classifies %s as irreversible", (name) => {
    expect(classifyRisk(click, name)).toBe("irreversible");
  });

  it.each(["Retrieve", "Search", "Continue"])("does not classify %s as irreversible", (name) => {
    expect(classifyRisk(click, name)).toBe("safe");
  });

  it("classifies navigate, extract, assert, and wait as safe", () => {
    expect(classifyRisk({ type: "navigate", url: "https://bank.example" })).toBe("safe");
    expect(classifyRisk({ type: "extract", outputs: ["balance"] })).toBe("safe");
    expect(classifyRisk({ type: "assert", checkpoint: { kind: "text_present", text: "ok", match: "contains" } })).toBe("safe");
    expect(classifyRisk({ type: "wait", checkpoint: { kind: "text_present", text: "ok", match: "contains" } })).toBe("safe");
  });

  it("treats a form POST as irreversible and a reversible record change as sensitive", () => {
    expect(classifyRisk(click, "Continue", true)).toBe("irreversible");
    expect(classifyRisk(click, "Save changes")).toBe("sensitive");
  });
});
