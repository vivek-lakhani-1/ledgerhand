import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { revalidateCapability } from "../catalog/tenant.js";
import { referencePattern } from "../replay/template.js";
import type { Capability as CapabilityValue } from "../schema/index.js";
import type { CapabilityListing } from "./listing.js";

const envVarName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

export const CredentialProfile = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    description: z.string().default(""),
    /**
     * capability-declared secret name -> env var to substitute at run time. Names map to
     * names; no credential value ever appears in configuration or artifacts.
     */
    secretAliases: z.record(envVarName, envVarName).default({}),
  })
  .strict();
export type CredentialProfile = z.infer<typeof CredentialProfile>;

export const TargetPreset = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
    category: z.string().min(1),
    origin: z.string().url(),
    entryUrl: z.string().url(),
    discoverySecretNames: z.array(envVarName).min(1),
    credentialProfiles: z.array(CredentialProfile).default([]),
  })
  .strict();
export type TargetPreset = z.infer<typeof TargetPreset>;

const CustomTargetDefaults = z
  .object({
    discoverySecretNames: z.array(envVarName).min(1),
  })
  .strict();
export type CustomTargetDefaults = z.infer<typeof CustomTargetDefaults>;

const TargetsFile = z
  .object({
    targets: z.array(TargetPreset).min(1),
    /** Applied to in-memory custom targets (an entry URL on no configured origin). */
    customTargetDefaults: CustomTargetDefaults.default({ discoverySecretNames: ["APP_USER", "APP_PASSWORD"] }),
  })
  .strict();

export type TargetsConfig = {
  targets: TargetPreset[];
  customDefaults: CustomTargetDefaults;
};

/**
 * A resolved target for one run. Presets come from configuration; a URL that matches no
 * preset becomes an in-memory custom target scoped to exactly that URL's origin.
 */
export type ResolvedTarget = {
  id: string;
  name: string;
  category: string;
  origin: string;
  entryUrl: string;
  discoverySecretNames: string[];
  credentialProfiles: CredentialProfile[];
  custom: boolean;
};

export type TargetAutomationStatus = "available" | "draft_only" | "not_discovered";

export type TargetSummary = ResolvedTarget & {
  approvedCount: number;
  draftCount: number;
  automationStatus: TargetAutomationStatus;
};

export function loadTargetsConfig(configPath?: string): TargetsConfig {
  const file = configPath ?? path.join(process.cwd(), "config", "targets.json");
  const parsed = TargetsFile.parse(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  const seen = new Set<string>();
  for (const target of parsed.targets) {
    if (seen.has(target.id)) throw new Error(`Duplicate target id ${target.id} in ${file}`);
    seen.add(target.id);
    if (new URL(target.entryUrl).origin !== new URL(target.origin).origin) {
      throw new Error(`Target ${target.id}: entryUrl ${target.entryUrl} is not on origin ${target.origin}`);
    }
  }
  return { targets: parsed.targets, customDefaults: parsed.customTargetDefaults };
}

export function loadTargets(configPath?: string): TargetPreset[] {
  return loadTargetsConfig(configPath).targets;
}

export function asResolved(preset: TargetPreset): ResolvedTarget {
  return {
    id: preset.id,
    name: preset.name,
    category: preset.category,
    origin: new URL(preset.origin).origin,
    entryUrl: preset.entryUrl,
    discoverySecretNames: preset.discoverySecretNames,
    credentialProfiles: preset.credentialProfiles,
    custom: false,
  };
}

export function findTarget(targets: TargetPreset[], id: string): ResolvedTarget | null {
  const preset = targets.find((target) => target.id === id);
  return preset ? asResolved(preset) : null;
}

/**
 * Detects the configured target a URL belongs to. A URL on no configured origin becomes a
 * custom target locked to that URL's origin alone - never a widened allowlist.
 */
export function detectTarget(
  targets: TargetPreset[],
  url: string,
  customDefaults?: CustomTargetDefaults,
): ResolvedTarget | null {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const preset = targets.find((target) => new URL(target.origin).origin === origin);
  if (preset) return asResolved(preset);
  return {
    id: "custom",
    name: "Custom Target",
    category: "Unrecognized system",
    origin,
    entryUrl: url,
    discoverySecretNames: customDefaults?.discoverySecretNames ?? ["APP_USER", "APP_PASSWORD"],
    credentialProfiles: [],
    custom: true,
  };
}

/** Capabilities belong to the target whose origin their entry URL sits on. */
export function capabilitiesForTarget(listings: CapabilityListing[], target: Pick<ResolvedTarget, "origin">): CapabilityListing[] {
  return listings.filter((listing) => listing.origin === target.origin);
}

export function summarizeTargets(targets: TargetPreset[], listings: CapabilityListing[]): TargetSummary[] {
  return targets.map((preset) => {
    const resolved = asResolved(preset);
    const owned = capabilitiesForTarget(listings, resolved);
    const approvedCount = owned.filter((listing) => listing.approval === "approved").length;
    const draftCount = owned.filter((listing) => listing.approval === "draft").length;
    return {
      ...resolved,
      approvedCount,
      draftCount,
      automationStatus: approvedCount > 0 ? "available" : draftCount > 0 ? "draft_only" : "not_discovered",
    };
  });
}

/**
 * Re-points a capability's secret references at a different set of env-var names for one run.
 * This is the explicit, user-chosen path for running an automation under other credentials
 * (e.g. the teller demo account instead of the recorded supervisor variables). It rewrites
 * `{{secrets.X}}` references and `secretsRequired` in memory only - the artifact on disk is
 * untouched, values are still read from process.env at substitution time, and the result is
 * re-validated and re-linted the same way tenant resolution is.
 */
export function applyCredentialProfile(capability: CapabilityValue, profile: CredentialProfile): CapabilityValue {
  const aliases = profile.secretAliases;
  if (Object.keys(aliases).length === 0) return capability;

  const rewritten = rewriteSecretReferences(structuredClone(capability), aliases) as CapabilityValue;
  rewritten.secretsRequired = [...new Set(capability.secretsRequired.map((name) => aliases[name] ?? name))];
  return revalidateCapability(rewritten, `Credential profile ${profile.id}`);
}

/**
 * Rewrites {{secrets.X}} references using replay's own reference grammar, so a reference
 * replay would resolve can never be one this rewrite silently missed.
 */
function rewriteSecretReferences(value: unknown, aliases: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(referencePattern, (whole, namespace: string, key: string) =>
      namespace === "secrets" && aliases[key] ? `{{secrets.${aliases[key]}}}` : whole);
  }
  if (Array.isArray(value)) return value.map((item) => rewriteSecretReferences(item, aliases));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteSecretReferences(item, aliases)]),
    );
  }
  return value;
}
