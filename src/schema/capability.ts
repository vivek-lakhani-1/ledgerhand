import { z } from "zod";
import { Checkpoint } from "./checkpoint.js";
import { ParamSpec, OutputSpec } from "./io.js";
import { BusinessOutcome } from "./outcome.js";
import { RecoveryRule, Risk, Step } from "./step.js";

export const Capability = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    id: z.string(),
    name: z.string().regex(/^[a-z][a-z0-9_.]*$/),
    title: z.string(),
    version: z.string(),
    description: z.string(),
    approval: z.enum(["draft", "approved", "deprecated"]).default("draft"),

    target: z
      .object({
        surface: z.enum(["web", "legacy-web", "desktop"]),
        app: z.string(),
        appVersion: z.string().optional(),
        tenant: z.string().nullable().default(null),
        entryUrl: z.string(),
        viewport: z
          .object({ width: z.number(), height: z.number() })
          .strict()
          .default({ width: 1280, height: 900 }),
      })
      .strict(),

    inputs: z.array(ParamSpec).default([]),
    outputs: z.array(OutputSpec).default([]),
    // Required by Phase 2 linting for recovery templates such as {{secrets.APP_USER}}.
    secretsRequired: z.array(z.string()).default([]),
    steps: z.array(Step).min(1),
    outcomes: z.array(BusinessOutcome).default([]),
    recoveries: z.array(RecoveryRule).default([]),
    successCheckpoint: Checkpoint,

    policy: z
      .object({
        allowedOrigins: z.array(z.string()).min(1),
        allowedPathPatterns: z.array(z.string()).default(["/**"]),
        allowedActions: z
          .array(z.string())
          .default(["navigate", "click", "type", "select", "press", "wait", "extract", "assert"]),
        maxRisk: Risk.default("safe"),
        requireApprovalFor: z.array(Risk).default(["irreversible"]),
        maxSteps: z.number().int().default(60),
        timeoutMs: z.number().int().default(120000),
      })
      .strict(),

    provenance: z
      .object({
        recordedAt: z.string(),
        goal: z.string(),
        model: z.string(),
        discoveryRunId: z.string(),
        surfaceSignature: z.record(z.string(), z.string()),
        llmStepCount: z.number().int(),
      })
      .strict(),

    stability: z
      .object({
        runs: z.number().int().default(0),
        successes: z.number().int().default(0),
        businessOutcomes: z.number().int().default(0),
        failures: z.number().int().default(0),
        lastRunAt: z.string().nullable().default(null),
      })
      .strict()
      .default({} as { runs: number; successes: number; businessOutcomes: number; failures: number; lastRunAt: string | null }),

    tenantOverrides: z
      .record(
        z.string(),
        z
          .object({
            entryUrl: z.string().optional(),
            steps: z.record(z.string(), Step.partial()).optional(),
            outcomes: z.array(BusinessOutcome).optional(),
            note: z.string().optional(),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();
