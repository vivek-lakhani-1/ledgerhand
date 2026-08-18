import { z } from "zod";

export const ControlRole = z.enum([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "option",
  "cell",
  "row",
  "heading",
  "image",
  "text",
  "frame",
  "generic",
]);

export const ResolutionStrategy = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("aria"),
        role: ControlRole,
        name: z.string(),
        exact: z.boolean(),
      })
      .strict(),
    z.object({ kind: z.literal("label"), text: z.string() }).strict(),
    z.object({ kind: z.literal("placeholder"), text: z.string() }).strict(),
    z
      .object({ kind: z.literal("text"), text: z.string(), exact: z.boolean() })
      .strict(),
    z
      .object({
        kind: z.literal("table_cell"),
        rowMatch: z.string(),
        columnHeader: z.string(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("attribute"),
        attr: z.enum(["name", "id", "title", "alt", "value", "href", "type"]),
        value: z.string(),
      })
      .strict(),
    z.object({ kind: z.literal("css"), selector: z.string() }).strict(),
    z
      .object({ kind: z.literal("nth_of_role"), role: ControlRole, index: z.number().int() })
      .strict(),
    z
      .object({
        kind: z.literal("coordinate"),
        x: z.number(),
        y: z.number(),
        viewport: z.object({ width: z.number(), height: z.number() }).strict(),
      })
      .strict(),
  ])
  .and(
    z
      .object({
        confidence: z.number().min(0).max(1),
        origin: z.enum(["captured", "derived"]),
      })
      .strict(),
  );

export const TargetDescriptor = z
  .object({
    role: ControlRole,
    name: z.string().optional(),
    nameMatch: z.enum(["exact", "contains", "regex"]).default("exact"),
    labelText: z.string().optional(),
    framePath: z.array(z.string()).default([]),
    scope: z
      .object({
        withinRowMatching: z.string().optional(),
        columnHeader: z.string().optional(),
        nth: z.number().int().optional(),
      })
      .strict()
      .optional(),
    strategies: z.array(ResolutionStrategy).min(1),
    description: z.string().optional(),
  })
  .strict();
