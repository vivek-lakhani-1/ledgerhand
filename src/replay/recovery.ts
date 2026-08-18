import type { Action, Capability, RecoveryRule, Step } from "../schema/index.js";
import type { Surface } from "../surface/types.js";
import { evaluateCheckpoint } from "./checkpoint.js";
import { resolveTemplate, type TemplateContext } from "./template.js";

export type RecoveryRunState = {
  attempts: Map<string, number>;
  inputs: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  pollMs?: number;
};

export type RecoveryApplication = { applied: RecoveryRule };

export async function tryRecover(
  step: Step,
  cap: Capability,
  surface: Surface,
  state: RecoveryRunState,
): Promise<RecoveryApplication | null> {
  // Step-level rules are intentionally considered before capability-wide rules. A local
  // repair is less surprising than a global session repair, and rule counts live in this
  // run-wide map so a recovery cannot spin once per step.
  const rules = [...step.recover, ...cap.recoveries];
  for (const rule of rules) {
    const count = state.attempts.get(rule.id) ?? 0;
    if (count >= rule.maxAttempts) continue;

    const detected = await evaluateCheckpoint(rule.when, surface, Date.now() + (rule.when.timeoutMs ?? state.timeoutMs ?? 1000));
    if (!detected.ok) continue;

    state.attempts.set(rule.id, count + 1);
    for (const action of rule.do) {
      const resolved = resolveActionTemplates(action, {
        inputs: state.inputs,
        secrets: {},
        env: state.env ?? process.env,
      });
      await surface.act(resolved, {
        risk: "safe",
        mode: "replay",
        timeoutMs: state.timeoutMs,
      });
    }
    return { applied: rule };
  }
  return null;
}

export function resolveActionTemplates(action: Action, context: TemplateContext): Action {
  return mapStrings(action, (value) => resolveTemplate(value, context)) as Action;
}

function mapStrings(value: unknown, transform: (value: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, transform)]));
  }
  return value;
}

