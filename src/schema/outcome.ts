import { z } from "zod";
import { Checkpoint } from "./checkpoint.js";
import { OutputSpec } from "./io.js";

export const BusinessOutcome = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    description: z.string(),
    detect: Checkpoint,
    terminal: z.boolean().default(true),
    outputs: z.array(OutputSpec).default([]),
  })
  .strict();
