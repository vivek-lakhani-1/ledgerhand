import type { CapabilityListing } from "./listing.js";

/**
 * Deterministic matching of a task description against the approved catalog. This is
 * deliberately not a model call: matching decides whether Ledgerhand claims to already know a
 * task, and that claim must be reproducible, testable offline, and immune to prompt drift.
 * A weak or ambiguous score is surfaced as such rather than guessed through.
 */

export type ScoredCapability = {
  listing: CapabilityListing;
  score: number;
};

export type MatchDecision =
  | { kind: "match"; capability: CapabilityListing; score: number }
  | { kind: "ambiguous"; candidates: ScoredCapability[] }
  | { kind: "none" };

/** Words that describe the act of asking rather than the task itself. */
const stopwords = new Set([
  "a", "an", "the", "of", "for", "to", "on", "in", "at", "and", "or", "with", "from", "into",
  "please", "can", "you", "could", "would", "me", "my", "their", "his", "her", "its", "s",
  "do", "does", "is", "are", "was", "what", "whats", "show", "tell", "get", "give", "run",
  "now", "then", "using", "via", "number", "no",
]);

/**
 * Canonical forms for common phrasings, so "move funds" and "transfer funds" score alike.
 * Kept small on purpose: every entry here widens what Ledgerhand claims to recognize.
 */
const synonyms: Record<string, string> = {
  send: "transfer",
  move: "transfer",
  wire: "transfer",
  customer: "member",
  client: "member",
  freeze: "hold",
  block: "hold",
  find: "lookup",
  search: "lookup",
  locate: "lookup",
  login: "signon",
  signin: "signon",
  create: "open",
  add: "open",
  change: "update",
  edit: "update",
  modify: "update",
  balances: "balance",
  funds: "transfer",
  holds: "hold",
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !stopwords.has(token) && !/^\d+$/.test(token))
    .map((token) => synonyms[token] ?? token);
}

/**
 * Weighted token overlap between the goal and one capability. Name and title tokens carry the
 * capability's identity, so they weigh far more than the prose description, which mentions
 * shared vocabulary ("member", "signs on") across the whole catalog.
 */
export function scoreCapability(goalTokens: string[], listing: CapabilityListing): number {
  if (goalTokens.length === 0) return 0;
  const nameTokens = new Set(tokenize(listing.name.replace(/[._]/g, " ")));
  const titleTokens = new Set(tokenize(listing.title));
  const contractTokens = new Set([
    ...listing.inputs.flatMap((input) => tokenize(splitIdentifier(input.name))),
    ...listing.outputs.flatMap((output) => tokenize(splitIdentifier(output))),
  ]);
  const descriptionTokens = new Set(tokenize(listing.description));

  let score = 0;
  for (const token of new Set(goalTokens)) {
    if (nameTokens.has(token)) score += 3;
    else if (titleTokens.has(token)) score += 2;
    else if (contractTokens.has(token)) score += 1;
    else if (descriptionTokens.has(token)) score += 0.5;
  }
  return score;
}

/** camelCase and snake_case identifiers become separate words before tokenizing. */
function splitIdentifier(identifier: string): string {
  return identifier.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._-]/g, " ");
}

/** A capability must clear this floor before Ledgerhand claims any knowledge of the task. */
const MATCH_FLOOR = 3;
/** The best match must beat the runner-up by this factor to be selected without asking. */
const CLEAR_MARGIN = 1.5;

/** The one scoring pipeline: both approved matching and draft similarity rank through here. */
function rank(goal: string, listings: CapabilityListing[]): ScoredCapability[] {
  const goalTokens = tokenize(goal);
  return listings
    .map((listing) => ({ listing, score: scoreCapability(goalTokens, listing) }))
    .filter((candidate) => candidate.score >= MATCH_FLOOR)
    .sort((a, b) => b.score - a.score);
}

export function matchCapability(goal: string, approved: CapabilityListing[]): MatchDecision {
  const scored = rank(goal, approved);
  if (scored.length === 0) return { kind: "none" };
  const [best, second] = scored;
  if (!second || best.score >= second.score * CLEAR_MARGIN) {
    return { kind: "match", capability: best.listing, score: best.score };
  }
  // Two or more plausible automations: the user picks, Ledgerhand does not guess.
  return { kind: "ambiguous", candidates: scored.slice(0, 4) };
}

/**
 * Whether an existing draft likely covers the same task, so Automatic mode can offer the
 * draft for review instead of silently rediscovering the same workflow over and over.
 */
export function findSimilarDraft(goal: string, drafts: CapabilityListing[]): ScoredCapability | null {
  return rank(goal, drafts)[0] ?? null;
}
