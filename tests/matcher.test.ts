import path from "node:path";
import { describe, expect, it } from "vitest";
import { listCapabilities } from "../src/console/listing.js";
import { findSimilarDraft, matchCapability, tokenize } from "../src/console/matcher.js";

// The matcher is graded against the real catalog: these are the phrases the demo says, and
// the artifacts it must find. If a capability is renamed the test breaks - deliberately.
const listings = listCapabilities(path.join(process.cwd(), "capabilities"));
const approved = listings.filter((listing) => listing.approval === "approved");
const meridian = approved.filter((listing) => listing.origin === "https://web-sample.interface-hiring.com");

describe("tokenize", () => {
  it("drops filler, keeps task words, and canonicalizes synonyms", () => {
    expect(tokenize("Please check member 100987's balance")).toEqual(["check", "member", "balance"]);
    expect(tokenize("move funds to savings")).toContain("transfer");
    expect(tokenize("freeze the account")).toContain("hold");
  });
});

describe("matching demo phrases against the approved Meridian catalog", () => {
  it("finds meridian.member.balance for a balance check", () => {
    const decision = matchCapability("Check member 100987's balance", meridian);
    expect(decision.kind).toBe("match");
    if (decision.kind === "match") expect(decision.capability.name).toBe("meridian.member.balance");
  });

  it("finds meridian.account.hold for a fraud hold", () => {
    const decision = matchCapability("Put a fraud hold on member 100987", meridian);
    expect(decision.kind).toBe("match");
    if (decision.kind === "match") expect(decision.capability.name).toBe("meridian.account.hold");
  });

  it("finds meridian.funds.transfer for a transfer", () => {
    const decision = matchCapability("Transfer 50 dollars between member 100987's shares", meridian);
    expect(decision.kind).toBe("match");
    if (decision.kind === "match") expect(decision.capability.name).toBe("meridian.funds.transfer");
  });

  it("refuses to guess between plausible balance automations", () => {
    const decision = matchCapability("balance", meridian);
    // One bare word cannot separate member.balance from share.balance; the user chooses.
    expect(decision.kind).not.toBe("match");
  });

  it("claims no knowledge of a task the catalog does not cover", () => {
    const decision = matchCapability("Read the fraud review reconciliation setting", meridian);
    expect(decision.kind).toBe("none");
  });

  it("never matches across the target boundary", () => {
    const local = approved.filter((listing) => listing.origin === "http://127.0.0.1:4599");
    const decision = matchCapability("Check member 100987's balance in Meridian", local);
    if (decision.kind === "match") {
      expect(decision.capability.origin).toBe("http://127.0.0.1:4599");
    }
  });
});

describe("draft similarity", () => {
  it("surfaces an existing draft likely covering the same task", () => {
    const drafts = listings.filter((listing) => listing.approval === "draft");
    const similar = findSimilarDraft("Look up a member's savings balance", drafts);
    expect(similar?.listing.name).toBe("member.savings_balance.discovered");
  });

  it("returns nothing when no draft resembles the task", () => {
    const drafts = listings.filter((listing) => listing.approval === "draft");
    expect(findSimilarDraft("Reconcile the quarterly ledger export", drafts)).toBeNull();
  });
});
