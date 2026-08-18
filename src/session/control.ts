export type SessionHolder = "automation" | "human";
export type Holder = SessionHolder;

export type ControlChange = {
  sessionId: string;
  holder: SessionHolder;
  interventionId: string | undefined;
  since: string;
};

export class ControlLostError extends Error {
  readonly errorClass = "CONTROL_LOST" as const;

  constructor(expected: SessionHolder = "automation", actual: SessionHolder = "human") {
    super(`Session control is held by ${actual}; ${expected} cannot act`);
    this.name = "ControlLostError";
  }
}

export class SessionControl {
  readonly sessionId: string;
  private currentHolder: SessionHolder = "automation";
  private currentInterventionId: string | undefined;
  private changedAt: string;
  private readonly callbacks = new Set<(change: ControlChange) => void>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.changedAt = new Date().toISOString();
  }

  get holder(): SessionHolder {
    return this.currentHolder;
  }

  get interventionId(): string | undefined {
    return this.currentInterventionId;
  }

  get since(): string {
    return this.changedAt;
  }

  transferTo(holder: SessionHolder, interventionId?: string): void {
    this.currentHolder = holder;
    this.currentInterventionId = holder === "human" ? interventionId : undefined;
    this.changedAt = new Date().toISOString();

    const change: ControlChange = {
      sessionId: this.sessionId,
      holder: this.currentHolder,
      interventionId: this.currentInterventionId,
      since: this.changedAt,
    };
    for (const callback of this.callbacks) callback(change);
  }

  assertHeldBy(holder: SessionHolder): void {
    if (this.currentHolder !== holder) {
      throw new ControlLostError(holder, this.currentHolder);
    }
  }

  onChange(callback: (change: ControlChange) => void): void {
    this.callbacks.add(callback);
  }
}
