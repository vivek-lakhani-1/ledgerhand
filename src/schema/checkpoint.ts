import { z } from "zod";
import { TargetDescriptor } from "./target.js";

type TargetDescriptorValue = z.infer<typeof TargetDescriptor>;
type CheckpointMetadata = { timeoutMs?: number; description?: string };

export type Checkpoint =
  | (CheckpointMetadata & {
      kind: "text_present";
      text: string;
      match: "exact" | "contains" | "regex";
      framePath?: string[];
    })
  | (CheckpointMetadata & {
      kind: "text_absent";
      text: string;
      match: "exact" | "contains" | "regex";
      framePath?: string[];
    })
  | (CheckpointMetadata & { kind: "control_present"; target: TargetDescriptorValue })
  | (CheckpointMetadata & { kind: "control_absent"; target: TargetDescriptorValue })
  | (CheckpointMetadata & { kind: "url_matches"; pattern: string })
  | (CheckpointMetadata & { kind: "title_matches"; pattern: string })
  | (CheckpointMetadata & { kind: "all"; of: Checkpoint[] })
  | (CheckpointMetadata & { kind: "any"; of: Checkpoint[] })
  | (CheckpointMetadata & { kind: "not"; of: Checkpoint });

export const Checkpoint: z.ZodType<Checkpoint> = z.lazy(() =>
  z
    .discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("text_present"),
          text: z.string(),
          match: z.enum(["exact", "contains", "regex"]).default("contains"),
          framePath: z.array(z.string()).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("text_absent"),
          text: z.string(),
          match: z.enum(["exact", "contains", "regex"]).default("contains"),
          framePath: z.array(z.string()).optional(),
        })
        .strict(),
      z.object({ kind: z.literal("control_present"), target: TargetDescriptor }).strict(),
      z.object({ kind: z.literal("control_absent"), target: TargetDescriptor }).strict(),
      z.object({ kind: z.literal("url_matches"), pattern: z.string() }).strict(),
      z.object({ kind: z.literal("title_matches"), pattern: z.string() }).strict(),
      z
        .object({ kind: z.literal("all"), of: z.array(Checkpoint).min(1) })
        .strict(),
      z
        .object({ kind: z.literal("any"), of: z.array(Checkpoint).min(1) })
        .strict(),
      z.object({ kind: z.literal("not"), of: Checkpoint }).strict(),
    ])
    .and(
      z
        .object({
          timeoutMs: z.number().int().optional(),
          description: z.string().optional(),
        })
        .strict(),
    ),
);
