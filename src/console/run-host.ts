import { randomUUID } from "node:crypto";
import { runDiscovery } from "../discover/agent.js";
import { AnthropicModelClient, type ModelClient } from "../discover/model.js";
import { recordCapability, writeCapability } from "../discover/recorder.js";
import { EvidenceDir } from "../evidence/evidence.js";
import { RunLogger, type RunEvent } from "../evidence/logger.js";
import { makeOperatorEscalator } from "../escalation/escalator.js";
import { InterventionStore } from "../escalation/intervention-store.js";
import { startOperatorServer } from "../escalation/operator-server.js";
import { PolicyEngine } from "../policy/policy.js";
import { Redactor } from "../policy/redact.js";
import { replay } from "../replay/executor.js";
import { BrowserSession } from "../session/session.js";
import type { Capability, ReplayResult } from "../schema/index.js";
import { WebSurface } from "../surface/web/web-surface.js";
import { withFramesetTextFallback } from "../surface/web/text-fallback.js";

export type RunKind = "replay" | "discovery";

export type ReplayRunRequest = {
  kind: "replay";
  capability: Capability;
  capabilityPath: string;
  inputs: Record<string, unknown>;
  tenant?: string;
  inject?: string;
  operator?: boolean;
};

export type DiscoveryRunRequest = {
  kind: "discovery";
  goal: string;
  entryUrl: string;
  inputs: Record<string, unknown>;
  maxSteps?: number;
  operator?: boolean;
};

export type RunRequest = ReplayRunRequest | DiscoveryRunRequest;

export type RunStatus = "starting" | "running" | "finished" | "stopped" | "errored";

/** What a discovery run produced, once it is over. */
export type DiscoveryOutcome = {
  status: "completed" | "escalated" | "stopped";
  reason: string | null;
  capabilityPath: string | null;
  traceLength: number;
};

export type RunSummary = {
  runId: string;
  kind: RunKind;
  status: RunStatus;
  /** Replay only; null while discovering, since the name is not known until the artifact exists. */
  capabilityName: string | null;
  capabilityPath: string | null;
  /** Discovery only. */
  goal: string | null;
  entryUrl: string | null;
  tenant: string | null;
  inject: string | null;
  inputs: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
  result: ReplayResult | null;
  discovery: DiscoveryOutcome | null;
  error: string | null;
  exitCode: number | null;
  operatorUrl: string | null;
  eventCount: number;
};

type LiveRun = {
  summary: RunSummary;
  events: RunEvent[];
  listeners: Set<(event: RunEvent) => void>;
  stateListeners: Set<(summary: RunSummary) => void>;
  session: BrowserSession | null;
  /** Present only while an operator console is attached; needed to abort a parked escalation. */
  store: InterventionStore | null;
  lastFrame: Buffer | null;
  stopRequested: boolean;
};

export function replayExitCode(result: ReplayResult): number {
  if (result.status === "escalated") return 2;
  if (result.status === "failed") return 1;
  return 0;
}

export type RunHostOptions = {
  secrets?: () => string[];
  /** Root the written capability lands under; writeCapability appends `capabilities/`. */
  rootDir?: string;
  /** Swapped in tests so a discovery run needs no API key and no network. */
  modelClient?: () => ModelClient;
};

/**
 * Owns replay and discovery runs launched from the console and keeps their events, live browser
 * frames and final results addressable by run id. The CLI runs one capability and exits; this has
 * to hold several runs open at once and let a browser attach to any of them partway through, so
 * events are buffered as well as broadcast — a viewer that connects at step 6 still gets steps 1-5.
 */
export class RunHost {
  private readonly runs = new Map<string, LiveRun>();
  private readonly secrets: () => string[];
  private readonly rootDir: string;
  private readonly modelClient: () => ModelClient;

  constructor(options: RunHostOptions = {}) {
    this.secrets = options.secrets ?? (() => []);
    this.rootDir = options.rootDir ?? process.cwd();
    this.modelClient = options.modelClient ?? (() => new AnthropicModelClient());
  }

  list(): RunSummary[] {
    return [...this.runs.values()]
      .map((run) => run.summary)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(runId: string): RunSummary | undefined {
    return this.runs.get(runId)?.summary;
  }

  events(runId: string): RunEvent[] {
    return this.runs.get(runId)?.events ?? [];
  }

  /**
   * Resolves once the run reaches a terminal state. The synchronous capability API sits on top
   * of the same host the console streams from, so an invocation is also a watchable run.
   */
  wait(runId: string): Promise<RunSummary> {
    const run = this.runs.get(runId);
    if (!run) return Promise.reject(new Error(`Run ${runId} was not found`));
    if (run.summary.finishedAt) return Promise.resolve(run.summary);
    return new Promise((resolve) => {
      const listener = (summary: RunSummary): void => {
        if (!summary.finishedAt) return;
        run.stateListeners.delete(listener);
        resolve(summary);
      };
      run.stateListeners.add(listener);
    });
  }

  /** Replays the buffered history to a new subscriber, then streams everything after it. */
  subscribe(runId: string, onEvent: (event: RunEvent) => void, onState: (summary: RunSummary) => void): () => void {
    const run = this.runs.get(runId);
    if (!run) return () => undefined;
    for (const event of run.events) onEvent(event);
    onState(run.summary);
    run.listeners.add(onEvent);
    run.stateListeners.add(onState);
    return () => {
      run.listeners.delete(onEvent);
      run.stateListeners.delete(onState);
    };
  }

  /**
   * Current view of the live browser. Falls back to the frame captured just before teardown so
   * a finished run still shows the page it ended on rather than an empty panel.
   */
  async frame(runId: string): Promise<Buffer | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.session && !run.session.page.isClosed()) {
      try {
        const jpeg = await run.session.page.screenshot({ type: "jpeg", quality: 60 });
        run.lastFrame = jpeg;
        return jpeg;
      } catch {
        return run.lastFrame;
      }
    }
    return run.lastFrame;
  }

  /**
   * Ends a run early by closing its browser out from under the executor. Discovery spends model
   * credits per tool call, so a runaway loop has to be interruptible without killing the server.
   * The in-flight operation fails, and the catch below reports `stopped` rather than `errored`.
   */
  async stop(runId: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (run.summary.status === "finished" || run.summary.status === "errored" || run.summary.status === "stopped") {
      return false;
    }
    run.stopRequested = true;
    // A run parked on an escalation is waiting on the intervention store, not on the browser, so
    // closing the page alone would leave it hanging until the policy timeout. Abort the pending
    // interventions first; that is the same decision the operator console's Abort button makes.
    for (const intervention of run.store?.list() ?? []) {
      if (intervention.status === "resolved" || intervention.status === "aborted") continue;
      try {
        run.store?.resolve(intervention.id, { decision: "abort", note: "Stopped from the console" });
      } catch {
        // Already resolved by a racing operator; nothing left to abort.
      }
    }
    if (run.session && !run.session.page.isClosed()) {
      run.lastFrame = await run.session.page.screenshot({ type: "jpeg", quality: 60 }).catch(() => run.lastFrame);
      await run.session.close().catch(() => undefined);
    }
    return true;
  }

  start(request: RunRequest): RunSummary {
    const runId = request.kind === "discovery"
      ? `discover-${randomUUID().replaceAll("-", "").slice(0, 12)}`
      : `replay-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const summary: RunSummary = {
      runId,
      kind: request.kind,
      status: "starting",
      capabilityName: request.kind === "replay" ? request.capability.name : null,
      capabilityPath: request.kind === "replay" ? request.capabilityPath : null,
      goal: request.kind === "discovery" ? request.goal : null,
      entryUrl: request.kind === "discovery" ? request.entryUrl : null,
      tenant: request.kind === "replay" ? request.tenant ?? null : null,
      inject: request.kind === "replay" ? request.inject ?? null : null,
      inputs: request.inputs,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      discovery: null,
      error: null,
      exitCode: null,
      operatorUrl: null,
      eventCount: 0,
    };
    const run: LiveRun = {
      summary,
      events: [],
      listeners: new Set(),
      stateListeners: new Set(),
      session: null,
      store: null,
      lastFrame: null,
      stopRequested: false,
    };
    this.runs.set(runId, run);
    void this.execute(run, request);
    return summary;
  }

  startReplay(request: Omit<ReplayRunRequest, "kind">): RunSummary {
    return this.start({ ...request, kind: "replay" });
  }

  startDiscovery(request: Omit<DiscoveryRunRequest, "kind">): RunSummary {
    return this.start({ ...request, kind: "discovery" });
  }

  private publishState(run: LiveRun): void {
    for (const listener of run.stateListeners) {
      try {
        listener(run.summary);
      } catch {
        // A disconnected viewer must not abort the run.
      }
    }
  }

  private async execute(run: LiveRun, request: RunRequest): Promise<void> {
    const redactor = new Redactor({ secrets: this.secrets(), piiValues: [] });
    const logger = new RunLogger(run.summary.runId, redactor);
    const evidence = new EvidenceDir(run.summary.runId, redactor);
    const policy = request.kind === "replay"
      ? new PolicyEngine(request.capability.policy)
      : new PolicyEngine(
        { allowedOrigins: [new URL(request.entryUrl).origin], allowedPathPatterns: ["/**"] },
        { allowRisky: Boolean(request.operator) },
      );

    const unsubscribe = logger.subscribe((event) => {
      run.events.push(event);
      run.summary.eventCount = run.events.length;
      for (const listener of run.listeners) {
        try {
          listener(event);
        } catch {
          // Same rule as above: viewers are observers, never blockers.
        }
      }
    });

    let session: BrowserSession | undefined;
    let operator: Awaited<ReturnType<typeof startOperatorServer>> | undefined;
    try {
      if (request.kind === "replay" && request.inject) await armInjection(request.capability, request.inject);

      session = await BrowserSession.launch({
        headless: true,
        viewport: request.kind === "replay" ? request.capability.target.viewport : { width: 1280, height: 900 },
        sessionId: `session-${run.summary.runId}`,
      });
      run.session = session;
      run.summary.status = "running";
      this.publishState(run);

      const surface = withFramesetTextFallback(new WebSurface({ session, policy, logger, caller: "automation" }), session);

      let store: InterventionStore | undefined;
      if (request.operator) {
        store = new InterventionStore({ redactor });
        run.store = store;
        operator = await startOperatorServer({ store, policy });
        run.summary.operatorUrl = operator.url;
        this.publishState(run);
      }

      if (request.kind === "replay") {
        const escalate = operator && store
          ? makeOperatorEscalator({
            store,
            session,
            logger,
            evidence,
            operatorUrl: operator.url,
            timeoutMs: request.capability.policy.timeoutMs,
            policy,
          })
          : undefined;
        const result = await replay(request.capability, {
          inputs: request.inputs,
          tenant: request.tenant,
          surface,
          logger,
          evidence,
          policy,
          capabilityPath: request.capabilityPath,
          ...(escalate ? { escalate } : {}),
        });
        run.summary.result = result;
        run.summary.exitCode = replayExitCode(result);
      } else {
        run.summary.discovery = await this.discover(request, { surface, logger, evidence, policy });
        run.summary.exitCode = run.summary.discovery.status === "completed" ? 0 : 2;
      }
      // Aborting an escalation makes replay return a normal `escalated` result rather than throw,
      // so a stopped run reaches here instead of the catch. Report what actually happened, and
      // exit 2 the way an escalation does: a human ended it, nothing was proven about the target.
      if (run.stopRequested) {
        run.summary.status = "stopped";
        run.summary.exitCode = 2;
      } else {
        run.summary.status = "finished";
      }
    } catch (error) {
      if (run.stopRequested) {
        run.summary.status = "stopped";
        run.summary.error = "Stopped by operator";
        run.summary.exitCode = 2;
      } else {
        run.summary.error = error instanceof Error ? error.message : String(error);
        run.summary.status = "errored";
        run.summary.exitCode = 1;
      }
    } finally {
      // Grab a final frame before teardown, otherwise the panel goes blank the instant a run ends
      // and the failing page - the thing worth looking at - is gone.
      if (session && !session.page.isClosed()) {
        run.lastFrame = await session.page.screenshot({ type: "jpeg", quality: 60 }).catch(() => run.lastFrame);
      }
      unsubscribe();
      await operator?.close().catch(() => undefined);
      await session?.close().catch(() => undefined);
      run.session = null;
      run.store = null;
      run.summary.finishedAt = new Date().toISOString();
      this.publishState(run);
    }
  }

  /**
   * Mirrors the CLI `discover` command: drive the model once, then compile the trace into an
   * artifact. A run that escalates or stops still returns its reason so the console can show why,
   * rather than reporting a bare failure for what is a normal discovery ending.
   */
  private async discover(
    request: DiscoveryRunRequest,
    context: {
      surface: WebSurface;
      logger: RunLogger;
      evidence: EvidenceDir;
      policy: PolicyEngine;
    },
  ): Promise<DiscoveryOutcome> {
    const discovery = await runDiscovery({
      goal: request.goal,
      entryUrl: request.entryUrl,
      inputs: request.inputs,
      surface: context.surface,
      policy: context.policy,
      logger: context.logger,
      evidence: context.evidence,
      model: this.modelClient(),
      maxSteps: request.maxSteps ?? 25,
    });

    if (discovery.status !== "completed" || !discovery.finish) {
      return {
        status: discovery.status,
        reason: discovery.reason ?? "no completed capability",
        capabilityPath: null,
        traceLength: discovery.trace.length,
      };
    }

    const capability = recordCapability({
      trace: discovery.trace,
      goal: request.goal,
      entryUrl: request.entryUrl,
      inputs: request.inputs,
      inputDeclarations: discovery.inputs,
      finish: discovery.finish,
      surface: context.surface,
      policy: context.policy,
      runId: context.logger.runId,
      model: "claude-opus-5",
      surfaceSignature: { browser: "chromium", surface: context.surface.kind },
      logger: context.logger,
    });
    return {
      status: "completed",
      reason: null,
      capabilityPath: writeCapability(capability, this.rootDir),
      traceLength: discovery.trace.length,
    };
  }
}

/**
 * The console sends a mode on every run, including `none`, so a sticky fault armed by an earlier
 * run is cleared instead of silently inheriting into the next one. That reset is a convenience,
 * so it is best-effort; asking for a real fault and not getting it would invalidate the run, so
 * that still fails loudly.
 */
async function armInjection(capability: Capability, mode: string): Promise<void> {
  const entry = capability.target.entryUrl.replace(/\{\{[^}]+\}\}/g, "placeholder");
  const endpoint = `${new URL(entry).origin}/_inject`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    if (mode === "none") return;
    throw new Error(`Injection ${mode} failed at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
