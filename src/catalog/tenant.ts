import { Capability, type Capability as CapabilityValue } from "../schema/index.js";
import { lintCapability } from "../schema/lint.js";

/**
 * Resolve a base capability for one tenant without mutating the artifact on disk.
 * Arrays are replacement values; plain objects are recursively merged. That gives a
 * partial step normal deep-merge semantics while making a supplied TargetDescriptor's
 * strategies an explicit wholesale replacement.
 */
export function resolveForTenant(capability: CapabilityValue, tenant?: string): CapabilityValue {
  const override = tenant ? capability.tenantOverrides[tenant] : undefined;
  const merged = override
    ? deepMerge(capability, {
        target: override.entryUrl === undefined ? undefined : { entryUrl: override.entryUrl },
        ...(override.outcomes === undefined ? {} : { outcomes: override.outcomes }),
      })
    : structuredClone(capability);

  if (override?.steps) {
    merged.steps = merged.steps.map((step) => {
      const delta = override.steps?.[step.id];
      return delta === undefined ? step : deepMerge(step, delta);
    }) as CapabilityValue["steps"];
  }

  const parsed = Capability.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Tenant resolution produced an invalid capability: ${parsed.error.message}`);
  }
  const problems = lintCapability(parsed.data);
  if (problems.length > 0) {
    throw new Error(`Tenant resolution produced a lint-invalid capability: ${problems.join("; ")}`);
  }
  return parsed.data;
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return (override as T) ?? base;
  }

  const result: Record<string, unknown> = {
    ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}),
  };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      && current && typeof current === "object" && !Array.isArray(current)
      ? deepMerge(current, value)
      : value;
  }
  return result as T;
}
