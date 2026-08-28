import path from "node:path";
import { describe, expect, it } from "vitest";
import { listCapabilities, readCapability } from "../src/console/listing.js";
import {
  applyCredentialProfile,
  detectTarget,
  findTarget,
  loadTargets,
  summarizeTargets,
} from "../src/console/targets.js";

const targets = loadTargets(path.join(process.cwd(), "config", "targets.json"));
const listings = listCapabilities(path.join(process.cwd(), "capabilities"));

describe("target presets", () => {
  it("loads the configured coverage catalog", () => {
    expect(targets.length).toBeGreaterThanOrEqual(10);
    expect(targets.map((target) => target.id)).toContain("meridian");
    expect(targets.map((target) => target.id)).toContain("local-app");
  });

  it("computes automation status from the capability catalog, never from configuration", () => {
    const summaries = summarizeTargets(targets, listings);
    const meridian = summaries.find((summary) => summary.id === "meridian")!;
    expect(meridian.approvedCount).toBeGreaterThanOrEqual(9);
    expect(meridian.automationStatus).toBe("available");
    const claims = summaries.find((summary) => summary.id === "claimsdesk")!;
    expect(claims.approvedCount).toBe(0);
    expect(claims.automationStatus).toBe("not_discovered");
  });
});

describe("target detection from an entry URL", () => {
  it("recognizes a configured origin", () => {
    const detected = detectTarget(targets, "https://web-sample.interface-hiring.com/signon");
    expect(detected?.id).toBe("meridian");
    expect(detected?.custom).toBe(false);
  });

  it("locks an unknown URL to a custom target scoped to its origin alone", () => {
    const detected = detectTarget(targets, "https://legacy.example.com/login?next=home");
    expect(detected?.id).toBe("custom");
    expect(detected?.custom).toBe(true);
    expect(detected?.origin).toBe("https://legacy.example.com");
  });

  it("returns null for a URL that does not parse", () => {
    expect(detectTarget(targets, "not-a-url")).toBeNull();
  });
});

describe("credential profiles", () => {
  const meridian = findTarget(targets, "meridian")!;
  const hold = readCapability(path.join(process.cwd(), "capabilities", "meridian.account.hold.v1.json"));

  it("re-points secret names for the teller demo without touching values or disk", () => {
    const teller = meridian.credentialProfiles.find((profile) => profile.id === "teller")!;
    const remapped = applyCredentialProfile(hold, teller);
    expect(remapped.secretsRequired).toEqual(["MERIDIAN_OPERATOR", "MERIDIAN_PASSWORD"]);
    expect(JSON.stringify(remapped)).not.toContain("MERIDIAN_HOLD_OPERATOR");
    // The artifact object handed in is untouched: the remap is a per-run view.
    expect(hold.secretsRequired).toEqual(["MERIDIAN_HOLD_OPERATOR", "MERIDIAN_HOLD_PASSWORD"]);
  });

  it("leaves a capability alone under the identity profile", () => {
    const recorded = meridian.credentialProfiles.find((profile) => profile.id === "recorded")!;
    expect(applyCredentialProfile(hold, recorded)).toBe(hold);
  });

  it("pins the supervisor profile to the dedicated supervisor variables", () => {
    const supervisor = meridian.credentialProfiles.find((profile) => profile.id === "supervisor")!;
    const remapped = applyCredentialProfile(hold, supervisor);
    // "Supervisor" must mean the supervisor account regardless of what the hold-demo
    // variables happen to be set to in a given .env.
    expect(remapped.secretsRequired).toEqual(["MERIDIAN_SUPERVISOR", "MERIDIAN_SUPERVISOR_PASSWORD"]);
    expect(JSON.stringify(remapped)).not.toContain("MERIDIAN_HOLD_OPERATOR");
  });
});
