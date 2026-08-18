import type { MessageParam, ToolUseBlock, ModelClient } from "./model.js";
import type { EvidenceDir } from "../evidence/evidence.js";
import type { RunLogger } from "../evidence/logger.js";
import { PolicyEngine } from "../policy/policy.js";
import { Redactor } from "../policy/redact.js";
import { classifyRisk } from "../policy/risk.js";
import type { Action, Checkpoint, ParamSpec, TargetDescriptor } from "../schema/index.js";
import type { Observation, PerceivedControl, Surface } from "../surface/types.js";
import { buildDiscoveryPrompt } from "./prompt.js";
import { discoveryTools } from "./tools.js";

export type DiscoveryTraceEntry = {
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  why: string;
  descriptor?: TargetDescriptor;
  urlBefore: string;
  urlAfter: string;
  observationBefore: Observation;
  observationAfter: Observation;
  checkpointAsserted?: Checkpoint;
};

export type DiscoveryFinish = {
  summary: string;
  successCriterion: string | Checkpoint;
};

export type DiscoveryResult = {
  status: "completed" | "escalated" | "stopped";
  trace: DiscoveryTraceEntry[];
  finish?: DiscoveryFinish;
  runId: string;
  reason?: string;
  inputs: ParamSpec[];
  outputs: Array<{
    name: string;
    type: "string" | "number" | "boolean" | "currency" | "date";
    description: string;
    transform: "none" | "trim" | "digits_only" | "currency_to_number" | "upper" | "lower";
    target?: TargetDescriptor;
  }>;
  outcomes: Array<{ code: string; description: string; detectText: string }>;
};

export type DiscoveryOptions = {
  goal: string;
  entryUrl: string;
  inputs: Record<string, unknown>;
  surface: Surface;
  policy: PolicyEngine;
  logger: RunLogger;
  evidence: EvidenceDir;
  model: ModelClient;
  maxSteps?: number;
};

type RefCaptureSurface = Surface & {
  captureDescriptorForRef?: (ref: string, observation: Observation) => Promise<TargetDescriptor | null>;
};

type ToolResult = {
  ok: boolean;
  [key: string]: unknown;
};

type ExecutionResult = {
  result: ToolResult;
  observation?: Observation;
  traceEntry?: DiscoveryTraceEntry;
  stop?: boolean;
  status?: "completed" | "escalated";
  reason?: string;
};

const actionTools = new Set(["click", "type_text", "select_option", "press_key", "navigate", "extract"]);
const stateChangingTools = new Set(["click", "type_text", "select_option", "press_key", "navigate"]);
const inputReference = /\{\{\s*inputs\.([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
const secretReference = /\{\{\s*secrets\.([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const runId = options.logger.runId;
  const maxSteps = options.maxSteps ?? 25;
  const trace: DiscoveryTraceEntry[] = [];
  const declaredInputs = new Map<string, ParamSpec>();
  const declaredOutputs = new Map<string, DiscoveryResult["outputs"][number]>();
  const declaredOutcomes = new Map<string, DiscoveryResult["outcomes"][number]>();
  const messages: MessageParam[] = [];
  const transcript: string[] = [];
  const redactor = new Redactor({ secrets: [], piiValues: [] });
  const deadline = Date.now() + options.policy.config.timeoutMs;
  let currentObservation: Observation;
  let noProgressCount = 0;
  let previousObservationSignature = "";
  let acceptedCalls = 0;
  let finish: DiscoveryFinish | undefined;
  let result: DiscoveryResult | undefined;

  for (const key of ["APP_USER", "APP_PASSWORD"]) {
    const value = process.env[key];
    if (!value) continue;
    redactor.registerSecret(value);
    options.logger.registerSecret(value);
    options.evidence.registerSecret(value);
  }

  const resultBase = (): Omit<DiscoveryResult, "status" | "trace" | "runId"> => ({
    inputs: [...declaredInputs.values()],
    outputs: [...declaredOutputs.values()],
    outcomes: [...declaredOutcomes.values()],
  });
  const finishRun = (next: DiscoveryResult): DiscoveryResult => {
    result = next;
    return next;
  };

  try {
    options.logger.emit("run.start", { origin: "discovery", goal: options.goal, entryUrl: options.entryUrl });
    const currentUrl = await options.surface.url();
    if (currentUrl !== options.entryUrl) {
      const entryAction: Action = { type: "navigate", url: options.entryUrl };
      const entryDecision = options.policy.check(entryAction, {
        resolvedUrl: options.entryUrl,
        risk: "safe",
        mode: "discovery",
      });
      if (entryDecision.decision !== "allow") {
        return finishRun({
          ...resultBase(),
          status: "stopped",
          trace,
          runId,
          reason: "Entry URL denied by policy: " + entryDecision.reason,
        });
      }
      await options.surface.act(entryAction, { risk: "safe", mode: "discovery" });
    }

    currentObservation = await options.surface.observe();
    previousObservationSignature = observationSignature(currentObservation);
    messages.push(observationMessage(currentObservation));

    while (true) {
      if (Date.now() >= deadline) {
        return finishRun({
          ...resultBase(),
          status: "stopped",
          trace,
          runId,
          reason: "Discovery wall-clock timeout reached",
        });
      }
      if (acceptedCalls >= maxSteps) {
        return finishRun({
          ...resultBase(),
          status: "stopped",
          trace,
          runId,
          reason: "Discovery maxSteps " + maxSteps + " reached",
        });
      }

      let response: Awaited<ReturnType<ModelClient["next"]>>;
      try {
        response = await options.model.next({
          system: buildDiscoveryPrompt({ goal: options.goal, entryUrl: options.entryUrl }),
          messages,
          tools: discoveryTools,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        options.logger.emit("escalation.raised", { origin: "discovery", reason });
        return finishRun({ ...resultBase(), status: "escalated", trace, runId, reason });
      }

      transcript.push(JSON.stringify({ kind: "model.response", stopReason: response.stopReason, content: response.content }));
      messages.push({
        role: "assistant",
        content: response.content as unknown as MessageParam["content"],
      });
      const toolCall = response.content.find((block): block is ToolUseBlock => block.type === "tool_use");
      if (!toolCall) {
        const reason = "The model returned no discovery tool call";
        options.logger.emit("escalation.raised", { origin: "discovery", reason });
        return finishRun({ ...resultBase(), status: "escalated", trace, runId, reason });
      }

      acceptedCalls += 1;
      const args = asArgs(toolCall.input);
      transcript.push(JSON.stringify({ kind: "model.tool_call", id: toolCall.id, name: toolCall.name, input: args }));
      const before = currentObservation;
      const urlBefore = before.url;
      const toolResult = await executeTool(toolCall.name, args, {
        ...options,
        currentObservation: before,
        declaredInputs,
        declaredOutputs,
        declaredOutcomes,
        redactor,
        trace,
        nextSeq: trace.length + 1,
        resolveTemplateValue: (value) => resolveTemplateValue(value, declaredInputs, options.inputs),
        finish: (value) => {
          finish = value;
        },
      });

      if (toolResult.observation) {
        currentObservation = toolResult.observation;
        const nextSignature = observationSignature(currentObservation);
        noProgressCount = nextSignature === previousObservationSignature ? noProgressCount + 1 : 0;
        previousObservationSignature = nextSignature;
      }
      if (toolResult.traceEntry) trace.push(toolResult.traceEntry);
      const modelResult = {
        ...toolResult.result,
        ...(toolResult.observation ? { observation: compactObservation(toolResult.observation, redactor) } : {}),
      };
      transcript.push(JSON.stringify({
        kind: "tool.result",
        id: toolCall.id,
        name: toolCall.name,
        is_error: !toolResult.result.ok,
        result: modelResult,
      }));
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: JSON.stringify(modelResult),
          ...(toolResult.result.ok ? {} : { is_error: true }),
        }],
      });

      if (toolResult.stop) {
        if (toolResult.status === "completed") {
          return finishRun({ ...resultBase(), status: "completed", trace, finish, runId });
        }
        return finishRun({ ...resultBase(), status: "escalated", trace, finish, runId, reason: toolResult.reason });
      }
      if (noProgressCount >= 3) {
        const reason = "Three consecutive observations made no progress: URL and control-name set were unchanged";
        options.logger.emit("escalation.raised", { origin: "discovery", reason });
        return finishRun({ ...resultBase(), status: "escalated", trace, runId, reason });
      }
    }
  } finally {
    options.evidence.writeText("discovery/transcript.jsonl", transcript.join("\n") + (transcript.length > 0 ? "\n" : ""));
    options.logger.emit("run.end", {
      origin: "discovery",
      status: result?.status ?? "stopped",
      traceEntries: trace.length,
    });
  }
}

type ExecutionContext = DiscoveryOptions & {
  currentObservation: Observation;
  declaredInputs: Map<string, ParamSpec>;
  declaredOutputs: Map<string, DiscoveryResult["outputs"][number]>;
  declaredOutcomes: Map<string, DiscoveryResult["outcomes"][number]>;
  redactor: Redactor;
  trace: DiscoveryTraceEntry[];
  nextSeq: number;
  resolveTemplateValue: (value: string) => string;
  finish: (finish: DiscoveryFinish) => void;
};

async function executeTool(name: string, args: Record<string, unknown>, context: ExecutionContext): Promise<ExecutionResult> {
  const before = context.currentObservation;
  const urlBefore = await context.surface.url();
  const why = typeof args.why === "string" ? args.why : "";

  if (name === "observe") {
    const observation = await context.surface.observe();
    return { result: { ok: true, observation: compactObservation(observation) }, observation, traceEntry: makeTrace(context, name, args, why, urlBefore, observation) };
  }

  if (name === "declare_input") {
    const parsed = parseInputDeclaration(args);
    if (!parsed.ok) return errorResult(parsed.message);
    const existing = context.declaredInputs.get(parsed.value.name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed.value)) {
      return errorResult("Input " + parsed.value.name + " was already declared with different metadata");
    }
    context.declaredInputs.set(parsed.value.name, parsed.value);
    const supplied = context.inputs[parsed.value.name];
    if (parsed.value.sensitivity === "secret" && supplied !== undefined) {
      context.redactor.registerSecret(String(supplied));
      context.logger.registerSecret(String(supplied));
      context.evidence.registerSecret(String(supplied));
    }
    if (parsed.value.sensitivity === "pii" && supplied !== undefined) {
      context.logger.registerPii(String(supplied));
      context.evidence.registerPii(String(supplied));
    }
    return { result: { ok: true, input: parsed.value.name }, traceEntry: makeTrace(context, name, args, why, urlBefore, before) };
  }

  if (name === "declare_outcome") {
    const code = stringArg(args, "code");
    const description = stringArg(args, "description");
    const detectText = stringArg(args, "detectText");
    if (!code || !description || !detectText) return errorResult("declare_outcome needs code, description, and detectText");
    context.declaredOutcomes.set(code, { code, description, detectText });
    return { result: { ok: true, code }, traceEntry: makeTrace(context, name, args, why, urlBefore, before) };
  }

  if (name === "assert_checkpoint") {
    const kind = args.kind === "text_absent" || args.kind === "text_present" ? args.kind : null;
    const text = stringArg(args, "text");
    if (!kind || !text) return errorResult("assert_checkpoint needs kind and text");
    const framePath = before.frames.find((frame) => frame.text.includes(text))?.path;
    const checkpoint: Checkpoint = { kind, text, match: "contains", ...(framePath ? { framePath } : {}) };
    const entry = makeTrace(context, name, args, why, urlBefore, before);
    entry.checkpointAsserted = checkpoint;
    attachCheckpointToPreviousAction(context.trace, checkpoint);
    return { result: { ok: true, checkpoint }, traceEntry: entry };
  }

  if (name === "finish") {
    const summary = stringArg(args, "summary");
    const successCriterion = stringArg(args, "successCriterion");
    if (!summary || !successCriterion) return errorResult("finish needs summary and successCriterion");
    if (!observationContains(before, successCriterion)) return errorResult("The successCriterion is not currently visible: " + successCriterion);
    context.finish({ summary, successCriterion });
    return { result: { ok: true, finished: true }, traceEntry: makeTrace(context, name, args, why, urlBefore, before), stop: true, status: "completed" };
  }

  if (name === "request_human_help") {
    const reason = stringArg(args, "reason");
    const whatIWasTrying = stringArg(args, "whatIWasTrying");
    const detail = [reason, whatIWasTrying].filter(Boolean).join(": ") || "The model requested human help";
    context.logger.emit("escalation.raised", { origin: "discovery", reason: detail });
    return { result: { ok: true, escalated: true, reason: detail }, traceEntry: makeTrace(context, name, args, why, urlBefore, before), stop: true, status: "escalated", reason: detail };
  }

  if (!actionTools.has(name)) return errorResult("Unknown discovery tool " + name);

  let descriptor: TargetDescriptor | undefined;
  let perceived: PerceivedControl | undefined;
  if (name !== "navigate") {
    const ref = stringArg(args, "ref");
    if (!ref) return errorResult(name + " needs a ref from the latest observation");
    perceived = findRef(before, ref);
    if (!perceived) return errorResult("Unknown ref " + ref + "; re-observe and choose a current ref. Do not guess.");
    descriptor = await captureDescriptorForRef(context.surface, ref, before) ?? undefined;
    if (!descriptor) return errorResult("Could not capture ref " + ref + "; re-observe and choose a current ref.");
  }

  const action = buildAction(name, args, descriptor, context.resolveTemplateValue);
  if (!action.ok) return errorResult(action.message);
  const resolvedUrl = action.value.type === "navigate" ? action.value.url : await context.surface.url();
  const risk = classifyRisk(action.value, perceived?.name);
  const decision = context.policy.check(action.value, { resolvedUrl, risk, mode: "discovery" });
  if (decision.decision !== "allow") return errorResult("Denied by policy: " + decision.reason);

  try {
    if (name === "extract") {
      const output = parseOutput(args, descriptor);
      if (!output.ok) return errorResult(output.message);
      context.declaredOutputs.set(output.value.name, output.value);
    } else {
      await context.surface.act(action.value, { risk, mode: "discovery" });
    }
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  const observation = await context.surface.observe();
  const traceEntry = makeTrace(context, name, args, why, urlBefore, observation, descriptor);
  context.logger.emit("action.performed", { origin: "discovery", action: name, why, descriptor: descriptor ?? null });
  return { result: { ok: true, action: name, ...(descriptor ? { descriptor } : {}) }, observation, traceEntry };
}

function buildAction(name: string, args: Record<string, unknown>, descriptor: TargetDescriptor | undefined, resolveTemplateValue: (value: string) => string): { ok: true; value: Action } | { ok: false; message: string } {
  if (name === "navigate") {
    const url = stringArg(args, "url");
    return url ? { ok: true, value: { type: "navigate", url: resolveTemplateValue(url) } } : { ok: false, message: "navigate needs a URL" };
  }
  if (!descriptor) return { ok: false, message: name + " did not produce a captured descriptor" };
  if (name === "click") return { ok: true, value: { type: "click", target: descriptor } };
  if (name === "type_text") {
    const text = stringArg(args, "text");
    return text ? { ok: true, value: { type: "type", target: descriptor, value: resolveTemplateValue(text), clearFirst: true } } : { ok: false, message: "type_text needs text" };
  }
  if (name === "select_option") {
    const value = stringArg(args, "value");
    return value ? { ok: true, value: { type: "select", target: descriptor, value: resolveTemplateValue(value) } } : { ok: false, message: "select_option needs value" };
  }
  if (name === "press_key") {
    const key = stringArg(args, "key");
    return key ? { ok: true, value: { type: "press", target: descriptor, key } } : { ok: false, message: "press_key needs key" };
  }
  if (name === "extract") {
    const outputName = stringArg(args, "outputName");
    return outputName ? { ok: true, value: { type: "extract", outputs: [outputName] } } : { ok: false, message: "extract needs outputName" };
  }
  return { ok: false, message: "Unsupported action tool " + name };
}

function parseInputDeclaration(args: Record<string, unknown>): { ok: true; value: ParamSpec } | { ok: false; message: string } {
  const name = stringArg(args, "name");
  const type = args.type;
  const description = stringArg(args, "description");
  const sensitivity = args.sensitivity;
  if (!name || !description || !["string", "number", "boolean", "date", "enum"].includes(String(type)) || !["public", "pii", "secret"].includes(String(sensitivity))) {
    return { ok: false, message: "declare_input has invalid name, type, description, or sensitivity" };
  }
  const value = {
    name,
    type: type as ParamSpec["type"],
    description,
    sensitivity: sensitivity as ParamSpec["sensitivity"],
    required: true,
    ...(sensitivity !== "secret" && args.example !== undefined ? { example: args.example } : {}),
  };
  return { ok: true, value };
}

function parseOutput(args: Record<string, unknown>, descriptor: TargetDescriptor | undefined): { ok: true; value: DiscoveryResult["outputs"][number] } | { ok: false; message: string } {
  const name = stringArg(args, "outputName");
  const description = stringArg(args, "description");
  const type = args.type;
  const transform = args.transform;
  if (!name || !description || !descriptor || !["string", "number", "boolean", "currency", "date"].includes(String(type)) || !["none", "trim", "digits_only", "currency_to_number", "upper", "lower"].includes(String(transform))) {
    return { ok: false, message: "extract has invalid output metadata" };
  }
  return {
    ok: true,
    value: {
      name,
      type: type as DiscoveryResult["outputs"][number]["type"],
      description,
      transform: transform as DiscoveryResult["outputs"][number]["transform"],
      target: descriptor,
    },
  };
}

function makeTrace(context: ExecutionContext, tool: string, args: Record<string, unknown>, why: string, urlBefore: string, observationAfter: Observation, descriptor?: TargetDescriptor): DiscoveryTraceEntry {
  return {
    seq: context.nextSeq,
    tool,
    args: context.redactor.redactJson(args) as Record<string, unknown>,
    why,
    ...(descriptor ? { descriptor } : {}),
    urlBefore,
    urlAfter: observationAfter.url,
    observationBefore: context.redactor.redactJson(context.currentObservation) as Observation,
    observationAfter: context.redactor.redactJson(observationAfter) as Observation,
  };
}

function attachCheckpointToPreviousAction(trace: DiscoveryTraceEntry[], checkpoint: Checkpoint): void {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    if (stateChangingTools.has(trace[index].tool) && !trace[index].checkpointAsserted) {
      trace[index].checkpointAsserted = checkpoint;
      return;
    }
  }
}

function captureDescriptorForRef(surface: Surface, ref: string, observation: Observation): Promise<TargetDescriptor | null> {
  const capture = (surface as RefCaptureSurface).captureDescriptorForRef;
  return capture ? capture.call(surface, ref, observation) : Promise.resolve(null);
}

function findRef(observation: Observation, ref: string): PerceivedControl | undefined {
  return observation.frames.flatMap((frame) => frame.controls).find((control) => control.ref === ref);
}

function observationSignature(observation: Observation): string {
  const names = [...new Set(observation.frames.flatMap((frame) => frame.controls.map((control) => control.name)))].sort();
  return JSON.stringify({ url: observation.url, names });
}

function observationContains(observation: Observation, text: string): boolean {
  return observation.frames.some((frame) => frame.text.includes(text)) || observation.title.includes(text);
}

function compactObservation(observation: Observation, redactor?: Redactor): Omit<Observation, "screenshotBase64"> {
  const { screenshotBase64: _screenshot, ...compact } = observation;
  return (redactor?.redactJson(compact) ?? compact) as Omit<Observation, "screenshotBase64">;
}

function observationMessage(observation: Observation): MessageParam {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: JSON.stringify(compactObservation(observation)) }];
  if (observation.screenshotBase64) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: observation.screenshotBase64 } });
  }
  return { role: "user", content: content as unknown as MessageParam["content"] };
}

function resolveTemplateValue(value: string, declaredInputs: Map<string, ParamSpec>, inputs: Record<string, unknown>): string {
  for (const match of value.matchAll(inputReference)) {
    const name = match[1];
    if (!declaredInputs.has(name)) throw new Error("Input " + name + " must be declared before it is used");
    if (inputs[name] === undefined || inputs[name] === null) throw new Error("No supplied value exists for input " + name);
  }
  let resolved = value.replace(inputReference, (_whole, name: string) => String(inputs[name]));
  resolved = resolved.replace(secretReference, (_whole, name: string) => {
    const secret = process.env[name];
    if (!secret) throw new Error("Secret " + name + " is not configured");
    return secret;
  });
  return resolved;
}

function asArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key] : "";
}

function errorResult(message: string): ExecutionResult {
  return { result: { ok: false, error: message } };
}
