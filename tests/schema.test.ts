import { describe, expect, it } from "vitest";
import { Capability, Checkpoint } from "../src/schema/index.js";
import { validCapability } from "./fixtures.js";

describe("artifact schemas", () => {
  it("parses a full valid Capability and applies specified defaults", () => {
    const result = Capability.safeParse(validCapability());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.approval).toBe("draft");
    expect(result.data.target.tenant).toBeNull();
    expect(result.data.target.viewport).toEqual({ width: 1280, height: 900 });
    expect(result.data.steps[0].risk).toBe("safe");
    expect(result.data.secretsRequired).toEqual(["APP_USER", "APP_PASSWORD"]);
  });

  it("parses recursive all/any/not checkpoints", () => {
    const checkpoint = {
      kind: "all",
      of: [
        { kind: "text_present", text: "Member" },
        {
          kind: "any",
          of: [
            { kind: "url_matches", pattern: "/member/" },
            { kind: "not", of: { kind: "text_absent", text: "Error" } },
          ],
        },
      ],
    };

    const result = Checkpoint.safeParse(checkpoint);
    expect(result.success).toBe(true);
  });

  it("rejects a bad capability name, empty steps, and unknown action with useful paths", () => {
    const badName = Capability.safeParse(validCapability({ name: "Member.Lookup" }));
    expect(badName.success).toBe(false);
    if (!badName.success) expect(badName.error.issues.some((issue) => issue.path.join(".") === "name")).toBe(true);

    const emptySteps = Capability.safeParse(validCapability({ steps: [] }));
    expect(emptySteps.success).toBe(false);
    if (!emptySteps.success) expect(emptySteps.error.issues.some((issue) => issue.path.join(".") === "steps")).toBe(true);

    const unknownAction = Capability.safeParse(
      validCapability({ steps: [{ ...validCapability().steps[0], action: { type: "hover" } }] }),
    );
    expect(unknownAction.success).toBe(false);
    if (!unknownAction.success) {
      expect(unknownAction.error.issues.some((issue) => issue.path.join(".").startsWith("steps.0.action"))).toBe(true);
    }
  });
});
