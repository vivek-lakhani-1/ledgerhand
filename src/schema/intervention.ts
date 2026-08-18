import { z } from "zod";
import { Action } from "./step.js";

export const InterventionReasonCode = z.enum([
  "STUCK",
  "MAX_STEPS",
  "UNRECOVERABLE",
  "RISKY_ACTION_APPROVAL",
  "POLICY_BLOCKED",
  "AGENT_REQUESTED",
]);

export const HumanAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), at: z.string(), x: z.number(), y: z.number() }).strict(),
  z.object({ kind: z.literal("type"), at: z.string(), text: z.string() }).strict(),
  z.object({ kind: z.literal("key"), at: z.string(), key: z.string() }).strict(),
  z.object({ kind: z.literal("navigate"), at: z.string(), url: z.string() }).strict(),
]);

export const InterventionRequest = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    status: z.enum(["open", "claimed", "resolved", "aborted"]),
    origin: z.enum(["discovery", "replay"]),
    runId: z.string(),
    capabilityId: z.string().optional(),
    capabilityVersion: z.string().optional(),
    goal: z.string().optional(),
    reason: z
      .object({ code: InterventionReasonCode, detail: z.string() })
      .strict(),
    atStepId: z.string().optional(),
    stepDescription: z.string().optional(),
    expected: z.string().optional(),
    observed: z.string().optional(),
    context: z
      .object({
        url: z.string(),
        title: z.string(),
        screenshotPath: z.string(),
        snapshotPath: z.string(),
        recentEvents: z.array(z.unknown()),
      })
      .strict(),
    proposedAction: Action.optional(),
    operatorUrl: z.string(),
    humanActions: z.array(HumanAction),
    resolution: z
      .object({
        at: z.string(),
        note: z.string(),
        decision: z.enum(["resume", "approve", "abort", "complete"]),
      })
      .strict()
      .optional(),
  })
  .strict();
