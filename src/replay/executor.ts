import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Action, Capability, Checkpoint, ErrorClass, ReplayResult, Step } from "../schema/index.js";
import { lintCapability } from "../schema/index.js";
import type { EvidenceDir } from "../evidence/evidence.js";
import type { RunLogger } from "../evidence/logger.js";
import type { PolicyEngine } from "../policy/policy.js";
import { ControlLostError } from "../session/control.js";
import type { Surface } from "../surface/types.js";
import {
  AmbiguousTargetError,
  PolicyBlockedError,
  TargetNotResolvedError,
} from "../surface/web/web-surface.js";
import { evaluateCheckpoint, waitForCheckpoint, type CheckpointEvaluation } from "./checkpoint.js";
import { extractOutputs, OutputExtractionError, classify } from "./outcomes.js";
import { tryRecover, type RecoveryRunState, resolveActionTemplates } from "./recovery.js";
import { InputValidationError, resolveTemplate, resolveTemplatesIn, TemplateError, validateInputs } from "./template.js";

export type EscalationRequest = {
  runId: string;
  capability: { id: string; version: string };
  reason: string;
  atStepId: string;
  stepDescription: string;
  expected: string;
  observed: string;
  action?: Action;
  screenshotPath: string;
  domPath: string;
  evidenceDir: string;
};

export type Escalator = (request: EscalationRequest) => Promise<{
  decision: "resume" | "approve" | "abort";
  note?: string;
}>;

export type ReplayOptions = {
  inputs: Record<string, unknown>;
  tenant?: string;
  surface: Surface;
  logger: RunLogger;
  evidence: EvidenceDir;
  policy: PolicyEngine;
  escalate?: Escalator;
  capabilityPath?: string;
};

type FailureDetail = {
  class: ErrorClass;
  stepId: string | null;
  stepDescription: string | null;
  expected: string;
  observed: string;
  message: string;
  recoveryAttempts: string[];
};

type RunContext = {
  cap: Capability;
  options: ReplayOptions;
  runId: string;
  startedAt: number;
  inputs: Record<string, unknown>;
  env: Record<string, string | undefined>;
  recoveryState: RecoveryRunState;
  recoveryAttempts: string[];
};

export async function replay(capability: Capability, options: ReplayOptions): Promise<ReplayResult> {
  const runId = options.logger.runId;
  const startedAt = Date.now();
  let cap = resolveForTenant(capability, options.tenant);
  const finish = async (result: ReplayResult): Promise<ReplayResult> => {
    updateStability(cap, result, options.capabilityPath, startedAt);
    options.logger.emit("run.end", { status: result.status, durationMs: Date.now() - startedAt });
    options.evidence.writeResult(result);
    return result;
  };

  options.logger.emit("run.start", {
    capabilityId: cap.id,
    capabilityVersion: cap.version,
    tenant: options.tenant ?? cap.target.tenant ?? "base",
  });

  const lintProblems = lintCapability(cap);
  if (lintProblems.length > 0) {
    options.evidence.writeCapability(cap);
    return finish(failedResult(cap, runId, options.evidence.runDir, {
      class: "INPUT_INVALID",
      stepId: null,
      stepDescription: null,
      expected: "a lint-clean capability artifact",
      observed: lintProblems.join("; "),
      message: `Capability lint failed before browser use: ${lintProblems.join("; ")}`,
      recoveryAttempts: [],
    }));
  }

  let inputs: Record<string, unknown>;
  try {
    inputs = validateInputs(cap, options.inputs);
    const missingSecrets = cap.secretsRequired.filter((name) => process.env[name] === undefined);
    if (missingSecrets.length > 0) {
      throw new InputValidationError(missingSecrets.map((name) => ({ field: name, message: "required secret is not set in process.env" })));
    }
  } catch (error) {
    return finish(failedResult(cap, runId, options.evidence.runDir, inputFailure(error)));
  }

  const env = process.env;
  registerRunSensitiveValues(cap, inputs, options);
  options.evidence.writeCapability(cap);
  const context = { inputs, secrets: {}, env };
  let entryUrl: string;
  try {
    entryUrl = resolveTemplate(cap.target.entryUrl, context);
  } catch (error) {
    return finish(failedResult(cap, runId, options.evidence.runDir, inputFailure(error)));
  }

  const run: RunContext = {
    cap,
    options,
    runId,
    startedAt,
    inputs,
    env,
    recoveryState: { attempts: new Map(), inputs, env, timeoutMs: cap.policy.timeoutMs },
    recoveryAttempts: [],
  };

  try {
    await options.surface.act({ type: "navigate", url: entryUrl }, {
      risk: "safe",
      mode: "replay",
      timeoutMs: cap.policy.timeoutMs,
    });
    await captureScreenshot(options.evidence, options.surface, "00-entry", true);
  } catch (error) {
    return finish(await failureWithEvidence(run, {
      class: classifyError(error),
      stepId: null,
      stepDescription: null,
      expected: `entry URL ${entryUrl} is reachable and allowlisted`,
      observed: await observedSurface(options.surface, error),
      message: errorMessage(error),
      recoveryAttempts: [],
    }, "entry-failure"));
  }

  const maxSteps = Math.min(cap.steps.length, cap.policy.maxSteps);
  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
    const step = cap.steps[stepIndex];
    if (Date.now() - startedAt > cap.policy.timeoutMs) {
      return finish(await failureWithEvidence(run, {
        class: "TIMEOUT",
        stepId: step.id,
        stepDescription: step.description,
        expected: "the capability to finish within its wall-clock timeout",
        observed: `run elapsed ${Date.now() - startedAt}ms`,
        message: `Capability timeout exceeded before step ${step.id}`,
        recoveryAttempts: [...run.recoveryAttempts],
      }, "run-timeout"));
    }

    const stepResult = await executeStep(run, step, context);
    if (stepResult.kind === "return") return finish(stepResult.result);
    if (stepResult.kind === "escalated") return finish(stepResult.result);
  }

  if (cap.steps.length > cap.policy.maxSteps) {
    return finish(await failureWithEvidence(run, {
      class: "TIMEOUT",
      stepId: null,
      stepDescription: null,
      expected: `no more than ${cap.policy.maxSteps} steps`,
      observed: `capability contains ${cap.steps.length} steps`,
      message: "Capability maxSteps exceeded",
      recoveryAttempts: [...run.recoveryAttempts],
    }, "max-steps"));
  }

  const successCheckpoint = resolveTemplatesIn(cap.successCheckpoint, context);
  const success = await waitForCheckpoint(successCheckpoint, options.surface, successCheckpoint.timeoutMs ?? cap.policy.timeoutMs, 100);
  await logCheckpoint(options, successCheckpoint, success, null, "success");
  if (!success.ok) {
    return finish(await hardFailure(run, {
      class: "CHECKPOINT_FAILED",
      stepId: null,
      stepDescription: null,
      expected: describeCheckpoint(successCheckpoint),
      observed: success.observed,
      message: "Capability success checkpoint was not satisfied",
      recoveryAttempts: [...run.recoveryAttempts],
    }, undefined, "success-checkpoint"));
  }

  let outputs: Record<string, unknown>;
  try {
    outputs = await extractOutputs(cap.outputs, options.surface);
  } catch (error) {
    const outputName = error instanceof OutputExtractionError ? error.outputName : "declared output";
    return finish(await hardFailure(run, {
      class: "CHECKPOINT_FAILED",
      stepId: null,
      stepDescription: null,
      expected: `required output ${outputName}`,
      observed: errorMessage(error),
      message: errorMessage(error),
      recoveryAttempts: [...run.recoveryAttempts],
    }, undefined, "output-extraction"));
  }

  await captureScreenshot(options.evidence, options.surface, "success-checkpoint");
  return finish({
    status: "success",
    runId,
    capability: { id: cap.id, version: cap.version },
    outputs,
    stepsExecuted: maxSteps,
    durationMs: Date.now() - startedAt,
    evidenceDir: options.evidence.runDir,
  });
}

export function resolveForTenant(capability: Capability, tenant?: string): Capability {
  if (!tenant) return capability;
  const override = capability.tenantOverrides[tenant];
  if (!override) return capability;
  const merged = deepMerge(capability, {
    target: override.entryUrl ? { entryUrl: override.entryUrl } : {},
    outcomes: override.outcomes,
  });
  if (override.steps) {
    merged.steps = merged.steps.map((step) => {
      const delta = override.steps?.[step.id];
      return delta ? deepMerge(step, delta) : step;
    }) as Capability["steps"];
  }
  return merged;
}

type StepExecution =
  | { kind: "continue" }
  | { kind: "return"; result: ReplayResult }
  | { kind: "escalated"; result: ReplayResult };

async function executeStep(run: RunContext, step: Step, context: { inputs: Record<string, unknown>; secrets: Record<string, unknown>; env: Record<string, string | undefined> }): Promise<StepExecution> {
  const { options, cap } = run;
  let retryCount = 0;
  let approvalGranted = false;

  while (true) {
    options.logger.emit("step.start", { stepId: step.id, description: step.description, attempt: retryCount });

    for (let index = 0; index < step.preconditions.length; index += 1) {
      const checkpoint = resolveTemplatesIn(step.preconditions[index], context);
      const result = await waitForCheckpoint(checkpoint, options.surface, step.timeoutMs, 100);
      await logCheckpoint(options, checkpoint, result, step.id, `precondition-${index}`);
      if (!result.ok) {
        const failure = await hardFailure(run, {
          class: "PRECONDITION_FAILED",
          stepId: step.id,
          stepDescription: step.description,
          expected: describeCheckpoint(checkpoint),
          observed: result.observed,
          message: `Step ${step.id} precondition failed`,
          recoveryAttempts: [...run.recoveryAttempts],
        }, step, "precondition-failure");
        return { kind: failure.status === "escalated" ? "escalated" : "return", result: failure };
      }
    }

    let action: Action;
    try {
      action = resolveActionTemplates(step.action, context);
    } catch (error) {
      const result = await hardFailure(run, {
        ...inputFailure(error),
        stepId: step.id,
        stepDescription: step.description,
        recoveryAttempts: [...run.recoveryAttempts],
      }, step, "template-failure");
      return { kind: result.status === "escalated" ? "escalated" : "return", result };
    }

    const actingUrl = action.type === "navigate" ? action.url : await options.surface.url();
    const policyDecision = options.policy.check(action, {
      resolvedUrl: actingUrl,
      risk: step.risk,
      mode: "replay",
    });
    options.logger.emit("policy.decision", {
      action: action.type,
      decision: policyDecision.decision,
      reason: policyDecision.reason,
      resolvedUrl: actingUrl,
      preflight: true,
    });
    if (policyDecision.decision === "deny") {
      const result = await hardFailure(run, {
        class: "POLICY_BLOCKED",
        stepId: step.id,
        stepDescription: step.description,
        expected: "the action to satisfy the replay policy",
        observed: policyDecision.reason,
        message: policyDecision.reason,
        recoveryAttempts: [...run.recoveryAttempts],
      }, step, "policy-blocked");
      return { kind: result.status === "escalated" ? "escalated" : "return", result };
    }

    if (policyDecision.decision === "require_approval" && !approvalGranted) {
      const escalation = await raiseEscalation(run, step, "RISKY_ACTION_APPROVAL", describeAction(action), policyDecision.reason, action);
      if (escalation.kind === "result") return { kind: "escalated", result: escalation.result };
      if (escalation.decision === "abort") {
        const result = await hardFailure(run, {
          class: "POLICY_BLOCKED",
          stepId: step.id,
          stepDescription: step.description,
          expected: "operator approval for the irreversible action",
          observed: escalation.note ?? "operator aborted approval",
          message: "Irreversible action was not approved",
          recoveryAttempts: [...run.recoveryAttempts],
        }, undefined, "approval-aborted");
        return { kind: "return", result };
      }
      approvalGranted = true;
    }

    try {
      await options.surface.act(action, {
        risk: step.risk,
        mode: "replay",
        timeoutMs: step.timeoutMs,
        approvalGranted,
      });
    } catch (error) {
      const errorClass = classifyError(error);
      if (errorClass === "TIMEOUT" && retryCount < step.retries.max) {
        retryCount += 1;
        options.logger.emit("retry", { stepId: step.id, attempt: retryCount, class: errorClass, backoffMs: step.retries.backoffMs });
        await backoff(step.retries.backoffMs);
        continue;
      }
      const result = await hardFailure(run, {
        class: errorClass,
        stepId: step.id,
        stepDescription: step.description,
        expected: describeAction(action),
        observed: await observedSurface(options.surface, error),
        message: errorMessage(error),
        recoveryAttempts: [...run.recoveryAttempts],
      }, step, "action-failure");
      return { kind: result.status === "escalated" ? "escalated" : "return", result };
    }

    let outcomeResult: Awaited<ReturnType<typeof classify>>;
    try {
      outcomeResult = await classify(cap, options.surface);
    } catch (error) {
      if (error instanceof OutputExtractionError) {
        const result = await hardFailure(run, {
          class: "CHECKPOINT_FAILED",
          stepId: step.id,
          stepDescription: step.description,
          expected: `declared output ${error.outputName}`,
          observed: error.message,
          message: error.message,
          recoveryAttempts: [...run.recoveryAttempts],
        }, step, "outcome-output-failure");
        return { kind: result.status === "escalated" ? "escalated" : "return", result };
      }
      const result = await hardFailure(run, {
        class: "SURFACE_ERROR",
        stepId: step.id,
        stepDescription: step.description,
        expected: "the surface to remain readable after the action",
        observed: errorMessage(error),
        message: errorMessage(error),
        recoveryAttempts: [...run.recoveryAttempts],
      }, step, "outcome-classification-failure");
      return { kind: result.status === "escalated" ? "escalated" : "return", result };
    }
    if (outcomeResult.kind === "outcome") {
      await captureScreenshot(options.evidence, options.surface, `${step.id}-outcome-${outcomeResult.outcome.code}`);
      options.logger.emit("outcome.matched", {
        stepId: step.id,
        code: outcomeResult.outcome.code,
        message: outcomeResult.message,
      });
      const result: ReplayResult = {
        status: "business_outcome",
        runId: run.runId,
        capability: { id: cap.id, version: cap.version },
        code: outcomeResult.outcome.code,
        message: outcomeResult.message,
        outputs: outcomeResult.outputs,
        atStepId: step.id,
        evidenceDir: options.evidence.runDir,
      };
      options.logger.emit("step.end", { stepId: step.id, description: step.description, summary: `outcome ${outcomeResult.outcome.code}` });
      return { kind: "return", result };
    }

    let recovery: Awaited<ReturnType<typeof tryRecover>>;
    try {
      recovery = await tryRecover(step, cap, options.surface, run.recoveryState);
    } catch (error) {
      const result = await hardFailure(run, {
        class: classifyError(error),
        stepId: step.id,
        stepDescription: step.description,
        expected: "a recovery rule to complete without a surface error",
        observed: await observedSurface(options.surface, error),
        message: errorMessage(error),
        recoveryAttempts: [...run.recoveryAttempts],
      }, step, "recovery-failure");
      return { kind: result.status === "escalated" ? "escalated" : "return", result };
    }
    if (recovery) {
      run.recoveryAttempts.push(recovery.applied.id);
      options.logger.emit("recovery.applied", { stepId: step.id, recoveryId: recovery.applied.id, attempt: run.recoveryState.attempts.get(recovery.applied.id) });
      // A recovery can itself complete the interrupted navigation (for example, reauthenticating
      // loads the search form). Re-checking the postcondition avoids replaying a stale click on a
      // page that the recovery has already advanced, while retaining thenRetryStep for the usual
      // case where the repair only clears a transient obstruction.
      if (step.postcondition) {
        const recoveredPostcondition = resolveTemplatesIn(step.postcondition, context);
        const recovered = await waitForCheckpoint(recoveredPostcondition, options.surface, step.timeoutMs, 100);
        if (recovered.ok) {
          await logCheckpoint(options, recoveredPostcondition, recovered, step.id, "postcondition-after-recovery");
          options.logger.emit("step.end", { stepId: step.id, description: step.description, summary: "✓ postcondition after recovery" });
          return { kind: "continue" };
        }
      }
      if (recovery.applied.thenRetryStep && retryCount < step.retries.max) {
        retryCount += 1;
        options.logger.emit("retry", { stepId: step.id, attempt: retryCount, reason: `recovery:${recovery.applied.id}`, backoffMs: 0 });
        continue;
      }
    }

    const appError = await findSurfaceError(options.surface);
    if (appError) {
      const result = await hardFailure(run, {
        class: "SURFACE_ERROR",
        stepId: step.id,
        stepDescription: step.description,
        expected: "the target application to return a usable page",
        observed: appError,
        message: "Target application returned an application error page",
        recoveryAttempts: [...run.recoveryAttempts],
      }, step, "surface-error");
      return { kind: result.status === "escalated" ? "escalated" : "return", result };
    }

    if (action.type === "wait" || action.type === "assert") {
      const actionCheckpoint = resolveTemplatesIn(action.checkpoint, context);
      const checkpointResult = await waitForCheckpoint(actionCheckpoint, options.surface, actionCheckpoint.timeoutMs ?? step.timeoutMs, 100);
      await logCheckpoint(options, actionCheckpoint, checkpointResult, step.id, `${action.type}-action`);
      if (!checkpointResult.ok) {
        const failure = await hardFailure(run, {
          class: "CHECKPOINT_FAILED",
          stepId: step.id,
          stepDescription: step.description,
          expected: describeCheckpoint(actionCheckpoint),
          observed: checkpointResult.observed,
          message: `${action.type} checkpoint failed`,
          recoveryAttempts: [...run.recoveryAttempts],
        }, step, `${action.type}-failure`);
        return { kind: failure.status === "escalated" ? "escalated" : "return", result: failure };
      }
    }

    if (step.postcondition) {
      const postconditionCheckpoint = resolveTemplatesIn(step.postcondition, context);
      const postcondition = await waitForCheckpoint(postconditionCheckpoint, options.surface, step.timeoutMs, 100);
      await logCheckpoint(options, postconditionCheckpoint, postcondition, step.id, "postcondition");
      if (!postcondition.ok) {
        const failure = await hardFailure(run, {
          class: "CHECKPOINT_FAILED",
          stepId: step.id,
          stepDescription: step.description,
          expected: describeCheckpoint(postconditionCheckpoint),
          observed: postcondition.observed,
          message: `Step ${step.id} postcondition failed`,
          recoveryAttempts: [...run.recoveryAttempts],
        }, step, "postcondition-failure");
        return { kind: failure.status === "escalated" ? "escalated" : "return", result: failure };
      }
    }

    options.logger.emit("step.end", {
      stepId: step.id,
      description: step.description,
      action: action.type,
      value: action.type === "type" ? action.value : undefined,
      summary: step.postcondition ? "✓ postcondition" : "✓ action",
    });
    return { kind: "continue" };
  }
}

async function hardFailure(run: RunContext, failure: FailureDetail, step: Step | undefined, label: string): Promise<ReplayResult> {
  if (step?.onFailure === "escalate") {
    const escalation = await raiseEscalation(run, step, "UNRECOVERABLE", failure.expected, failure.observed, step.action);
    if (escalation.kind === "result") return escalation.result;
    if (escalation.decision !== "abort") {
      // Phase 6 supplies the live resume semantics. For this phase, a supplied resume/approve
      // decision conservatively re-checks the current postcondition and only advances when it is
      // already satisfied; otherwise the failure remains explicit.
      if (step.postcondition) {
        const resumed = await evaluateCheckpoint(step.postcondition, run.options.surface, Date.now() + step.timeoutMs);
        if (resumed.ok) {
          run.options.logger.emit("human.resolved", { stepId: step.id, decision: escalation.decision, note: escalation.note });
          return {
            status: "business_outcome",
            runId: run.runId,
            capability: { id: run.cap.id, version: run.cap.version },
            code: "HUMAN_COMPLETED_STEP",
            message: "Human intervention satisfied the step checkpoint",
            outputs: {},
            atStepId: step.id,
            evidenceDir: run.options.evidence.runDir,
          };
        }
      }
    }
  }
  return failureWithEvidence(run, failure, label);
}

async function failureWithEvidence(run: RunContext, failure: FailureDetail, label: string): Promise<ReplayResult> {
  const { options, cap } = run;
  const screenshotPath = await captureScreenshot(options.evidence, options.surface, label);
  const domPath = await captureDom(options.evidence, options.surface, label);
  const result = failedResult(cap, run.runId, options.evidence.runDir, failure);
  options.logger.emit("step.end", {
    stepId: failure.stepId ?? "-",
    description: failure.stepDescription ?? "run",
    summary: `✗ ${failure.class}`,
    expected: failure.expected,
    observed: failure.observed,
    screenshotPath,
    domPath,
  });
  return result;
}

async function raiseEscalation(
  run: RunContext,
  step: Step,
  reason: string,
  expected: string,
  observed: string,
  action: Action,
): Promise<{ kind: "result"; result: ReplayResult } | { kind: "decision"; decision: "resume" | "approve" | "abort"; note?: string }> {
  const screenshotPath = await captureScreenshot(run.options.evidence, run.options.surface, `${step.id}-escalation`);
  const domPath = await captureDom(run.options.evidence, run.options.surface, `${step.id}-escalation`);
  run.options.logger.emit("escalation.raised", {
    stepId: step.id,
    reason,
    expected,
    observed,
    screenshotPath,
    domPath,
  });
  if (!run.options.escalate) {
    return {
      kind: "result",
      result: {
        status: "escalated",
        runId: run.runId,
        capability: { id: run.cap.id, version: run.cap.version },
        interventionId: "<local>",
        reason,
        atStepId: step.id,
        evidenceDir: run.options.evidence.runDir,
      },
    };
  }
  const decision = await run.options.escalate({
    runId: run.runId,
    capability: { id: run.cap.id, version: run.cap.version },
    reason,
    atStepId: step.id,
    stepDescription: step.description,
    expected,
    observed,
    action,
    screenshotPath,
    domPath,
    evidenceDir: run.options.evidence.runDir,
  });
  run.options.logger.emit("human.resolved", { stepId: step.id, decision: decision.decision, note: decision.note });
  return { kind: "decision", ...decision };
}

async function logCheckpoint(options: ReplayOptions, checkpoint: Checkpoint, result: CheckpointEvaluation, stepId: string | null, phase: string): Promise<void> {
  options.logger.emit("checkpoint.evaluated", {
    stepId,
    phase,
    kind: checkpoint.kind,
    ok: result.ok,
    observed: result.observed,
  });
  if (result.ok) await captureScreenshot(options.evidence, options.surface, `${stepId ?? "run"}-${phase}`);
}

function registerRunSensitiveValues(cap: Capability, inputs: Record<string, unknown>, options: ReplayOptions): void {
  for (const name of cap.secretsRequired) {
    options.logger.registerSecret(process.env[name]);
    options.evidence.registerSecret(process.env[name]);
  }
  for (const spec of cap.inputs) {
    if (spec.sensitivity === "pii" && inputs[spec.name] !== undefined) {
      const value = String(inputs[spec.name]);
      options.logger.registerPii(value);
      options.evidence.registerPii(value);
    }
  }

  const piiTargets = cap.outputs
    .filter((output) => output.sensitivity === "pii" && output.source.target)
    .map((output) => output.source.target)
    .filter((target): target is NonNullable<typeof target> => Boolean(target));
  for (const step of cap.steps) {
    if (step.action.type === "type" && isPiiTemplate(step.action.value, cap)) piiTargets.push(step.action.target);
  }
  const surface = options.surface as Surface & { registerSensitiveTargets?: (targets: NonNullable<typeof piiTargets[number]>[]) => void };
  surface.registerSensitiveTargets?.(piiTargets);
}

function isPiiTemplate(value: string, cap: Capability): boolean {
  return cap.inputs.some((input) => input.sensitivity === "pii" && value.includes(`{{inputs.${input.name}}}`));
}

function inputFailure(error: unknown): FailureDetail {
  return {
    class: "INPUT_INVALID",
    stepId: null,
    stepDescription: null,
    expected: "inputs and templates to satisfy the capability contract",
    observed: errorMessage(error),
    message: errorMessage(error),
    recoveryAttempts: [],
  };
}

function failedResult(cap: Capability, runId: string, evidenceDir: string, error: FailureDetail): ReplayResult {
  return {
    status: "failed",
    runId,
    capability: { id: cap.id, version: cap.version },
    error,
    evidenceDir,
  };
}

function classifyError(error: unknown): ErrorClass {
  if (error instanceof ControlLostError) return "CONTROL_LOST";
  if (error instanceof PolicyBlockedError) return "POLICY_BLOCKED";
  if (error instanceof AmbiguousTargetError) return "AMBIGUOUS_TARGET";
  if (error instanceof TargetNotResolvedError) return "TARGET_NOT_FOUND";
  if (error instanceof TemplateError || error instanceof InputValidationError) return "INPUT_INVALID";
  if (typeof error === "object" && error && "errorClass" in error) {
    const candidate = (error as { errorClass?: unknown }).errorClass;
    if (typeof candidate === "string" && isErrorClass(candidate)) return candidate;
  }
  if (isTimeout(error)) return "TIMEOUT";
  return "INTERNAL";
}

function isErrorClass(value: string): value is ErrorClass {
  return [
    "INPUT_INVALID", "POLICY_BLOCKED", "TARGET_NOT_FOUND", "AMBIGUOUS_TARGET", "PRECONDITION_FAILED",
    "CHECKPOINT_FAILED", "TIMEOUT", "SESSION_EXPIRED", "PERMISSION_DENIED", "SURFACE_ERROR", "CONTROL_LOST", "INTERNAL",
  ].includes(value);
}

function isTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "TimeoutError")
    || errorMessage(error).toLowerCase().includes("timeout");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function observedSurface(surface: Surface, error?: unknown): Promise<string> {
  try {
    const observation = await surface.observe();
    const text = observation.frames.map((frame) => `[${frame.path.join(" / ") || "main"}] ${frame.text}`).join(" ").trim();
    if (text) return text.slice(0, 1000);
  } catch {
    // The original error is more useful if the page itself is already gone.
  }
  return error ? errorMessage(error) : "surface had no readable content";
}

/**
 * Detects that the application itself failed, as opposed to the flow reaching an expected
 * business outcome.
 *
 * The primary signal is the transport status: any 5xx document response is an application
 * error regardless of what the error page says. Matching error-page copy is the fallback for
 * apps that return a "friendly" error with HTTP 200 - a real pattern in legacy systems - and
 * for surfaces that expose no transport at all.
 */
async function findSurfaceError(surface: Surface): Promise<string | null> {
  try {
    const document = await surface.lastDocumentStatus();
    if (document && document.status >= 500) {
      const observation = await surface.observe().catch(() => null);
      const body = observation?.frames.map((frame) => frame.text).join(" ").trim().slice(0, 300);
      return `HTTP ${document.status} from ${document.url}${body ? ` — ${body}` : ""}`;
    }
  } catch {
    // Fall through to content-based detection below.
  }

  try {
    const observation = await surface.observe();
    const text = observation.frames.map((frame) => frame.text).join(" ");
    const match = text.match(/APPLICATION ERROR\s*[-—]\s*REF\s+\S+/i);
    if (match) return match[0];
  } catch {
    return null;
  }
  return null;
}

async function captureScreenshot(evidence: EvidenceDir, surface: Surface, label: string, fixedEntry = false): Promise<string> {
  const destination = fixedEntry
    ? path.join(evidence.runDir, "screenshots", "00-entry.png")
    : evidence.screenshotPath(label);
  try {
    fs.writeFileSync(destination, await surface.screenshot({ maskSensitive: true }));
  } catch {
    fs.writeFileSync(destination, Buffer.alloc(0));
  }
  return destination;
}

async function captureDom(evidence: EvidenceDir, surface: Surface, label: string): Promise<string> {
  const destination = evidence.domPath(label);
  try {
    evidence.writeText(destination, await surface.domSnapshot());
  } catch {
    fs.writeFileSync(destination, "", "utf8");
  }
  return destination;
}

function describeCheckpoint(checkpoint: Checkpoint): string {
  return checkpoint.description ?? `${checkpoint.kind} ${JSON.stringify(checkpoint)}`.slice(0, 500);
}

function describeAction(action: Action): string {
  switch (action.type) {
    case "navigate": return `navigate to ${action.url}`;
    case "click": return `click ${action.target.description ?? action.target.name ?? action.target.role}`;
    case "type": return `type into ${action.target.description ?? action.target.name ?? action.target.role}`;
    case "select": return `select ${action.value}`;
    case "press": return `press ${action.key}`;
    case "wait": return `wait for ${describeCheckpoint(action.checkpoint)}`;
    case "assert": return `assert ${describeCheckpoint(action.checkpoint)}`;
    case "extract": return `extract ${action.outputs.join(", ")}`;
  }
}

async function backoff(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function updateStability(cap: Capability, result: ReplayResult, capabilityPath: string | undefined, startedAt: number): void {
  cap.stability.runs += 1;
  cap.stability.lastRunAt = new Date().toISOString();
  if (result.status === "success") cap.stability.successes += 1;
  else if (result.status === "business_outcome") cap.stability.businessOutcomes += 1;
  else if (result.status === "failed" || result.status === "escalated") cap.stability.failures += 1;
  if (capabilityPath) {
    fs.writeFileSync(capabilityPath, `${JSON.stringify(cap, null, 2)}\n`, "utf8");
  }
  void startedAt;
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) return (override as T) ?? base;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] = value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)
      ? deepMerge(current, value)
      : value;
  }
  return result as T;
}
