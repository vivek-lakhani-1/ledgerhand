import { z } from "zod";
import { Checkpoint } from "./checkpoint.js";
import { TargetDescriptor } from "./target.js";

export const Risk = z.enum(["safe", "sensitive", "irreversible"]);

export const Action = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("navigate"), url: z.string() }).strict(),
    z.object({ type: z.literal("click"), target: TargetDescriptor }).strict(),
    z
      .object({
        type: z.literal("type"),
        target: TargetDescriptor,
        value: z.string(),
        clearFirst: z.boolean().default(true),
      })
      .strict(),
    z
      .object({ type: z.literal("select"), target: TargetDescriptor, value: z.string() })
      .strict(),
    z
      .object({
        type: z.literal("press"),
        key: z.string(),
        target: TargetDescriptor.optional(),
      })
      .strict(),
    z.object({ type: z.literal("wait"), checkpoint: Checkpoint }).strict(),
    z.object({ type: z.literal("extract"), outputs: z.array(z.string()).min(1) }).strict(),
    z.object({ type: z.literal("assert"), checkpoint: Checkpoint }).strict(),
  ]);

export const RecoveryRule = z
  .object({
    id: z.string(),
    description: z.string(),
    when: Checkpoint,
    do: z.array(Action).min(1),
    maxAttempts: z.number().int().min(1).default(1),
    thenRetryStep: z.boolean().default(true),
  })
  .strict();

export const Step = z
  .object({
    id: z.string(),
    description: z.string(),
    action: Action,
    risk: Risk.default("safe"),
    preconditions: z.array(Checkpoint).default([]),
    postcondition: Checkpoint.optional(),
    timeoutMs: z.number().int().default(15000),
    retries: z
      .object({
        max: z.number().int().default(0),
        backoffMs: z.number().int().default(500),
      })
      .strict()
      .default({} as { max: number; backoffMs: number }),
    recover: z.array(RecoveryRule).default([]),
    onFailure: z.enum(["fail", "escalate"]).default("fail"),
  })
  .strict();
