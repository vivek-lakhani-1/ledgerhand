import { z } from "zod";
import { TargetDescriptor } from "./target.js";

export const Sensitivity = z.enum(["public", "pii", "secret"]);

export const ParamSpec = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    type: z.enum(["string", "number", "boolean", "date", "enum"]),
    required: z.boolean().default(true),
    description: z.string(),
    enumValues: z.array(z.string()).optional(),
    pattern: z.string().optional(),
    sensitivity: Sensitivity.default("public"),
    example: z.unknown().optional(),
  })
  .strict();

export const OutputSpec = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    type: z.enum(["string", "number", "boolean", "currency", "date"]),
    description: z.string(),
    required: z.boolean().default(true),
    sensitivity: Sensitivity.default("public"),
    source: z
      .object({
        kind: z.enum(["text_of", "attribute_of", "url_capture"]),
        target: TargetDescriptor.optional(),
        attribute: z.string().optional(),
        urlPattern: z.string().optional(),
        transform: z
          .enum(["none", "trim", "digits_only", "currency_to_number", "upper", "lower"])
          .default("trim"),
      })
      .strict(),
  })
  .strict();
