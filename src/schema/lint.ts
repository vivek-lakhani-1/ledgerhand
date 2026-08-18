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

  return problems;
}
