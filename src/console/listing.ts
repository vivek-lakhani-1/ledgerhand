import fs from "node:fs";
import path from "node:path";
import { Capability, type Capability as CapabilityValue } from "../schema/index.js";
import { lintCapability } from "../schema/lint.js";

export type CapabilityListing = {
  file: string;
  name: string;
  title: string;
  version: string;
  approval: string;
  description: string;
  inputs: { name: string; required: boolean; example?: unknown; description?: string }[];
  outputs: string[];
  /** "base" plus every tenant the artifact declares an override for. */
  tenants: string[];
  stepCount: number;
  hasIrreversibleStep: boolean;
  /** True when the artifact's policy pauses its irreversible step for human approval. */
  requiresApproval: boolean;
  /**
   * True when a non-irreversible step escalates on failure - the recorded shape of an
   * application-level permission wall (e.g. a supervisor gate) the credentials may hit.
   */
  permissionSensitive: boolean;
  secretsRequired: string[];
  entryUrl: string;
  /** Origin of the entry URL with template placeholders neutralized; null if not parseable. */
  origin: string | null;
};

export function listingFor(file: string, capability: CapabilityValue): CapabilityListing {
  return {
    file,
    name: capability.name,
    title: capability.title,
    version: capability.version,
    approval: capability.approval,
    description: capability.description,
    inputs: capability.inputs.map((input) => ({
      name: input.name,
      required: input.required,
      example: input.example,
      description: input.description,
    })),
    outputs: capability.outputs.map((output) => output.name),
    tenants: ["base", ...Object.keys(capability.tenantOverrides ?? {})],
    stepCount: capability.steps.length,
    hasIrreversibleStep: capability.steps.some((step) => step.risk === "irreversible"),
    requiresApproval: capability.steps.some((step) => step.risk === "irreversible")
      && (capability.policy.requireApprovalFor ?? []).includes("irreversible"),
    permissionSensitive: capability.steps.some((step) => step.onFailure === "escalate" && step.risk !== "irreversible"),
    secretsRequired: capability.secretsRequired,
    entryUrl: capability.target.entryUrl,
    origin: originOf(capability.target.entryUrl),
  };
}

export function listCapabilities(directory: string): CapabilityListing[] {
  if (!fs.existsSync(directory)) return [];
  const listings: CapabilityListing[] = [];
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    try {
      listings.push(listingFor(entry, readCapability(path.join(directory, entry))));
    } catch {
      // A capability that no longer validates should not blank the whole list.
    }
  }
  return listings.sort((a, b) => a.name.localeCompare(b.name));
}

/** Finds the artifact file whose capability name matches, since invocation is by name, not file. */
export function findCapabilityByName(directory: string, name: string): { capability: CapabilityValue; path: string } | null {
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    const candidate = path.join(directory, entry);
    try {
      const capability = readCapability(candidate);
      if (capability.name === name) return { capability, path: candidate };
    } catch {
      // Invalid artifacts are already surfaced by the listing; skip them here.
    }
  }
  return null;
}

export function readCapability(filename: string): CapabilityValue {
  const parsed = Capability.safeParse(JSON.parse(fs.readFileSync(filename, "utf8")) as unknown);
  if (!parsed.success) throw new Error(`Invalid capability ${path.basename(filename)}`);
  const problems = lintCapability(parsed.data);
  if (problems.length > 0) throw new Error(`Lint-invalid capability ${path.basename(filename)}: ${problems.join("; ")}`);
  return parsed.data;
}

/** Keeps a request from reaching a file outside the capabilities directory. */
export function resolveWithin(directory: string, candidate: string): string {
  const root = path.resolve(directory);
  const resolved = path.resolve(root, path.basename(candidate));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Capability path is outside the catalog");
  return resolved;
}

/** Entry URLs may contain {{...}} template references; those never affect the origin. */
export function originOf(url: string): string | null {
  try {
    return new URL(url.replace(/\{\{[^}]+\}\}/g, "placeholder")).origin;
  } catch {
    return null;
  }
}
