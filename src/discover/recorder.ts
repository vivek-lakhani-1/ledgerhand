import fs from "node:fs";
import path from "node:path";
import {
  Capability,
  Checkpoint as CheckpointSchema,
  OutputSpec as OutputSpecSchema,
  ParamSpec as ParamSpecSchema,
  RecoveryRule as RecoveryRuleSchema,
  TargetDescriptor as TargetDescriptorSchema,
  type Capability as CapabilityValue,
  type Checkpoint,
  type OutputSpec,
  type ParamSpec,
  type RecoveryRule,
  type TargetDescriptor,
} from "../schema/index.js";
import { lintCapability } from "../schema/lint.js";
import type { PolicyEngine } from "../policy/policy.js";
import { classifyRisk } from "../policy/risk.js";
import type { Surface, Observation } from "../surface/types.js";
import type { RunLogger } from "../evidence/logger.js";
import type { DiscoveryFinish, DiscoveryTraceEntry } from "./agent.js";

export type RecorderOptions = {
  trace: readonly DiscoveryTraceEntry[];
  goal: string;
  entryUrl: string;
  inputs: Record<string, unknown>;
  inputDeclarations?: readonly ParamSpec[];
  finish?: DiscoveryFinish;
  surface?: Surface;
  policy?: PolicyEngine;
  runId?: string;
  model?: string;
  name?: string;
  title?: string;
  version?: string;
  app?: string;
  surfaceSignature?: Record<string, string>;
  outputs?: readonly OutputSpec[];
  logger?: Pick<RunLogger, "emit">;
  substitutionLog?: string[];
  /** Env-var names the run's credentials came from; declared on the artifact and used by the re-sign-on recovery. */
  secretNames?: string[];
  onSubstitution?: (message: string) => void;
};

export class RecorderValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super("Capability recording failed:\n" + problems.map((problem) => "- " + problem).join("\n"));
    this.name = "RecorderValidationError";
    this.problems = problems;
  }
}

type RecordedOutput = {
  name: string;
  type: OutputSpec["type"];
  description: string;
  transform: OutputSpec["source"]["transform"];
  target?: TargetDescriptor;
};

const stateChangingTools = new Set(["click", "type_text", "select_option", "press_key", "navigate"]);
const compilableTools = new Set(["click", "type_text", "select_option", "press_key", "navigate", "extract"]);

export function recordCapability(options: RecorderOptions): CapabilityValue {
  const declarations = collectInputDeclarations(options);
  const inputs = declarations.map((declaration) => ParamSpecSchema.parse(
    declaration.sensitivity === "secret" ? { ...declaration, example: undefined } : declaration,
  ));
  const inputMap = new Map(inputs.map((input) => [input.name, input]));
  const substitutions: string[] = [];
  const retained = retainTraceEntries(options.trace);
  const outputMap = new Map<string, RecordedOutput>();

  for (const supplied of options.outputs ?? []) {
    outputMap.set(supplied.name, {
      name: supplied.name,
      type: supplied.type,
      description: supplied.description,
      transform: supplied.source.transform,
      target: supplied.source.target,
    });
  }
  for (const entry of retained) {
    if (entry.tool !== "extract") continue;
    const name = stringArg(entry.args, "outputName");
    if (!name || !entry.descriptor) continue;
    outputMap.set(name, {
      name,
      type: asOutputType(entry.args.type) ?? "string",
      description: stringArg(entry.args, "description") || "Value extracted during discovery",
      transform: asTransform(entry.args.transform) ?? "trim",
      target: entry.descriptor,
    });
  }

  const outputSpecs = [...outputMap.values()].map((output) => OutputSpecSchema.parse({
    name: output.name,
    type: output.type,
    description: output.description,
    required: true,
    sensitivity: "public",
    source: { kind: "text_of", target: output.target, transform: output.transform },
  }));
  const validationOutput = defaultValidationOutput();
  if (!outputSpecs.some((output) => output.name === validationOutput.name)) outputSpecs.push(validationOutput);

  const actionEntries = retained.filter((entry) => compilableTools.has(entry.tool));
  const steps = actionEntries.map((entry, index) => compileStep(entry, index, options.trace, inputMap, options.inputs, substitutions, options));

  const lastObservation = lastObservationOf(options.trace);
  const finishCheckpoint = normalizeCheckpoint(options.finish?.successCriterion);
  if (!finishCheckpoint) throw new RecorderValidationError(["finish.successCriterion is required"]);
  if (!lastObservation || !checkpointHolds(finishCheckpoint, lastObservation)) {
    throw new RecorderValidationError(["finish.successCriterion is not currently true in the final observation"]);
  }

  // A model asked to name the business outcomes it saw will happily declare the happy path as
  // one ("MEMBER_RECORD_RETRIEVED"). Replay checks outcomes before success, so such an outcome
  // permanently shadows success: the capability can never return a typed result. Any declared
  // outcome that is already true in the final, successful observation is therefore not a
  // business outcome, and is dropped with a recorded reason rather than trusted.
  const declaredOutcomes = collectDeclaredOutcomes(options.trace);
  const shadowsSuccess = declaredOutcomes.filter((outcome) => checkpointHolds(outcome.detect, lastObservation));
  for (const outcome of shadowsSuccess) {
    substitutions.push(
      `dropped declared outcome ${outcome.code}: its detection condition is already true in the successful end state, so it would shadow success`,
    );
    options.logger?.emit("recorder.outcome_dropped", { code: outcome.code, reason: "shadows_success" });
  }

  const outcomes = [
    ...declaredOutcomes.filter((outcome) => !shadowsSuccess.includes(outcome)),
    ...defaultOutcomes(outputSpecs),
  ].filter((outcome, index, all) => all.findIndex((candidate) => candidate.code === outcome.code) === index);
  // The step that lands on the page holding the data should assert that the page's STRUCTURE
  // is there, not the values it happens to show. A model naturally asserts what it can see
  // ("Ada Exampleton"), which over-fits the artifact to the record it was recorded against and
  // fails for every other member. Assert the extraction target instead - reaching the cell is
  // the real precondition for extracting from it, and it is member-independent.
  const dataTarget = outputSpecs.find((output) => output.source.target)?.source.target;
  const lastStateChanging = [...steps].reverse().find((step) => step.postcondition && step.action.type !== "type" && step.action.type !== "select");
  if (dataTarget && lastStateChanging && lastStateChanging.postcondition?.kind === "text_present") {
    substitutions.push(
      `replaced step ${lastStateChanging.id} postcondition text_present "${lastStateChanging.postcondition.text}" with control_present on the extraction target; asserting extracted data over-fits the artifact to the record it was recorded on`,
    );
    lastStateChanging.postcondition = CheckpointSchema.parse({
      kind: "control_present",
      target: dataTarget,
      description: "the page holding the extracted data has loaded",
    });
  }

  // Same reasoning for the success condition. A model asked "how would you know this worked?"
  // answers with what it can see - here the literal row "90000001 | Savings | Open | 1250.75",
  // which is true for exactly one member and one balance. For a capability that returns data,
  // success means reaching the state that holds the declared outputs, so assert that instead.
  let successCheckpoint = finishCheckpoint;
  if (dataTarget && successCheckpoint.kind === "text_present") {
    substitutions.push(
      `replaced successCheckpoint text_present "${successCheckpoint.text}" with control_present on the extraction target; the model's criterion asserted record-specific data and would only hold for the run it was recorded on`,
    );
    successCheckpoint = CheckpointSchema.parse({
      kind: "control_present",
      target: dataTarget,
      description: "the declared outputs are present and extractable",
    });
  }

  const stepsHighestRisk = highestStepRisk(steps);
  const policyConfig = options.policy?.config;
  const origin = new URL(options.entryUrl).origin;
  const viewport = lastObservation?.viewport ?? { width: 1280, height: 900 };
  const raw: unknown = {
    schemaVersion: "1.0.0",
    id: "cap_" + (options.name ?? capabilityName(options.goal)).replaceAll(".", "_"),
    name: options.name ?? capabilityName(options.goal),
    title: options.title ?? titleFromName(options.name ?? capabilityName(options.goal)),
    version: options.version ?? "1.0.0",
    description: options.goal,
    approval: "draft",
    target: {
      surface: options.surface?.kind ?? "legacy-web",
      app: options.app ?? "meridian-msc",
      tenant: null,
      entryUrl: parameterizeUrl(options.entryUrl, options.inputs, inputMap, substitutions, options),
      viewport,
    },
    inputs,
    outputs: outputSpecs,
    secretsRequired: options.secretNames?.length ? options.secretNames : ["APP_USER", "APP_PASSWORD"],
    steps,
    outcomes,
    recoveries: defaultRecoveries(options.entryUrl, options.secretNames),
    successCheckpoint,
    policy: {
      allowedOrigins: policyConfig?.allowedOrigins?.length ? policyConfig.allowedOrigins : [origin],
      allowedPathPatterns: policyConfig?.allowedPathPatterns ?? ["/**"],
      allowedActions: policyConfig?.allowedActions ?? ["navigate", "click", "type", "select", "press", "wait", "extract", "assert"],
      maxRisk: maxRisk(stepsHighestRisk, policyConfig?.maxRisk ?? "safe"),
      requireApprovalFor: policyConfig?.requireApprovalFor ?? ["irreversible"],
      maxSteps: policyConfig?.maxSteps ?? 60,
      timeoutMs: policyConfig?.timeoutMs ?? 120000,
    },
    provenance: {
      recordedAt: new Date().toISOString(),
      goal: options.goal,
      model: options.model ?? "claude-opus-5",
      discoveryRunId: options.runId ?? "discovery-unknown",
      surfaceSignature: options.surfaceSignature ?? {
        browser: "playwright",
        surface: options.surface?.kind ?? "legacy-web",
        viewport: viewport.width + "x" + viewport.height,
        finalTitle: lastObservation?.title ?? "",
      },
      llmStepCount: options.trace.length,
    },
    stability: {},
    tenantOverrides: {},
  };

  for (const substitution of substitutions) logSubstitution(substitution, options);
  const parsed = Capability.safeParse(raw);
  if (!parsed.success) {
    throw new RecorderValidationError(parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message));
  }
  const problems = lintCapability(parsed.data);
  if (problems.length > 0) throw new RecorderValidationError(problems);
  return parsed.data;
}

export const compileCapability = recordCapability;
export const traceToCapability = recordCapability;

export function writeCapability(capability: CapabilityValue, dir: string): string {
  const destinationDir = path.join(dir, "capabilities");
  fs.mkdirSync(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, capability.name + ".v" + capability.version + ".json");
  fs.writeFileSync(destination, JSON.stringify(capability, null, 2) + "\n", "utf8");
  return destination;
}

function collectInputDeclarations(options: RecorderOptions): ParamSpec[] {
  const declarations = new Map<string, ParamSpec>();
  for (const declaration of options.inputDeclarations ?? []) declarations.set(declaration.name, declaration);
  for (const entry of options.trace) {
    if (entry.tool !== "declare_input") continue;
    const name = stringArg(entry.args, "name");
    const type = entry.args.type;
    const description = stringArg(entry.args, "description");
    const sensitivity = entry.args.sensitivity;
    if (!name || !description || !isInputType(type) || !isSensitivity(sensitivity)) continue;
    declarations.set(name, {
      name,
      type,
      required: true,
      description,
      sensitivity,
      ...(sensitivity === "secret" ? {} : entry.args.example !== undefined ? { example: entry.args.example } : {}),
    });
  }
  return [...declarations.values()];
}

function collectDeclaredOutcomes(trace: readonly DiscoveryTraceEntry[]): Array<{
  code: string;
  description: string;
  detect: Checkpoint;
  terminal: boolean;
  outputs: OutputSpec[];
}> {
  return trace
    .filter((entry) => entry.tool === "declare_outcome")
    .map((entry) => {
      const code = stringArg(entry.args, "code");
      const description = stringArg(entry.args, "description");
      const detectText = stringArg(entry.args, "detectText");
      return {
        code,
        description,
        detect: CheckpointSchema.parse({ kind: "text_present", text: detectText, match: "contains" }),
        terminal: true,
        outputs: [],
      };
    })
    .filter((outcome) => Boolean(outcome.code && outcome.description));
}

function defaultOutcomes(outputs: OutputSpec[]): Array<{
  code: string;
  description: string;
  detect: Checkpoint;
  terminal: boolean;
  outputs: OutputSpec[];
}> {
  const validation = outputs.find((output) => output.name === "validationMessage");
  return [
    {
      code: "MEMBER_NOT_FOUND",
      description: "No member record was found for the requested identifier.",
      detect: CheckpointSchema.parse({ kind: "text_present", text: "No member record found", match: "contains" }),
      terminal: true,
      outputs: [],
    },
    {
      code: "PERMISSION_DENIED",
      description: "The operator is not authorized to view the requested account.",
      detect: CheckpointSchema.parse({ kind: "text_present", text: "not authorized to view", match: "contains" }),
      terminal: true,
      outputs: [],
    },
    {
      code: "VALIDATION_ERROR",
      description: "The target application rejected an input value.",
      detect: CheckpointSchema.parse({ kind: "text_present", text: "must be at least", match: "contains" }),
      terminal: true,
      outputs: validation ? [validation] : [],
    },
  ];
}

function defaultRecoveries(entryUrl: string, secretNames?: string[]): RecoveryRule[] {
  const [userSecret = "APP_USER", passwordSecret = "APP_PASSWORD"] = secretNames ?? [];
  const continueTarget = TargetDescriptorSchema.parse({
    role: "button",
    name: "Continue",
    framePath: ["content"],
    strategies: [
      { kind: "aria", role: "button", name: "Continue", exact: true, confidence: 0.95, origin: "captured" },
      { kind: "text", text: "Continue", exact: true, confidence: 0.8, origin: "derived" },
    ],
    description: "Continue past the maintenance interstitial",
  });
  const userTarget = loginTarget("u", "Operator ID");
  const passwordTarget = loginTarget("p", "Password");
  const signOnTarget = TargetDescriptorSchema.parse({
    role: "button",
    name: "Sign On",
    framePath: [],
    strategies: [{ kind: "aria", role: "button", name: "Sign On", exact: true, confidence: 0.95, origin: "captured" }],
    description: "Sign in to the operator console",
  });
  return [
    RecoveryRuleSchema.parse({
      id: "dismiss_interstitial",
      description: "Dismiss a system maintenance notice and retry the step.",
      when: { kind: "text_present", text: "SYSTEM MAINTENANCE NOTICE", match: "contains" },
      do: [{ type: "click", target: continueTarget }],
      maxAttempts: 2,
      thenRetryStep: true,
    }),
    RecoveryRuleSchema.parse({
      id: "reauthenticate",
      description: "Return to the login page, reauthenticate, and retry the step.",
      when: { kind: "text_present", text: "Your session has expired", match: "contains" },
      do: [
        { type: "navigate", url: entryUrl },
        { type: "type", target: userTarget, value: `{{secrets.${userSecret}}}`, clearFirst: true },
        { type: "type", target: passwordTarget, value: `{{secrets.${passwordSecret}}}`, clearFirst: true },
        { type: "click", target: signOnTarget },
      ],
      maxAttempts: 1,
      thenRetryStep: true,
    }),
  ];
}

function defaultValidationOutput(): OutputSpec {
  const target = TargetDescriptorSchema.parse({
    role: "generic",
    framePath: ["content"],
    strategies: [{ kind: "css", selector: "body", confidence: 0.4, origin: "derived" }],
    description: "Validation message text",
  });
  return OutputSpecSchema.parse({
    name: "validationMessage",
    type: "string",
    description: "The validation message returned by the target application.",
    required: true,
    sensitivity: "public",
    source: { kind: "text_of", target, transform: "trim" },
  });
}

function loginTarget(name: string, nearbyText: string): TargetDescriptor {
  return TargetDescriptorSchema.parse({
    role: "textbox",
    framePath: [],
    strategies: [{ kind: "attribute", attr: "name", value: name, confidence: 0.7, origin: "captured" }],
    description: nearbyText + " login field",
  });
}

function compileStep(entry: DiscoveryTraceEntry, index: number, entries: readonly DiscoveryTraceEntry[], inputMap: Map<string, ParamSpec>, suppliedInputs: Record<string, unknown>, substitutions: string[], options: RecorderOptions): CapabilityValue["steps"][number] {
  const action = compileAction(entry, inputMap, suppliedInputs, substitutions, options);
  const risk = classifyRisk(action, entry.descriptor?.name);
  const stateChanging = stateChangingTools.has(entry.tool);
  // Typing does not change page text, so any text_present checkpoint observed around a type
  // action necessarily describes a LATER state - the one reached after the subsequent submit.
  // Inheriting it here shifts every checkpoint back one step and the artifact fails on the
  // very page it was recorded against. A type step asserts only that its field is still
  // there to have been typed into; the navigation assertion belongs to the click that causes
  // the navigation.
  const checkpoint = !stateChanging
    ? undefined
    : action.type === "type" || action.type === "select"
      ? fieldPresentCheckpoint(action)
      : entry.checkpointAsserted ?? checkpointAfter(entry, entries) ?? synthesizePostcondition(entry);
  if (stateChanging && !checkpoint) throw new RecorderValidationError(["step " + index + " has no postcondition"]);
  return {
    id: "s" + (index + 1),
    description: entry.why || entry.descriptor?.description || entry.tool,
    action,
    risk,
    preconditions: [],
    ...(checkpoint ? { postcondition: checkpoint } : {}),
    timeoutMs: 15000,
    retries: { max: 0, backoffMs: 500 },
    recover: [],
    onFailure: "fail",
  };
}

function compileAction(entry: DiscoveryTraceEntry, inputMap: Map<string, ParamSpec>, suppliedInputs: Record<string, unknown>, substitutions: string[], options: RecorderOptions): CapabilityValue["steps"][number]["action"] {
  if (entry.tool === "navigate") {
    return { type: "navigate", url: parameterizeUrl(stringArg(entry.args, "url"), suppliedInputs, inputMap, substitutions, options) };
  }
  if (!entry.descriptor && entry.tool !== "press_key") throw new RecorderValidationError(["tool " + entry.tool + " at trace seq " + entry.seq + " has no captured descriptor"]);
  if (entry.tool === "click") return { type: "click", target: requireDescriptor(entry) };
  if (entry.tool === "type_text") {
    return { type: "type", target: requireDescriptor(entry), value: parameterizeLiteral(stringArg(entry.args, "text"), suppliedInputs, inputMap, substitutions, options), clearFirst: true };
  }
  if (entry.tool === "select_option") {
    return { type: "select", target: requireDescriptor(entry), value: parameterizeLiteral(stringArg(entry.args, "value"), suppliedInputs, inputMap, substitutions, options) };
  }
  if (entry.tool === "press_key") return { type: "press", key: stringArg(entry.args, "key"), ...(entry.descriptor ? { target: entry.descriptor } : {}) };
  if (entry.tool === "extract") return { type: "extract", outputs: [stringArg(entry.args, "outputName")] };
  throw new RecorderValidationError(["unsupported trace tool " + entry.tool]);
}

/**
 * Postcondition for a field-filling step: the field it targeted is present. Weak by design -
 * the strong assertion belongs to the action that actually changes state.
 */
function fieldPresentCheckpoint(action: { type: string; target?: unknown }): Checkpoint {
  return CheckpointSchema.parse({
    kind: "control_present",
    target: action.target,
    description: "the field that was filled is present",
  });
}

function checkpointAfter(entry: DiscoveryTraceEntry, entries: readonly DiscoveryTraceEntry[]): Checkpoint | undefined {
  const start = entries.indexOf(entry) + 1;
  for (let index = start; index < entries.length; index += 1) {
    const candidate = entries[index];
    if (compilableTools.has(candidate.tool)) break;
    if (candidate.tool === "assert_checkpoint" && candidate.checkpointAsserted) return candidate.checkpointAsserted;
  }
  return undefined;
}

function synthesizePostcondition(entry: DiscoveryTraceEntry): Checkpoint {
  const before = entry.observationBefore;
  const after = entry.observationAfter;
  for (const frame of after.frames) {
    const beforeText = before.frames.find((candidate) => samePath(candidate.path, frame.path))?.text ?? "";
    const newLine = frame.text.split(/\n+/).map((line) => line.trim()).find((line) => line && !beforeText.includes(line));
    if (newLine) return CheckpointSchema.parse({ kind: "text_present", text: newLine, match: "contains", framePath: frame.path });
  }
  if (entry.urlAfter !== entry.urlBefore) return CheckpointSchema.parse({ kind: "url_matches", pattern: "^" + escapeRegex(entry.urlAfter) + "$" });
  if (after.title !== before.title) return CheckpointSchema.parse({ kind: "title_matches", pattern: "^" + escapeRegex(after.title) + "$" });
  if (entry.descriptor) return CheckpointSchema.parse({ kind: "control_present", target: entry.descriptor });
  const fallback = after.frames.flatMap((frame) => frame.text.split(/\n+/).map((line) => line.trim())).find(Boolean) ?? after.title;
  return CheckpointSchema.parse({ kind: "text_present", text: fallback || after.url, match: "contains" });
}

function retainTraceEntries(trace: readonly DiscoveryTraceEntry[]): DiscoveryTraceEntry[] {
  const dead = new Set<number>();
  for (let index = 0; index < trace.length; index += 1) {
    const entry = trace[index];
    if (!compilableTools.has(entry.tool)) continue;
    if (entry.args.deadEnd === true || entry.args.backtracked === true) {
      dead.add(index);
      continue;
    }
    const next = trace[index + 1];
    if (next?.tool === "navigate" && stringArg(next.args, "url") === entry.urlBefore) {
      dead.add(index);
      dead.add(index + 1);
    }
  }
  return trace.filter((entry, index) => compilableTools.has(entry.tool) && !dead.has(index));
}

function normalizeCheckpoint(value: string | Checkpoint | undefined): Checkpoint | undefined {
  if (typeof value === "string" && value.trim()) return CheckpointSchema.parse({ kind: "text_present", text: value, match: "contains" });
  if (value && typeof value === "object") return CheckpointSchema.parse(value);
  return undefined;
}

function checkpointHolds(checkpoint: Checkpoint, observation: Observation): boolean {
  switch (checkpoint.kind) {
    case "text_present": return matchingText(observation, checkpoint.text, checkpoint.match, checkpoint.framePath);
    case "text_absent": return !matchingText(observation, checkpoint.text, checkpoint.match, checkpoint.framePath);
    case "url_matches": return new RegExp(checkpoint.pattern).test(observation.url);
    case "title_matches": return new RegExp(checkpoint.pattern).test(observation.title);
    case "all": return checkpoint.of.every((child) => checkpointHolds(child, observation));
    case "any": return checkpoint.of.some((child) => checkpointHolds(child, observation));
    case "not": return !checkpointHolds(checkpoint.of, observation);
    case "control_present": return observation.frames.some((frame) => frame.controls.some((control) => control.role === checkpoint.target.role && (!checkpoint.target.name || control.name === checkpoint.target.name)));
    case "control_absent": return !checkpointHolds({ kind: "control_present", target: checkpoint.target }, observation);
  }
}

function matchingText(observation: Observation, text: string, match: "exact" | "contains" | "regex", framePath?: string[]): boolean {
  const frames = framePath ? observation.frames.filter((frame) => samePath(frame.path, framePath)) : observation.frames;
  return frames.some((frame) => {
    if (match === "exact") return frame.text.split(/\n+/).some((line) => line.trim() === text);
    if (match === "regex") return new RegExp(text).test(frame.text);
    return frame.text.includes(text);
  });
}

function lastObservationOf(trace: readonly DiscoveryTraceEntry[]): Observation | undefined {
  return trace.length > 0 ? trace[trace.length - 1].observationAfter : undefined;
}

function parameterizeLiteral(value: string, inputs: Record<string, unknown>, inputMap: Map<string, ParamSpec>, substitutions: string[], options: RecorderOptions): string {
  const existing = value.match(/^\{\{\s*inputs\.([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}$/);
  if (existing) {
    if (!inputMap.has(existing[1])) throw new RecorderValidationError(["typed literal references undeclared input " + existing[1]]);
    return "{{inputs." + existing[1] + "}}";
  }
  for (const [name, supplied] of Object.entries(inputs)) {
    if (inputMap.has(name) && String(supplied) === value) {
      const replacement = "{{inputs." + name + "}}";
      substitutions.push("Replaced typed literal " + value + " with " + replacement);
      return replacement;
    }
  }
  return value;
}

function parameterizeUrl(url: string, inputs: Record<string, unknown>, inputMap: Map<string, ParamSpec>, substitutions: string[], options: RecorderOptions): string {
  return url.split("/").map((segment) => {
    for (const [name, supplied] of Object.entries(inputs)) {
      if (!inputMap.has(name)) continue;
      const decoded = decodeURIComponent(segment);
      if (String(supplied) === segment || String(supplied) === decoded) {
        const replacement = "{{inputs." + name + "}}";
        substitutions.push("Replaced URL path segment " + segment + " with " + replacement);
        return replacement;
      }
    }
    return segment;
  }).join("/");
}

function logSubstitution(message: string, options: RecorderOptions): void {
  options.substitutionLog?.push(message);
  options.onSubstitution?.(message);
  options.logger?.emit("action.performed", { origin: "recorder", substitution: message });
}

function requireDescriptor(entry: DiscoveryTraceEntry): TargetDescriptor {
  if (!entry.descriptor) throw new RecorderValidationError(["missing descriptor for trace seq " + entry.seq]);
  return TargetDescriptorSchema.parse(entry.descriptor);
}

function highestStepRisk(steps: CapabilityValue["steps"]): "safe" | "sensitive" | "irreversible" {
  return steps.reduce<"safe" | "sensitive" | "irreversible">((highest, step) => maxRisk(highest, step.risk), "safe");
}

function maxRisk(left: "safe" | "sensitive" | "irreversible", right: "safe" | "sensitive" | "irreversible"): "safe" | "sensitive" | "irreversible" {
  const rank = { safe: 0, sensitive: 1, irreversible: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function capabilityName(goal: string): string {
  const words = goal.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 4);
  const name = words.join(".");
  return name && /^[a-z]/.test(name) ? name : "discovered.capability";
}

function titleFromName(name: string): string {
  return name.split(".").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key] : "";
}

function asOutputType(value: unknown): OutputSpec["type"] | undefined {
  return ["string", "number", "boolean", "currency", "date"].includes(String(value)) ? value as OutputSpec["type"] : undefined;
}

function asTransform(value: unknown): OutputSpec["source"]["transform"] | undefined {
  return ["none", "trim", "digits_only", "currency_to_number", "upper", "lower"].includes(String(value)) ? value as OutputSpec["source"]["transform"] : undefined;
}

function isInputType(value: unknown): value is ParamSpec["type"] {
  return ["string", "number", "boolean", "date", "enum"].includes(String(value));
}

function isSensitivity(value: unknown): value is ParamSpec["sensitivity"] {
  return ["public", "pii", "secret"].includes(String(value));
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\\]{}|]/g, "\\$&");
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
