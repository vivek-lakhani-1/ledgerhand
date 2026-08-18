import type { Capability, ParamSpec } from "../schema/index.js";

export type TemplateContext = {
  inputs: Record<string, unknown>;
  /** The namespace is intentionally present in the context type for callers, but secrets are read from process.env. */
  secrets: Record<string, unknown>;
  env: Record<string, string | undefined>;
};

export class TemplateError extends Error {
  readonly errorClass = "INPUT_INVALID" as const;
  readonly namespace: "inputs" | "secrets" | "env" | "unknown";
  readonly key: string;

  constructor(namespace: "inputs" | "secrets" | "env" | "unknown", key: string) {
    super(`Missing template reference ${namespace}.${key}`);
    this.name = "TemplateError";
    this.namespace = namespace;
    this.key = key;
  }
}

export type InputIssue = { field: string; message: string };

export class InputValidationError extends Error {
  readonly errorClass = "INPUT_INVALID" as const;
  readonly issues: InputIssue[];

  constructor(issues: InputIssue[]) {
    super(issues.map((issue) => `${issue.field}: ${issue.message}`).join("; "));
    this.name = "InputValidationError";
    this.issues = issues;
  }
}

const referencePattern = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Resolve only the three reviewable namespaces in the artifact DSL. Secret values are
 * deliberately read at substitution time rather than copied into a capability or context
 * snapshot. The executor registers them with its Redactor before calling this function.
 */
export function resolveTemplate(str: string, ctx: TemplateContext): string {
  return str.replace(referencePattern, (_whole, rawNamespace: string, key: string) => {
    if (rawNamespace !== "inputs" && rawNamespace !== "secrets" && rawNamespace !== "env") {
      throw new TemplateError("unknown", `${rawNamespace}.${key}`);
    }

    let value: unknown;
    if (rawNamespace === "inputs") {
      value = ctx.inputs[key];
    } else if (rawNamespace === "secrets") {
      // ctx.secrets is a declaration/context slot, not the source of truth. Reading process.env
      // here makes a rotated credential visible on the next replay without persisting it.
      value = process.env[key];
    } else {
      value = Object.prototype.hasOwnProperty.call(ctx.env, key) ? ctx.env[key] : process.env[key];
    }

    if (value === undefined || value === null) throw new TemplateError(rawNamespace, key);
    return String(value);
  });
}

export function resolveTemplatesIn<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === "string") return resolveTemplate(value, ctx) as T;
  if (Array.isArray(value)) return value.map((item) => resolveTemplatesIn(item, ctx)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveTemplatesIn(item, ctx)]),
    ) as T;
  }
  return value;
}

export function validateInputs(cap: Capability, rawInputs: Record<string, unknown>): Record<string, unknown> {
  const issues: InputIssue[] = [];
  const validated: Record<string, unknown> = {};
  const known = new Set(cap.inputs.map((spec) => spec.name));

  for (const key of Object.keys(rawInputs)) {
    if (!known.has(key)) issues.push({ field: key, message: "is not declared by the capability" });
  }

  for (const spec of cap.inputs) {
    const raw = rawInputs[spec.name];
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
      if (spec.required) issues.push({ field: spec.name, message: "is required" });
      continue;
    }

    try {
      const value = coerceInput(spec, raw);
      if (spec.pattern) {
        const pattern = new RegExp(spec.pattern);
        if (!pattern.test(String(value))) {
          issues.push({ field: spec.name, message: `does not match pattern ${spec.pattern}` });
          continue;
        }
      }
      validated[spec.name] = value;
    } catch (error) {
      issues.push({ field: spec.name, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (issues.length > 0) throw new InputValidationError(issues);
  return validated;
}

function coerceInput(spec: ParamSpec, raw: unknown): unknown {
  switch (spec.type) {
    case "string":
      return String(raw);
    case "number": {
      const value = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(value)) throw new Error("must be a finite number");
      return value;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      const normalized = String(raw).trim().toLowerCase();
      if (normalized === "true" || normalized === "1") return true;
      if (normalized === "false" || normalized === "0") return false;
      throw new Error('must be a boolean (true/false)');
    }
    case "date": {
      const value = String(raw).trim();
      if (Number.isNaN(Date.parse(value))) throw new Error("must be a valid date");
      return value;
    }
    case "enum": {
      const value = String(raw);
      if (!spec.enumValues?.includes(value)) {
        throw new Error(`must be one of ${spec.enumValues?.join(", ") ?? "the declared enum values"}`);
      }
      return value;
    }
  }
}
