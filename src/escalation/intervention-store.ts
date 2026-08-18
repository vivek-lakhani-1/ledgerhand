import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { InterventionRequest, HumanAction, type InterventionRequest as InterventionRequestValue, type HumanAction as HumanActionValue } from "../schema/index.js";
import { Redactor } from "../policy/redact.js";

export type InterventionDraft = Omit<InterventionRequestValue, "id" | "createdAt" | "status" | "humanActions"> &
  Partial<Pick<InterventionRequestValue, "id" | "createdAt" | "status" | "humanActions">>;

export type ResolutionDecision = "resume" | "approve" | "abort";

export type InterventionStoreOptions = {
  redactor: Redactor;
  rootDir?: string;
};

export class InterventionNotFoundError extends Error {
  readonly code = "INTERVENTION_NOT_FOUND" as const;

  constructor(id: string) {
    super(`Intervention ${id} was not found`);
    this.name = "InterventionNotFoundError";
  }
}

export class InterventionStateError extends Error {
  readonly code = "INTERVENTION_STATE_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "InterventionStateError";
  }
}

export class InterventionResolutionTimeoutError extends Error {
  readonly code = "INTERVENTION_TIMEOUT" as const;

  constructor(id: string, timeoutMs: number) {
    super(`Intervention ${id} did not resolve within ${timeoutMs}ms`);
    this.name = "InterventionResolutionTimeoutError";
  }
}

/**
 * The store keeps the operator-facing representation redacted as well as redacting every
 * persisted write. That makes a later GET safe even when the caller passed a secret-bearing
 * request object to create().
 */
export class InterventionStore {
  private readonly requests = new Map<string, InterventionRequestValue>();
  private readonly rawRunIds = new Map<string, string>();
  private readonly events = new EventEmitter();
  private readonly redactor: Redactor;
  private readonly rootDir: string;

  constructor(options: InterventionStoreOptions) {
    this.redactor = options.redactor;
    this.rootDir = options.rootDir ?? "evidence";
  }

  create(request: InterventionDraft | InterventionRequestValue): string {
    const suppliedId = "id" in request && typeof request.id === "string" ? request.id : undefined;
    const id = suppliedId?.startsWith("iv_") ? suppliedId : `iv_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const candidate = {
      ...request,
      id,
      createdAt: request.createdAt ?? new Date().toISOString(),
      status: request.status ?? "open",
      humanActions: request.humanActions ?? [],
    };
    const stored = this.redactedParse(candidate);
    this.requests.set(id, stored);
    this.rawRunIds.set(id, candidate.runId);
    this.persistRun(candidate.runId);
    return id;
  }

  get(id: string): InterventionRequestValue | undefined {
    const request = this.requests.get(id);
    return request ? clone(request) : undefined;
  }

  list(): InterventionRequestValue[] {
    return [...this.requests.values()].map((request) => clone(request));
  }

  update(id: string, patch: Partial<InterventionRequestValue>): InterventionRequestValue {
    const current = this.require(id);
    const next = this.redactedParse({ ...current, ...patch, id: current.id, runId: current.runId });
    this.requests.set(id, next);
    this.persistRun(this.rawRunIds.get(id) ?? next.runId);
    return clone(next);
  }

  claim(id: string): InterventionRequestValue {
    const current = this.require(id);
    if (current.status !== "open") {
      throw new InterventionStateError(`Intervention ${id} cannot be claimed from status ${current.status}`);
    }
    return this.update(id, { status: "claimed" });
  }

  resolve(id: string, resolution: { decision: ResolutionDecision; note?: string }): InterventionRequestValue {
    const current = this.require(id);
    if (current.status === "resolved" || current.status === "aborted") {
      throw new InterventionStateError(`Intervention ${id} is already ${current.status}`);
    }
    const next = this.update(id, {
      status: resolution.decision === "abort" ? "aborted" : "resolved",
      resolution: {
        at: new Date().toISOString(),
        note: resolution.note ?? "",
        decision: resolution.decision,
      },
    });
    this.events.emit(this.resolutionEvent(id), {
      decision: resolution.decision,
      note: resolution.note,
    } satisfies { decision: ResolutionDecision; note?: string });
    return next;
  }

  appendHumanAction(id: string, action: HumanActionValue): InterventionRequestValue {
    const parsedAction = HumanAction.parse(action);
    const current = this.require(id);
    if (current.status !== "open" && current.status !== "claimed") {
      throw new InterventionStateError(`Human action cannot be appended to ${id} in status ${current.status}`);
    }
    return this.update(id, { humanActions: [...current.humanActions, parsedAction] });
  }

  waitForResolution(id: string, options: { timeoutMs: number }): Promise<{ decision: ResolutionDecision; note: string }> {
    const current = this.require(id);
    if (current.resolution) {
      return Promise.resolve({ decision: current.resolution.decision as ResolutionDecision, note: current.resolution.note });
    }

    const timeoutMs = Math.max(0, options.timeoutMs);
    return new Promise((resolve, reject) => {
      const eventName = this.resolutionEvent(id);
      const onResolution = (resolution: { decision: ResolutionDecision; note?: string }): void => {
        cleanup();
        resolve({ decision: resolution.decision, note: resolution.note ?? "" });
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new InterventionResolutionTimeoutError(id, timeoutMs));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.events.off(eventName, onResolution);
      };
      this.events.once(eventName, onResolution);
    });
  }

  private require(id: string): InterventionRequestValue {
    const request = this.requests.get(id);
    if (!request) throw new InterventionNotFoundError(id);
    return request;
  }

  private redactedParse(value: unknown): InterventionRequestValue {
    const redacted = this.redactor.redactJson(value) as Record<string, unknown>;
    const original = value as Record<string, unknown>;
    // These are evidence/session references, not user data. Keeping them byte-for-byte stable
    // is necessary for the operator GET to point at the files that were actually captured; the
    // payload and free-form context remain redacted by the shared Redactor.
    redacted.id = original.id;
    redacted.runId = original.runId;
    redacted.operatorUrl = original.operatorUrl;
    if (original.context && typeof original.context === "object" && redacted.context && typeof redacted.context === "object") {
      const originalContext = original.context as Record<string, unknown>;
      const redactedContext = redacted.context as Record<string, unknown>;
      redactedContext.screenshotPath = originalContext.screenshotPath;
      redactedContext.snapshotPath = originalContext.snapshotPath;
    }
    return InterventionRequest.parse(redacted);
  }

  private persistRun(runId: string): void {
    const runDir = path.join(this.rootDir, "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    const requests = [...this.requests.entries()]
      .filter(([id, request]) => (this.rawRunIds.get(id) ?? request.runId) === runId)
      .map(([, request]) => request);
    const redacted = this.redactor.redactJson(requests);
    fs.writeFileSync(path.join(runDir, "interventions.json"), `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
  }

  private resolutionEvent(id: string): string {
    return `resolution:${id}`;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
