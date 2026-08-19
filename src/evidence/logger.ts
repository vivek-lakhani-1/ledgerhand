import fs from "node:fs";
import path from "node:path";
import { Redactor } from "../policy/redact.js";

export const EventType = [
  "run.start",
  "step.start",
  "policy.decision",
  "target.resolved",
  "action.performed",
  "checkpoint.evaluated",
  "outcome.matched",
  "recovery.applied",
  "retry",
  "escalation.raised",
  "human.action",
  "human.resolved",
  "drift.proposed",
  "drift.summary",
  // Emitted while compiling a trace into an artifact, when the recorder overrules something
  // the model asserted. These are the audit trail for "the model discovered, the system
  // validated" - without them a silently-corrected recording looks like a clean one.
  "recorder.outcome_dropped",
  "step.end",
  "run.end",
] as const;

export type EventType = (typeof EventType)[number];
export type EventPayload = Record<string, unknown>;

export type RunEvent = {
  ts: string;
  runId: string;
  seq: number;
  type: EventType;
  [key: string]: unknown;
};

export class RunLogger {
  readonly runId: string;
  readonly logPath: string;
  private readonly redactor: Redactor;
  private sequence = 0;

  constructor(runId: string, redactor: Redactor, rootDir = path.join("evidence", "runs")) {
    this.runId = runId;
    this.redactor = redactor;
    const runDir = path.join(rootDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    this.logPath = path.join(runDir, "run.jsonl");
  }

  registerSecret(value: string | undefined): void {
    this.redactor.registerSecret(value);
  }

  registerPii(value: string | undefined): void {
    this.redactor.registerPii(value);
  }

  emit(type: EventType, payload: EventPayload = {}): RunEvent {
    const event = this.redactor.redactJson({
      ts: new Date().toISOString(),
      runId: this.runId,
      seq: ++this.sequence,
      type,
      ...payload,
    }) as RunEvent;

    fs.appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, "utf8");
    if (type === "step.end") this.writeStepSummary(event);
    return event;
  }

  log(type: EventType, payload: EventPayload = {}): RunEvent {
    return this.emit(type, payload);
  }

  private writeStepSummary(event: RunEvent): void {
    const stepId = typeof event.stepId === "string" ? event.stepId : "?";
    const action = typeof event.action === "string" ? event.action : typeof event.description === "string" ? event.description : "step";
    const value = typeof event.value === "string" ? ` ← ${event.value}` : "";
    const result = typeof event.summary === "string" ? event.summary : event.postcondition === false ? "✗ postcondition" : "✓ postcondition";
    console.log(`[${stepId}] ${action}${value}  ${result}`);
  }
}
