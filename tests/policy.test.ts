import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/policy/policy.js";
import type { Action } from "../src/schema/index.js";

const safeNavigate: Action = { type: "navigate", url: "https://bank.example/home" };

function engine(overrides: Record<string, unknown> = {}) {
  return new PolicyEngine({
    allowedOrigins: ["https://bank.example"],
    allowedPathPatterns: ["/home", "/members/**"],
    ...overrides,
  });
}

describe("PolicyEngine", () => {
  it("denies an off-allowlist origin", () => {
    const result = engine().check(safeNavigate, {
      resolvedUrl: "https://evil.example/home",
      risk: "safe",
      mode: "replay",
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("Origin");
  });

  it("denies an off-allowlist path", () => {
    const result = engine().check(safeNavigate, {
      resolvedUrl: "https://bank.example/admin",
      risk: "safe",
      mode: "replay",
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("Path");
  });

  it("allows a nested path through a ** glob", () => {
    const result = engine().check(safeNavigate, {
      resolvedUrl: "https://bank.example/members/10001/accounts/savings",
      risk: "safe",
      mode: "replay",
    });
    expect(result.decision).toBe("allow");
  });

  it("denies an action type that is not allowlisted", () => {
    const result = new PolicyEngine({
      allowedOrigins: ["https://bank.example"],
      allowedActions: ["navigate"],
    }).check({ type: "navigate", url: "https://bank.example/home" }, {
      resolvedUrl: "https://bank.example/home",
      risk: "safe",
      mode: "replay",
    });
    expect(result.decision).toBe("allow");

    const denied = new PolicyEngine({
      allowedOrigins: ["https://bank.example"],
      allowedActions: ["click"],
    }).check(safeNavigate, {
      resolvedUrl: "https://bank.example/home",
      risk: "safe",
      mode: "replay",
    });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("Action type navigate");
  });

  it("denies risk above maxRisk", () => {
    const result = engine({ maxRisk: "sensitive" }).check(safeNavigate, {
      resolvedUrl: "https://bank.example/home",
      risk: "irreversible",
      mode: "replay",
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("exceeds maxRisk");
  });

  it("requires approval in replay and denies risky discovery by default", () => {
    const policy = new PolicyEngine({
      allowedOrigins: ["https://bank.example"],
      allowedPathPatterns: ["/**"],
      maxRisk: "irreversible",
    });
    const replay = policy.check(safeNavigate, {
      resolvedUrl: "https://bank.example/home",
      risk: "irreversible",
      mode: "replay",
    });
    expect(replay.decision).toBe("require_approval");

    const discovery = policy.check(safeNavigate, {
      resolvedUrl: "https://bank.example/home",
      risk: "irreversible",
      mode: "discovery",
    });
    expect(discovery.decision).toBe("deny");

    const allowedDiscovery = new PolicyEngine(
      { allowedOrigins: ["https://bank.example"], maxRisk: "irreversible" },
      { allowRisky: true },
    ).check(safeNavigate, {
      resolvedUrl: "https://bank.example/home",
      risk: "irreversible",
      mode: "discovery",
    });
    expect(allowedDiscovery.decision).toBe("allow");
  });
});
