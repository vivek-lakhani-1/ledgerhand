import { describe, expect, it } from "vitest";
import { Capability, lintCapability } from "../src/schema/index.js";
import { validCapability, target } from "./fixtures.js";

function lint(overrides: Record<string, unknown>) {
  return lintCapability(Capability.parse(validCapability(overrides)));
}

describe("lintCapability", () => {
  it("catches undeclared input and secret templates", () => {
    const problems = lint({
      steps: [
        {
          ...validCapability().steps[0],
          action: { type: "navigate", url: "{{inputs.unknown}}/{{secrets.MISSING}}" },
        },
      ],
    });
    expect(problems.join("\n")).toContain("undeclared inputs unknown");
    expect(problems.join("\n")).toContain("undeclared secrets MISSING");
  });

  it("catches an extract action whose output is not declared", () => {
    const problems = lint({
      steps: [{ ...validCapability().steps[0], action: { type: "extract", outputs: ["missingOutput"] } }],
    });
    expect(problems.some((problem) => problem.includes("undeclared output missingOutput"))).toBe(true);
  });

  it("catches output sources missing a target", () => {
    const problems = lint({
      outputs: [
        {
          name: "message",
          type: "string",
          description: "Message",
          source: { kind: "text_of" },
        },
      ],
    });
    expect(problems.some((problem) => problem.includes("target is required for text_of"))).toBe(true);
  });

  it("catches a trivially true success checkpoint", () => {
    const problems = lint({ successCheckpoint: { kind: "url_matches", pattern: ".*" } });
    expect(problems.some((problem) => problem.includes("trivially true"))).toBe(true);
  });

  it("catches empty and duplicate step ids", () => {
    const base = validCapability().steps[0];
    const problems = lint({ steps: [{ ...base, id: "" }, { ...base, id: "s1" }, { ...base, id: "s1" }] });
    expect(problems.some((problem) => problem.includes("must be non-empty"))).toBe(true);
    expect(problems.some((problem) => problem.includes("duplicates step id s1"))).toBe(true);
  });

  it("catches a step risk above policy.maxRisk", () => {
    const problems = lint({
      policy: { allowedOrigins: ["https://bank.example"], maxRisk: "safe" },
      steps: [{ ...validCapability().steps[0], risk: "irreversible" }],
    });
    expect(problems.some((problem) => problem.includes("exceeds policy.maxRisk safe"))).toBe(true);
  });

  it("checks templates in recovery actions too", () => {
    const problems = lint({
      recoveries: [
        {
          id: "recovery",
          description: "recovery",
          when: { kind: "text_present", text: "maintenance" },
          do: [{ type: "type", target, value: "{{secrets.NOT_DECLARED}}" }],
        },
      ],
    });
    expect(problems.some((problem) => problem.includes("undeclared secrets NOT_DECLARED"))).toBe(true);
  });
});
