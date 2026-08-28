import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Action, Capability, Checkpoint, ErrorClass, ReplayResult, Step, TargetDescriptor } from "../schema/index.js";
import { lintCapability } from "../schema/index.js";
import type { EvidenceDir } from "../evidence/evidence.js";
import type { RunLogger } from "../evidence/logger.js";
import type { PolicyEngine } from "../policy/policy.js";
import { ControlLostError } from "../session/control.js";
import type { Observation, Surface } from "../surface/types.js";
import {
  AmbiguousTargetError,
  PolicyBlockedError,
  TargetNotResolvedError,
} from "../surface/web/web-surface.js";
import { evaluateCheckpoint, waitForCheckpoint, type CheckpointEvaluation } from "./checkpoint.js";
import { extractOutputs, OutputExtractionError, classify } from "./outcomes.js";
import { tryRecover, type RecoveryRunState, resolveActionTemplates } from "./recovery.js";
import { InputValidationError, resolveTemplate, resolveTemplatesIn, TemplateError, validateInputs } from "./template.js";
import { resolveForTenant } from "../catalog/tenant.js";

export { resolveForTenant } from "../catalog/tenant.js";

export type EscalationRequest = {
  runId: string;
  capability: { id: string; version: string };
  goal?: string;
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
  /**
   * Total time this run spent parked on a human decision. The capability's wall-clock
   * timeout bounds the automation, not the reviewer: a careful human reading an approval
   * card must not cause the next step to fail as TIMEOUT.
   */
  humanWaitMs: number;
};

export async function replay(capability: Capability, options: ReplayOptions): Promise<ReplayResult> {
  const runId = options.logger.runId;
  const startedAt = Date.now();
  let cap = resolveForTenant(capability, options.tenant);
  const finish = async (result: ReplayResult): Promise<ReplayResult> => {
    updateStability(cap, result, options.capabilityPath, startedAt);
    emitDriftSummary(options.logger, options.tenant ?? cap.target.tenant ?? "base");
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
    humanWaitMs: 0,
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
    if (Date.now() - startedAt - run.humanWaitMs > cap.policy.timeoutMs) {
      return finish(await failureWithEvidence(run, {
        class: "TIMEOUT",
        stepId: step.id,
        stepDescription: step.description,
        expected: "the capability to finish within its wall-clock timeout",
        observed: `run elapsed ${Date.now() - startedAt}ms (${run.humanWaitMs}ms of it waiting on a human decision)`,
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
    return finish(await failureWithEvidence(run, {
      class: "CHECKPOINT_FAILED",
      stepId: null,
      stepDescription: null,
      expected: describeCheckpoint(successCheckpoint),
      observed: success.observed,
      message: "Capability success checkpoint was not satisfied",
      recoveryAttempts: [...run.recoveryAttempts],
    }, "success-checkpoint"));
  }

  let outputs: Record<string, unknown>;
  try {
    // Outputs may scope an extraction target by an input (a share id selecting its table row),
    // so they resolve through the same template context as checkpoints do.
    outputs = await extractOutputs(resolveTemplatesIn(cap.outputs, context), options.surface);
  } catch (error) {
    const outputName = error instanceof OutputExtractionError ? error.outputName : "declared output";
    return finish(await failureWithEvidence(run, {
      class: "CHECKPOINT_FAILED",
      stepId: null,
      stepDescription: null,
      expected: `required output ${outputName}`,
      observed: errorMessage(error),
      message: errorMessage(error),
      recoveryAttempts: [...run.recoveryAttempts],
    }, "output-extraction"));
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

type StepExecution =
  | { kind: "continue" }
  | { kind: "retry" }
  | { kind: "return"; result: ReplayResult }
  | { kind: "escalated"; result: ReplayResult };

type StepResumeState = {
  /** At most two interventions may be used for one step. */
  escalationCount: number;
};

async function executeStep(run: RunContext, step: Step, context: { inputs: Record<string, unknown>; secrets: Record<string, unknown>; env: Record<string, string | undefined> }): Promise<StepExecution> {
  const { options, cap } = run;
  let retryCount = 0;
  let approvalGranted = false;
  const resumeState: StepResumeState = { escalationCount: 0 };

  while (true) {
    options.logger.emit("step.start", { stepId: step.id, description: step.description, attempt: retryCount });

    for (let index = 0; index < step.preconditions.length; index += 1) {
      const checkpoint = resolveTemplatesIn(step.preconditions[index], context);
      const result = await waitForCheckpoint(checkpoint, options.surface, step.timeoutMs, 100);
      await logCheckpoint(options, checkpoint, result, step.id, `precondition-${index}`);
      if (!result.ok) {
        const missingTarget = missingTargetFromCheckpoint(checkpoint, result.observed);
        if (missingTarget) await proposeDrift(run, step, missingTarget);
        const failure = await handleStepFailure(run, {
          class: missingTarget ? "TARGET_NOT_FOUND" : "PRECONDITION_FAILED",
          stepId: step.id,
          stepDescription: step.description,
          expected: describeCheckpoint(checkpoint),
          observed: result.observed,
          message: `Step ${step.id} precondition failed`,
          recoveryAttempts: [...run.recoveryAttempts],
        }, step, "precondition-failure", context, resumeState, false);
        if (failure.kind === "retry") { retryCount += 1; continue; }
        return failure;
      }
    }

    let action: Action;
    try {
      action = resolveActionTemplates(step.action, context);
    } catch (error) {
      const result = await handleStepFailure(run, {
        ...inputFailure(error),
        stepId: step.id,
        stepDescription: step.description,
        recoveryAttempts: [...run.recoveryAttempts],
      }, step, "template-failure", context, resumeState, false);
      if (result.kind === "retry") { retryCount += 1; continue; }
      return result;
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
      const result = await handleStepFailure(run, {
        class: "POLICY_BLOCKED",
        stepId: step.id,
        stepDescription: step.description,
        expected: "the action to satisfy the replay policy",
        observed: policyDecision.reason,
        message: policyDecision.reason,
        recoveryAttempts: [...run.recoveryAttempts],
      }, step, "policy-blocked", context, resumeState, false);
      if (result.kind === "retry") { retryCount += 1; continue; }
      return result;
    }

    if (policyDecision.decision === "require_approval" && !approvalGranted) {
      const escalation = await raiseEscalation(run, step, "RISKY_ACTION_APPROVAL", describeAction(action), policyDecision.reason, action);
      if (escalation.kind === "result") return { kind: "escalated", result: escalation.result };
      if (escalation.decision === "abort") {
        options.logger.emit("human.resolved", {
          stepId: step.id,
          decision: escalation.decision,
          note: escalation.note,
          resumeBranch: "aborted",
        });
        const result = await failureWithEvidence(run, {
          class: "POLICY_BLOCKED",
          stepId: step.id,
          stepDescription: step.description,
          expected: "operator approval for the irreversible action",
          observed: escalation.note ?? "operator aborted approval",
          message: "Irreversible action was not approved",
          recoveryAttempts: [...run.recoveryAttempts],
        }, "approval-aborted");
        return { kind: "return", result };
      }
      options.logger.emit("human.resolved", {
        stepId: step.id,
        decision: escalation.decision,
        note: escalation.note,
        resumeBranch: "approval_granted",
      });
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
      if (errorClass === "TARGET_NOT_FOUND" && hasTarget(action)) {
        await proposeDrift(run, step, action.target);
      }
      const result = await handleStepFailure(run, {
        class: errorClass,
        stepId: step.id,
        stepDescription: step.description,
        expected: describeAction(action),
        observed: await observedSurface(options.surface, error),
        message: errorMessage(error),
        recoveryAttempts: [...run.recoveryAttempts],
      }, step, "action-failure", context, resumeState, true);
      if (result.kind === "retry") { retryCount += 1; continue; }
      return result;
    }

    let outcomeResult: Awaited<ReturnType<typeof classify>>;
    try {
      outcomeResult = await classify(cap, options.surface);
    } catch (error) {
      if (error instanceof OutputExtractionError) {
        const result = await handleStepFailure(run, {
          class: "CHECKPOINT_FAILED",
          stepId: step.id,
          stepDescription: step.description,
          expected: `declared output ${error.outputName}`,
          observed: error.message,
          message: error.message,
          recoveryAttempts: [...run.recoveryAttempts],
        }, step, "outcome-output-failure", context, resumeState, true);
        if (result.kind === "retry") { retryCount += 1; continue; }
        return result;
      }
      const result = await handleStepFailure(run, {
        class: "SURFACE_ERROR",
        stepId: step.id,
        stepDescription: step.description,
        expected: "the surface to remain readable after the action",
        observed: errorMessage(error),
        message: errorMessage(error),
        recoveryAttempts: [...run.recoveryAttempts],
      }, step, "outcome-classification-failure", context, resumeState, true);
      if (result.kind === "retry") { retryCount += 1; continue; }
      return result;
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
      const result = await handleStepFailure(run, {
        class: classifyError(error),
        stepId: step.id,
        stepDescription: step.description,
        expected: "a recovery rule to complete without a surface error",
        observed: await observedSurface(options.surface, error),
        message: errorMessage(error),
        recoveryAttempts: [...run.recoveryAttempts],
      }, step, "recovery-failure", context, resumeState, true);
      if (result.kind === "retry") { retryCount += 1; continue; }
      return result;
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
      const result = await handleStepFailure(run, {
        class: "SURFACE_ERROR",
        stepId: step.id,
        stepDescription: step.description,
        expected: "the target application to return a usable page",
        observed: appError,
        message: "Target application returned an application error page",
        recoveryAttempts: [...run.recoveryAttempts],
      }, step, "surface-error", context, resumeState, true);
      if (result.kind === "retry") { retryCount += 1; continue; }
      return result;
    }

    if (action.type === "wait" || action.type === "assert") {
      const actionCheckpoint = resolveTemplatesIn(action.checkpoint, context);
      const checkpointResult = await waitForCheckpoint(actionCheckpoint, options.surface, actionCheckpoint.timeoutMs ?? step.timeoutMs, 100);
      await logCheckpoint(options, actionCheckpoint, checkpointResult, step.id, `${action.type}-action`);
      if (!checkpointResult.ok) {
        const missingTarget = missingTargetFromCheckpoint(actionCheckpoint, checkpointResult.observed);
        if (missingTarget) await proposeDrift(run, step, missingTarget);
        const failure = await handleStepFailure(run, {
          class: missingTarget ? "TARGET_NOT_FOUND" : "CHECKPOINT_FAILED",
          stepId: step.id,
          stepDescription: step.description,
          expected: describeCheckpoint(actionCheckpoint),
          observed: checkpointResult.observed,
          message: `${action.type} checkpoint failed`,
          recoveryAttempts: [...run.recoveryAttempts],
        }, step, `${action.type}-failure`, context, resumeState, true);
        if (failure.kind === "retry") { retryCount += 1; continue; }
        return failure;
      }
    }

    if (step.postcondition) {
      const postconditionCheckpoint = resolveTemplatesIn(step.postcondition, context);
      const postcondition = await waitForCheckpoint(postconditionCheckpoint, options.surface, step.timeoutMs, 100);
      await logCheckpoint(options, postconditionCheckpoint, postcondition, step.id, "postcondition");
      if (!postcondition.ok) {
        const missingTarget = missingTargetFromCheckpoint(postconditionCheckpoint, postcondition.observed);
        if (missingTarget) await proposeDrift(run, step, missingTarget);
        const failure = await handleStepFailure(run, {
          class: missingTarget ? "TARGET_NOT_FOUND" : "CHECKPOINT_FAILED",
          stepId: step.id,
          stepDescription: step.description,
          expected: describeCheckpoint(postconditionCheckpoint),
          observed: postcondition.observed,
          message: `Step ${step.id} postcondition failed`,
          recoveryAttempts: [...run.recoveryAttempts],
        }, step, "postcondition-failure", context, resumeState, true);
        if (failure.kind === "retry") { retryCount += 1; continue; }
        return failure;
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

async function handleStepFailure(
  run: RunContext,
  failure: FailureDetail,
  step: Step,
  label: string,
  context: { inputs: Record<string, unknown>; secrets: Record<string, unknown>; env: Record<string, string | undefined> },
  resumeState: StepResumeState,
  stepRan: boolean,
): Promise<StepExecution> {
  if (step.onFailure !== "escalate") {
    return { kind: "return", result: await failureWithEvidence(run, failure, label) };
  }

  if (resumeState.escalationCount >= 2) {
    return checkpointFailureAfterHuman(run, step, failure, `${failure.observed}; no further human escalation is permitted for this step`);
  }

  resumeState.escalationCount += 1;
  const escalation = await raiseEscalation(run, step, "UNRECOVERABLE", failure.expected, failure.observed, step.action);
  if (escalation.kind === "result") return { kind: "escalated", result: escalation.result };
  if (escalation.decision === "abort") {
    run.options.logger.emit("human.resolved", {
      stepId: step.id,
      decision: escalation.decision,
      note: escalation.note,
      resumeBranch: "aborted",
    });
    return { kind: "return", result: await failureWithEvidence(run, failure, label) };
  }

  const firstInspection = await inspectResumeState(run, step, context, escalation.decision, escalation.note, stepRan);
  if (firstInspection.kind !== "neither") return firstInspection.execution;
  if (resumeState.escalationCount >= 2) {
    run.options.logger.emit("human.resolved", {
      stepId: step.id,
      decision: escalation.decision,
      note: escalation.note,
      resumeBranch: "re_escalated_failed",
    });
    return checkpointFailureAfterHuman(run, step, failure, firstInspection.observed);
  }

  run.options.logger.emit("human.resolved", {
    stepId: step.id,
    decision: escalation.decision,
    note: escalation.note,
    resumeBranch: "re_escalated",
  });
  resumeState.escalationCount += 1;
  const second = await raiseEscalation(run, step, "UNRECOVERABLE", failure.expected, firstInspection.observed, step.action);
  if (second.kind === "result") return { kind: "escalated", result: second.result };
  if (second.decision === "abort") {
    run.options.logger.emit("human.resolved", {
      stepId: step.id,
      decision: second.decision,
      note: second.note,
      resumeBranch: "re_escalated_failed",
    });
    return checkpointFailureAfterHuman(run, step, failure, `${firstInspection.observed}; second intervention was aborted`);
  }

  const secondInspection = await inspectResumeState(run, step, context, second.decision, second.note, stepRan);
  if (secondInspection.kind === "postcondition" || secondInspection.kind === "preconditions") {
    return secondInspection.execution;
  }
  run.options.logger.emit("human.resolved", {
    stepId: step.id,
    decision: second.decision,
    note: second.note,
    resumeBranch: "re_escalated_failed",
  });
  return checkpointFailureAfterHuman(run, step, failure, secondInspection.observed);
}

type ResumeInspection =
  | { kind: "postcondition"; execution: { kind: "continue" } }
  | { kind: "preconditions"; execution: { kind: "retry" } }
  | { kind: "neither"; observed: string };

async function inspectResumeState(
  run: RunContext,
  step: Step,
  context: { inputs: Record<string, unknown>; secrets: Record<string, unknown>; env: Record<string, string | undefined> },
  decision: "resume" | "approve",
  note: string | undefined,
  stepRan: boolean,
): Promise<ResumeInspection> {
  if (stepRan && step.postcondition) {
    const postcondition = resolveTemplatesIn(step.postcondition, context);
    const post = await evaluateCheckpoint(postcondition, run.options.surface, Date.now() + step.timeoutMs);
    await logCheckpoint(run.options, postcondition, post, step.id, "postcondition-after-human");
    if (post.ok) {
      run.options.logger.emit("human.resolved", {
        stepId: step.id,
        decision,
        note,
        resumeBranch: "postcondition_satisfied",
      });
      run.options.logger.emit("step.end", { stepId: step.id, description: step.description, summary: "✓ postcondition after human" });
      return { kind: "postcondition", execution: { kind: "continue" } };
    }
  }

  const observations: string[] = [];
  for (let index = 0; index < step.preconditions.length; index += 1) {
    const precondition = resolveTemplatesIn(step.preconditions[index], context);
    const pre = await evaluateCheckpoint(precondition, run.options.surface, Date.now() + step.timeoutMs);
    await logCheckpoint(run.options, precondition, pre, step.id, `precondition-after-human-${index}`);
    observations.push(pre.observed);
    if (!pre.ok) return { kind: "neither", observed: observations.join("; ") };
  }

  run.options.logger.emit("human.resolved", {
    stepId: step.id,
    decision,
    note,
    resumeBranch: "preconditions_satisfied_rerun",
  });
  return { kind: "preconditions", execution: { kind: "retry" } };
}

async function checkpointFailureAfterHuman(
  run: RunContext,
  step: Step,
  original: FailureDetail,
  observed: string,
): Promise<StepExecution> {
  return {
    kind: "return",
    result: await failureWithEvidence(run, {
      class: "CHECKPOINT_FAILED",
      stepId: step.id,
      stepDescription: step.description,
      expected: step.postcondition ? describeCheckpoint(step.postcondition) : "the step preconditions",
      observed,
      message: `Step ${step.id} remained unsatisfied after human intervention`,
      recoveryAttempts: original.recoveryAttempts,
    }, "human-resume-checkpoint-failure"),
  };
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
  const escalationStartedAt = Date.now();
  const decision = await run.options.escalate({
    runId: run.runId,
    capability: { id: run.cap.id, version: run.cap.version },
    goal: run.cap.provenance.goal,
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
  run.humanWaitMs += Date.now() - escalationStartedAt;
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

type DriftSurface = Surface & {
  captureDescriptorForRef?: (ref: string, observation: Observation) => Promise<TargetDescriptor | null>;
};

/** Return the first control checkpoint that was actually absent from the surface. */
function missingTargetFromCheckpoint(checkpoint: Checkpoint, observed: string): TargetDescriptor | undefined {
  const controlWasNotFound = observed.includes("not present") || observed.includes("evaluating control_present");
  if (!controlWasNotFound) return undefined;
  if (checkpoint.kind === "control_present") return checkpoint.target;
  if (checkpoint.kind === "all") {
    return checkpoint.of.map((child) => missingTargetFromCheckpoint(child, observed)).find(Boolean);
  }
  if (checkpoint.kind === "any") {
    return checkpoint.of.map((child) => missingTargetFromCheckpoint(child, observed)).find(Boolean);
  }
  return undefined;
}

/**
 * Drift proposals deliberately use only the target role and nearby text observed in the
 * current page. They are evidence for a human reviewer, never a locator mutation.
 */
async function proposeDrift(run: RunContext, step: Step, currentTarget: TargetDescriptor): Promise<void> {
  const surface = run.options.surface as DriftSurface;
  if (!surface.captureDescriptorForRef) return;

  try {
    const observation = await surface.observe();
    const expectedNearbyText = nearbyTextForTarget(currentTarget);
    const candidates = observation.frames
      .flatMap((frame) => frame.controls)
      .filter((control) => control.visible && control.role === currentTarget.role)
      .map((control) => ({
        control,
        similarity: nearbyTextSimilarity(expectedNearbyText, control.nearbyText ?? ""),
      }))
      .filter(({ control, similarity }) => samePath(control.framePath, currentTarget.framePath)
        && (expectedNearbyText ? similarity > 0 : true));

    if (candidates.length !== 1) return;
    const candidate = candidates[0];
    const proposedTarget = await surface.captureDescriptorForRef(candidate.control.ref, observation);
    if (!proposedTarget) return;

    const candidateEvidence = [{
      ref: candidate.control.ref,
      role: candidate.control.role,
      name: candidate.control.name,
      nearbyText: candidate.control.nearbyText,
      framePath: candidate.control.framePath,
      similarity: candidate.similarity,
    }];
    const proposal = {
      tenant: run.options.tenant ?? run.cap.target.tenant ?? "base",
      stepId: step.id,
      currentTarget,
      proposedTarget,
      candidateEvidence,
    };
    // This descriptor-only proposal must remain valid JSON. The normal evidence text redactor
    // is intentionally allowed to replace sensitive numeric substrings, which would corrupt
    // numeric confidence fields in a JSON document; this payload contains no form values and is
    // written as the reviewed, structural proposal itself.
    const proposalPath = path.join(run.options.evidence.runDir, "proposed-override.json");
    fs.writeFileSync(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
    run.options.logger.emit("drift.proposed", { ...proposal, proposalPath });
  } catch {
    // Drift evidence must never turn a deterministic replay failure into an internal error.
  }
}

function nearbyTextForTarget(target: TargetDescriptor): string | undefined {
  if (target.scope?.withinRowMatching) return target.scope.withinRowMatching;
  if (target.labelText) return target.labelText;
  const table = target.strategies.find((strategy) => strategy.kind === "table_cell");
  if (table?.kind === "table_cell") return table.rowMatch;
  const nearby = target.description?.match(/\bnear\s+(.+)$/i)?.[1];
  return nearby?.trim() || undefined;
}

function nearbyTextSimilarity(expected: string | undefined, actual: string): number {
  if (!expected) return 0;
  const normalize = (value: string): string[] => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const wanted = new Set(normalize(expected));
  const found = new Set(normalize(actual));
  if (wanted.size === 0 || found.size === 0) return 0;
  const overlap = [...wanted].filter((word) => found.has(word)).length;
  return overlap / Math.max(wanted.size, found.size);
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function hasTarget(action: Action): action is Action & { target: TargetDescriptor } {
  return "target" in action && action.target !== undefined;
}

// The app broke, as opposed to the flow hitting an expected outcome. Status first; error-page
// text is the fallback for legacy apps that serve a friendly error with HTTP 200.
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
  // domPath is already rooted in the run directory; writeText roots relative paths there too,
  // so handing it the full path would nest a second evidence/runs/<id> inside the first.
  const relative = path.relative(evidence.runDir, destination);
  try {
    evidence.writeText(relative, await surface.domSnapshot());
  } catch {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
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
    // `cap` is the tenant-RESOLVED capability. Writing it back whole would bake that tenant's
    // entry URL, labels and button names into the base artifact, so a single `--tenant beta`
    // run would permanently convert the shared artifact into a beta-only one. Only the run
    // counters belong on disk; everything else must survive untouched.
    try {
      const onDisk = JSON.parse(fs.readFileSync(capabilityPath, "utf8")) as Record<string, unknown>;
      onDisk.stability = cap.stability;
      fs.writeFileSync(capabilityPath, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");
    } catch {
      // Counters are bookkeeping; an unreadable artifact must not fail a run that already finished.
    }
  }
  void startedAt;
}

function emitDriftSummary(logger: RunLogger, tenant: string): void {
  const findings = new Map<string, { stepId: string; resolvedBy: string; strategyIndex: number; topRankedStrategy: string | null }>();
  try {
    let currentStepId: string | null = null;
    const lines = fs.readFileSync(logger.logPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "step.start" && typeof event.stepId === "string") currentStepId = event.stepId;
      if (event.type === "target.resolved" && currentStepId && Number(event.strategyIndex) > 0) {
        const attempts = Array.isArray(event.attempts) ? event.attempts as Array<Record<string, unknown>> : [];
        findings.set(`${currentStepId}:${String(event.resolvedBy)}`, {
          stepId: currentStepId,
          resolvedBy: typeof event.resolvedBy === "string" ? event.resolvedBy : "unknown",
          strategyIndex: Number(event.strategyIndex),
          topRankedStrategy: typeof attempts[0]?.strategy === "string" ? attempts[0].strategy : null,
        });
      }
      if (event.type === "step.end") currentStepId = null;
    }
  } catch {
    // The run log is best-effort evidence; the replay result remains authoritative.
  }
  logger.emit("drift.summary", { tenant, steps: [...findings.values()] });
}
