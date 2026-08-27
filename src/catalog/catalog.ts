import fs from "node:fs";
import path from "node:path";
import type { ReplayOptions } from "../replay/executor.js";
import { replay } from "../replay/executor.js";
import { Capability, type Capability as CapabilityValue, type OutputSpec, type ParamSpec, type ReplayResult } from "../schema/index.js";
import { lintCapability } from "../schema/lint.js";

export type CatalogIssue = {
  file: string;
  error: string;
  problems?: string[];
};

export type CatalogListItem = Pick<CapabilityValue, "name" | "version" | "title" | "description" | "approval" | "inputs" | "outputs" | "stability">;

export type AnthropicToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: false;
  };
};

export type CatalogInvokeOptions = Omit<ReplayOptions, "inputs">;

export class CapabilityCatalog {
  private readonly capabilities = new Map<string, CapabilityValue>();
  readonly invalid: readonly CatalogIssue[];

  constructor(capabilities: CapabilityValue[], invalid: CatalogIssue[] = []) {
    for (const capability of capabilities) {
      if (this.capabilities.has(capability.name)) {
        invalid.push({
          file: `<duplicate:${capability.name}>`,
          error: `Duplicate capability name ${capability.name}`,
        });
        continue;
      }
      this.capabilities.set(capability.name, capability);
    }
    this.invalid = invalid;
  }

  /** Alias that makes CLI/reporting callers read naturally. */
  get issues(): readonly CatalogIssue[] {
    return this.invalid;
  }

  list(): CatalogListItem[] {
    return [...this.capabilities.values()].map((capability) => ({
      name: capability.name,
      version: capability.version,
      title: capability.title,
      description: capability.description,
      approval: capability.approval,
      inputs: capability.inputs,
      outputs: capability.outputs,
      stability: capability.stability,
    }));
  }

  describe(name: string): CapabilityValue {
    const capability = this.capabilities.get(name);
    if (!capability) {
      throw new Error(`Capability ${name} was not found in the catalog`);
    }
    return capability;
  }

  toToolSchemas(options: { includeDraft?: boolean } = {}): AnthropicToolDefinition[] {
    return [...this.capabilities.values()]
      .filter((capability) => options.includeDraft === true || capability.approval !== "draft")
      .map((capability) => ({
        name: toolNameFor(capability.name),
        description: toolDescription(capability),
        input_schema: {
          type: "object" as const,
          properties: Object.fromEntries(capability.inputs.map((input) => [input.name, paramSchema(input)])),
          required: capability.inputs.filter((input) => input.required).map((input) => input.name),
          additionalProperties: false as const,
        },
      }));
  }

  async invoke(name: string, args: Record<string, unknown>, options: CatalogInvokeOptions): Promise<ReplayResult> {
    return replay(this.describe(name), { ...options, inputs: args });
  }
}

export function loadCatalog(dir = "capabilities"): CapabilityCatalog {
  const capabilities: CapabilityValue[] = [];
  const invalid: CatalogIssue[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    invalid.push({ file: path.resolve(dir), error: error instanceof Error ? error.message : String(error) });
    return new CapabilityCatalog(capabilities, invalid);
  }

  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      invalid.push({ file, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const parsed = Capability.safeParse(raw);
    if (!parsed.success) {
      invalid.push({ file, error: parsed.error.message });
      continue;
    }
    const problems = lintCapability(parsed.data);
    if (problems.length > 0) {
      invalid.push({ file, error: "Capability lint failed", problems });
      continue;
    }
    capabilities.push(parsed.data);
  }

  return new CapabilityCatalog(capabilities, invalid);
}

/**
 * Capability names are dotted; the Anthropic API only accepts tool names matching
 * ^[a-zA-Z0-9_-]{1,128}$. The mapping must be reversible so a tool call can be routed back to
 * its capability, and capability names cannot contain "__" (the name pattern has no way to
 * produce one from a single separator), so the substitution cannot collide.
 */
export function toolNameFor(capabilityName: string): string {
  return capabilityName.replaceAll(".", "__");
}

export function capabilityNameForTool(toolName: string): string {
  return toolName.replaceAll("__", ".");
}

function paramSchema(input: ParamSpec): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: input.type === "date" || input.type === "enum" ? "string" : input.type,
    description: input.description,
  };
  if (input.enumValues) schema.enum = input.enumValues;
  if (input.pattern) schema.pattern = input.pattern;
  return schema;
}

function toolDescription(capability: CapabilityValue): string {
  const outputContract = capability.outputs.length === 0
    ? "Returns no declared outputs."
    : `Returns:\n${capability.outputs.map((output: OutputSpec) => `- ${output.name} (${output.type}): ${output.description}${output.required ? " [required]" : " [optional]"}`).join("\n")}`;
  return `${capability.description}\n\n${outputContract}`;
}
