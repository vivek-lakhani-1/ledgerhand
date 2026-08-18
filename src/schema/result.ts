import { z } from "zod";

const CapabilityReference = z
  .object({ id: z.string(), version: z.string() })
  .strict();

const OutputRecord = z.record(z.string(), z.unknown());

export const ErrorClass = z.enum([
  "INPUT_INVALID",
  "POLICY_BLOCKED",
  "TARGET_NOT_FOUND",
  "AMBIGUOUS_TARGET",
  "PRECONDITION_FAILED",
  "CHECKPOINT_FAILED",
  "TIMEOUT",
  "SESSION_EXPIRED",
  "PERMISSION_DENIED",
  "SURFACE_ERROR",
  "CONTROL_LOST",
  "INTERNAL",
]);

export const ReplayResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("success"),
      runId: z.string(),
      capability: CapabilityReference,
      outputs: OutputRecord,
      stepsExecuted: z.number().int(),
      durationMs: z.number(),
      evidenceDir: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("business_outcome"),
      runId: z.string(),
      capability: CapabilityReference,
      code: z.string(),
      message: z.string(),
      outputs: OutputRecord,
      atStepId: z.string(),
      evidenceDir: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("escalated"),
      runId: z.string(),
      capability: CapabilityReference,
      interventionId: z.string(),
      reason: z.string(),
      atStepId: z.string(),
      evidenceDir: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      runId: z.string(),
      capability: CapabilityReference,
      error: z
        .object({
          class: ErrorClass,
          stepId: z.string().nullable(),
          stepDescription: z.string().nullable(),
          expected: z.string(),
          observed: z.string(),
          message: z.string(),
          recoveryAttempts: z.array(z.string()).default([]),
        })
        .strict(),
      evidenceDir: z.string(),
    })
    .strict(),
]);
