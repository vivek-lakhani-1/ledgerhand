import { Capability } from "./capability.js";
import { Action } from "./step.js";
import { Checkpoint } from "./checkpoint.js";
import { OutputSpec } from "./io.js";
import { Risk, Step } from "./step.js";
import type { z } from "zod";

type CapabilityValue = z.infer<typeof Capability>;
type ActionValue = z.infer<typeof Action>;
type CheckpointValue = z.infer<typeof Checkpoint>;
type OutputValue = z.infer<typeof OutputSpec>;
type StepValue = z.infer<typeof Step>;

const templatePattern = /\{\{(inputs|secrets)\.([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

function referencedTemplates(action: ActionValue): Array<{ namespace: "inputs" | "secrets"; name: string }> {
  return stringsIn(action).flatMap((value) => {
    const references: Array<{ namespace: "inputs" | "secrets"; name: string }> = [];
    for (const match of value.matchAll(templatePattern)) {
      references.push({ namespace: match[1] as "inputs" | "secrets", name: match[2] });
    }
    return references;
  });
}

function checkpointIsTriviallyTrue(checkpoint: CheckpointValue): boolean {
  switch (checkpoint.kind) {
    case "url_matches":
      return checkpoint.pattern === ".*";
    case "all":
      return checkpoint.of.every(checkpointIsTriviallyTrue);
    case "any":
      return checkpoint.of.some(checkpointIsTriviallyTrue);
    case "not":
      return false;
    default:
      return false;
  }
}

function addActionProblems(
  action: ActionValue,
  inputs: Set<string>,
  secrets: Set<string>,
  outputNames: Set<string>,
  problems: string[],
  location: string,
): void {
  for (const reference of referencedTemplates(action)) {
    const declared = reference.namespace === "inputs" ? inputs : secrets;
    if (!declared.has(reference.name)) {
      problems.push(`${location} references undeclared ${reference.namespace} ${reference.name}`);
    }
  }

  if (action.type === "extract") {
    for (const outputName of action.outputs) {
      if (!outputNames.has(outputName)) {
        problems.push(`${location}.outputs references undeclared output ${outputName}`);
      }
    }
  }
}

function addStepActionProblems(
  step: StepValue,
  inputs: Set<string>,
  secrets: Set<string>,
  outputNames: Set<string>,
  problems: string[],
  location: string,
): void {
  addActionProblems(step.action, inputs, secrets, outputNames, problems, `${location}.action`);
  step.recover.forEach((recovery, recoveryIndex) => {
    recovery.do.forEach((action, actionIndex) =>
      addActionProblems(
        action,
        inputs,
        secrets,
        outputNames,
        problems,
        `${location}.recover[${recoveryIndex}].do[${actionIndex}]`,
      ),
    );
  });
}

export function lintCapability(cap: CapabilityValue): string[] {
  const problems: string[] = [];
  const inputs = new Set(cap.inputs.map((input) => input.name));
  const secrets = new Set(cap.secretsRequired);
  const outputNames = new Set(cap.outputs.map((output) => output.name));

  const seenStepIds = new Set<string>();
  const riskRank: Record<z.infer<typeof Risk>, number> = {
    safe: 0,
    sensitive: 1,
    irreversible: 2,
  };

  cap.steps.forEach((step, index) => {
    const location = `steps[${index}]`;
    if (!step.id.trim()) problems.push(`${location}.id must be non-empty`);
    if (seenStepIds.has(step.id)) problems.push(`${location}.id duplicates step id ${step.id}`);
    seenStepIds.add(step.id);
    if (riskRank[step.risk] > riskRank[cap.policy.maxRisk]) {
      problems.push(`${location}.risk ${step.risk} exceeds policy.maxRisk ${cap.policy.maxRisk}`);
    }
    addStepActionProblems(step, inputs, secrets, outputNames, problems, location);
  });

  cap.recoveries.forEach((recovery, recoveryIndex) => {
    recovery.do.forEach((action, actionIndex) =>
      addActionProblems(
        action,
        inputs,
        secrets,
        outputNames,
        problems,
        `recoveries[${recoveryIndex}].do[${actionIndex}]`,
      ),
    );
  });

  cap.outputs.forEach((output: OutputValue, index) => {
    if ((output.source.kind === "text_of" || output.source.kind === "attribute_of") && !output.source.target) {
      problems.push(`outputs[${index}].source.target is required for ${output.source.kind}`);
    }
  });

  if (checkpointIsTriviallyTrue(cap.successCheckpoint)) {
    problems.push('successCheckpoint must not be a trivially true url_matches ".*"');
  }

  // A positional frame segment ("frame-1") is an index, not an identity: it depends on
  // attach order and silently points somewhere else on the next run. Recording produced
  // these when perception ran while a frameset was still attaching, so refuse them here as
  // well as fixing the race - an artifact carrying one does not replay reliably.
  for (const [location, path] of collectFramePaths(cap)) {
    const positional = path.filter((segment) => /^frame-\d+$/.test(segment));
    if (positional.length > 0) {
      problems.push(
        `${location} uses positional frame path segment(s) ${positional.join(", ")}; frames must be addressed by name`,
      );
    }
  }

  // A success checkpoint that embeds a value derived from an input only passes for the run it
  // was recorded on. This is the classic over-fitted recording: green once, useless after.
  for (const input of cap.inputs) {
    const example = input.example;
    if (typeof example !== "string" && typeof example !== "number") continue;
    const literal = String(example);
    if (literal.length < 3) continue;
    if (JSON.stringify(cap.successCheckpoint).includes(literal)) {
      problems.push(
        `successCheckpoint embeds the literal "${literal}" from input ${input.name}; it must be expressed in terms of {{inputs.${input.name}}} or a value-independent condition`,
      );
    }
  }

  return problems;
}

/** Every framePath in the artifact, with a human-readable location for the problem message. */
function collectFramePaths(cap: CapabilityValue): Array<[string, string[]]> {
  const found: Array<[string, string[]]> = [];
  const walk = (value: unknown, location: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${location}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.framePath) && record.framePath.every((s) => typeof s === "string")) {
      found.push([location, record.framePath as string[]]);
    }
    for (const [key, item] of Object.entries(record)) walk(item, `${location}.${key}`);
  };
  walk(cap.steps, "steps");
  walk(cap.outputs, "outputs");
  walk(cap.outcomes, "outcomes");
  walk(cap.recoveries, "recoveries");
  walk(cap.successCheckpoint, "successCheckpoint");
  return found;
}
