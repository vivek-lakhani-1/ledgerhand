import { z } from "zod";

import { Capability } from "./capability.js";
import { Checkpoint as CheckpointSchema } from "./checkpoint.js";
import { BusinessOutcome } from "./outcome.js";
import { InterventionReasonCode, InterventionRequest, HumanAction } from "./intervention.js";
import { OutputSpec, ParamSpec, Sensitivity } from "./io.js";
import { Action, RecoveryRule, Risk, Step } from "./step.js";
import { ControlRole, ResolutionStrategy, TargetDescriptor } from "./target.js";
import { ErrorClass, ReplayResult } from "./result.js";

export {
  Action,
  BusinessOutcome,
  Capability,
  ControlRole,
  ErrorClass,
  HumanAction,
  InterventionReasonCode,
  InterventionRequest,
  OutputSpec,
  ParamSpec,
  RecoveryRule,
  ReplayResult,
  ResolutionStrategy,
  Risk,
  Sensitivity,
  Step,
  TargetDescriptor,
};

export const Checkpoint = CheckpointSchema;

export { lintCapability } from "./lint.js";

export type Action = z.infer<typeof Action>;
export type BusinessOutcome = z.infer<typeof BusinessOutcome>;
export type Capability = z.infer<typeof Capability>;
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type ControlRole = z.infer<typeof ControlRole>;
export type ErrorClass = z.infer<typeof ErrorClass>;
export type HumanAction = z.infer<typeof HumanAction>;
export type InterventionReasonCode = z.infer<typeof InterventionReasonCode>;
export type InterventionRequest = z.infer<typeof InterventionRequest>;
export type OutputSpec = z.infer<typeof OutputSpec>;
export type ParamSpec = z.infer<typeof ParamSpec>;
export type RecoveryRule = z.infer<typeof RecoveryRule>;
export type ReplayResult = z.infer<typeof ReplayResult>;
export type ResolutionStrategy = z.infer<typeof ResolutionStrategy>;
export type Risk = z.infer<typeof Risk>;
export type Sensitivity = z.infer<typeof Sensitivity>;
export type Step = z.infer<typeof Step>;
export type TargetDescriptor = z.infer<typeof TargetDescriptor>;
