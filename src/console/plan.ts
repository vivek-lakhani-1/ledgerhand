import type { CapabilityListing } from "./listing.js";
import { findSimilarDraft, matchCapability, type ScoredCapability } from "./matcher.js";
import { capabilitiesForTarget, type ResolvedTarget } from "./targets.js";

export type AutomationMode = "automatic" | "replay_only" | "discover_only";

export function parseAutomationMode(value: unknown): AutomationMode | null {
  return value === "automatic" || value === "replay_only" || value === "discover_only" ? value : null;
}

/**
 * The plan card separates the four questions the product keeps apart: where the run may operate
 * (target), whether Ledgerhand knows the task (knowledge), whether the signed-in account can
 * complete it (access), and whether a human must still approve a step (risk). Access and risk
 * are forecasts from the artifact's shape - the authoritative checks still happen during Replay.
 */
export type PlanNotes = {
  /** Set when the capability's recorded shape includes a permission gate that can stop it. */
  permission: string | null;
  /** Set when the capability pauses for human approval before an irreversible step. */
  approval: string | null;
  /** Set when the capability changes the target system (irreversible step present). */
  changesTarget: boolean;
};

export type PlanDecision =
  | { kind: "replay"; capability: CapabilityListing; score: number; notes: PlanNotes }
  | { kind: "choose"; candidates: ScoredCapability[] }
  | { kind: "draft_exists"; draft: CapabilityListing }
  | { kind: "discovery"; entryUrl: string; secretNames: string[] }
  | { kind: "no_automation"; discoveryPossible: boolean }
  | { kind: "unavailable"; reason: string };

export type PlanRequest = {
  mode: AutomationMode;
  goal: string;
  target: ResolvedTarget;
  listings: CapabilityListing[];
  discoveryAvailable: boolean;
  /** Replay Only can name a capability outright instead of matching by goal. */
  capabilityName?: string;
};

export function planAutomation(request: PlanRequest): PlanDecision {
  const owned = capabilitiesForTarget(request.listings, request.target);
  const approved = owned.filter((listing) => listing.approval === "approved");
  const drafts = owned.filter((listing) => listing.approval === "draft");
  const discovery = (): PlanDecision => request.discoveryAvailable
    ? { kind: "discovery", entryUrl: request.target.entryUrl, secretNames: request.target.discoverySecretNames }
    : { kind: "unavailable", reason: "ANTHROPIC_API_KEY is not set, so discovery cannot run." };

  if (request.mode === "discover_only") {
    // Discover Only explores even when an approved automation exists; the user asked to learn
    // the task fresh, and the result is always a draft a human must approve.
    return discovery();
  }

  if (request.capabilityName) {
    const named = owned.find((listing) => listing.name === request.capabilityName);
    if (!named) {
      return { kind: "unavailable", reason: `Capability ${request.capabilityName} does not exist on ${request.target.name}` };
    }
    if (named.approval !== "approved") {
      return { kind: "unavailable", reason: `Capability ${request.capabilityName} is a draft and must be approved before Replay` };
    }
    return { kind: "replay", capability: named, score: Number.POSITIVE_INFINITY, notes: notesFor(named) };
  }

  const match = matchCapability(request.goal, approved);
  if (match.kind === "match") {
    return { kind: "replay", capability: match.capability, score: match.score, notes: notesFor(match.capability) };
  }
  if (match.kind === "ambiguous") {
    return { kind: "choose", candidates: match.candidates };
  }

  if (request.mode === "replay_only") {
    return { kind: "no_automation", discoveryPossible: request.discoveryAvailable };
  }

  // Automatic mode with no approved knowledge: offer an existing similar draft before
  // spending a discovery run on a task Ledgerhand may already have explored.
  const draft = findSimilarDraft(request.goal, drafts);
  if (draft) return { kind: "draft_exists", draft: draft.listing };
  return discovery();
}

function notesFor(listing: CapabilityListing): PlanNotes {
  return {
    permission: listing.permissionSensitive
      ? "This task includes a permission check the signed-in account may not pass. Ledgerhand stops and asks for human help instead of switching accounts."
      : null,
    approval: listing.requiresApproval
      ? "The final step changes the target system and pauses for explicit human approval."
      : null,
    changesTarget: listing.hasIrreversibleStep,
  };
}
