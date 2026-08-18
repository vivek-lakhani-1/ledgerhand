import fs from "node:fs";
import path from "node:path";
import type { InterventionReasonCode, InterventionRequest } from "../schema/index.js";
import { InterventionReasonCode as InterventionReasonCodeSchema } from "../schema/index.js";
import type { EvidenceDir } from "../evidence/evidence.js";
import type { RunLogger } from "../evidence/logger.js";
import type { PolicyEngine } from "../policy/policy.js";
import type { BrowserSession } from "../session/session.js";
import { registerInterventionSession, registerSession } from "./operator-server.js";
import { InterventionStore, type ResolutionDecision } from "./intervention-store.js";
import type { EscalationRequest, Escalator } from "../replay/executor.js";

export type OperatorEscalatorOptions = {
  store: InterventionStore;
  session: BrowserSession;
  logger: RunLogger;
  evidence: EvidenceDir;
  operatorUrl: string;
  timeoutMs: number;
  policy?: PolicyEngine;
};

export function makeOperatorEscalator(options: OperatorEscalatorOptions): Escalator {
  // The escalator is the run's wiring point: it registers the already-owned session, never a
  // newly-created BrowserContext. A server-level policy can still be supplied when it starts.
  registerSession(options.session.sessionId, options.session, { policy: options.policy });
  return async (request: EscalationRequest): Promise<{ decision: ResolutionDecision; note?: string }> => {
    const captured = await captureEscalationEvidence(options, request);
    const intervention: Omit<InterventionRequest, "id"> = {
      createdAt: new Date().toISOString(),
      status: "open",
      origin: "replay",
      runId: request.runId,
      capabilityId: request.capability.id,
      capabilityVersion: request.capability.version,
      ...(request.goal ? { goal: request.goal } : {}),
      reason: {
        code: reasonCode(request.reason),
        detail: request.reason,
      },
      atStepId: request.atStepId,
      stepDescription: request.stepDescription,
      expected: request.expected,
      observed: request.observed,
      context: {
        url: liveSurfaceUrl(options.session),
        title: await liveSurfaceTitle(options.session),
        screenshotPath: captured.screenshotPath,
        snapshotPath: captured.snapshotPath,
        recentEvents: recentEvents(options.logger.logPath),
      },
      ...(request.action ? { proposedAction: request.action } : {}),
      operatorUrl: options.operatorUrl,
      humanActions: [],
    };

    const interventionId = options.store.create(intervention);
    registerInterventionSession(interventionId, options.session.sessionId, options.logger);
    options.logger.emit("escalation.raised", {
      interventionId,
      reason: request.reason,
      stepId: request.atStepId,
      screenshotPath: captured.screenshotPath,
      domPath: captured.snapshotPath,
    });
    const operatorLink = `${options.operatorUrl.replace(/\/$/, "")}/?intervention=${encodeURIComponent(interventionId)}`;
    console.log(`[ledgerhand] human intervention ${interventionId}: ${operatorLink}`);
    options.session.control.transferTo("human", interventionId);

    let resolution: { decision: ResolutionDecision; note: string };
    try {
      resolution = await options.store.waitForResolution(interventionId, { timeoutMs: options.timeoutMs });
    } catch (error) {
      options.session.control.transferTo("automation");
      const note = error instanceof Error ? error.message : String(error);
      options.logger.emit("human.resolved", { interventionId, decision: "abort", note, timeout: true });
      return { decision: "abort", note };
    }

    const latest = options.store.get(interventionId);
    const humanActions = latest?.humanActions ?? [];
    const humanActionsPath = path.join(options.evidence.runDir, "human-actions", `${interventionId}.json`);
    options.evidence.writeText(
      path.join("human-actions", `${interventionId}.json`),
      JSON.stringify({ interventionId, actions: humanActions }, null, 2),
    );
    options.logger.emit("human.resolved", {
      interventionId,
      decision: resolution.decision,
      note: resolution.note,
      humanActions: humanActions.length,
      humanActionsPath,
    });
    options.session.control.transferTo("automation");
    return { decision: resolution.decision, note: resolution.note };
  };
}

async function captureEscalationEvidence(
  options: OperatorEscalatorOptions,
  request: EscalationRequest,
): Promise<{ screenshotPath: string; snapshotPath: string }> {
  const screenshotPath = request.screenshotPath;
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  try {
    fs.writeFileSync(screenshotPath, await options.session.page.screenshot({ mask: [options.session.page.locator('input[type="password"]')] }));
  } catch {
    fs.writeFileSync(screenshotPath, Buffer.alloc(0));
  }

  const snapshotPath = request.domPath;
  const snapshot = await domSnapshot(options.session);
  const relative = path.relative(options.evidence.runDir, snapshotPath);
  options.evidence.writeText(relative.startsWith("..") ? path.basename(snapshotPath) : relative, snapshot);
  return { screenshotPath, snapshotPath };
}

async function domSnapshot(session: BrowserSession): Promise<string> {
  const chunks: string[] = [];
  for (const frame of session.page.frames()) {
    const html = await frame.locator("html").evaluate((element) => element.outerHTML).catch(() => "");
    chunks.push(`<!-- frame: ${frame.name() || "main"} -->\n${html}`);
  }
  return chunks.join("\n");
}

function recentEvents(logPath: string): unknown[] {
  try {
    return fs.readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-20)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

function reasonCode(reason: string): InterventionReasonCode {
  const parsed = InterventionReasonCodeSchema.safeParse(reason);
  return parsed.success ? parsed.data : "UNRECOVERABLE";
}

function liveSurfaceUrl(session: BrowserSession): string {
  const child = [...session.page.frames()].reverse().find((frame) => frame !== session.page.mainFrame() && frame.url() && !frame.url().startsWith("about:"));
  return child?.url() ?? session.page.url();
}

async function liveSurfaceTitle(session: BrowserSession): Promise<string> {
  const child = [...session.page.frames()].reverse().find((frame) => frame !== session.page.mainFrame() && frame.url() && !frame.url().startsWith("about:"));
  return child ? await child.title().catch(() => "") : await session.page.title().catch(() => "");
}
