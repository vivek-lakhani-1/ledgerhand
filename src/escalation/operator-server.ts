import express, { type Express, type Response } from "express";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ControlLostError } from "../session/control.js";
import { BrowserSession } from "../session/session.js";
import type { RunLogger } from "../evidence/logger.js";
import type { PolicyEngine } from "../policy/policy.js";
import type { HumanAction } from "../schema/index.js";
import { settleAfterAction } from "../surface/web/web-surface.js";
import {
  InterventionNotFoundError,
  InterventionStateError,
  InterventionStore,
  type ResolutionDecision,
} from "./intervention-store.js";

type SessionRegistration = {
  session: BrowserSession;
  policy?: PolicyEngine;
};

type InterventionBinding = {
  sessionId: string;
  logger?: Pick<RunLogger, "emit">;
};

const sessions = new Map<string, SessionRegistration>();
const interventionBindings = new Map<string, InterventionBinding>();

/** The run registers its existing BrowserSession here; no operator route launches a context. */
export function registerSession(sessionId: string, session: BrowserSession, options: { policy?: PolicyEngine } = {}): void {
  sessions.set(sessionId, { session, policy: options.policy ?? sessions.get(sessionId)?.policy });
}

export function unregisterSession(sessionId: string): void {
  sessions.delete(sessionId);
  for (const [interventionId, binding] of interventionBindings) {
    if (binding.sessionId === sessionId) interventionBindings.delete(interventionId);
  }
}

export function registerInterventionSession(
  interventionId: string,
  sessionId: string,
  logger?: Pick<RunLogger, "emit">,
): void {
  interventionBindings.set(interventionId, { sessionId, logger });
}

export type OperatorServerOptions = {
  store: InterventionStore;
  policy?: PolicyEngine;
  port?: number;
  host?: string;
};

export type OperatorServer = {
  app: Express;
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
};

export function createOperatorApp(options: OperatorServerOptions): Express {
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDirectory(), "operator.html"));
  });

  app.get("/api/interventions", (_req, res) => {
    res.json(options.store.list().map((request) => decorateRequest(request)));
  });

  app.get("/api/interventions/:id", (req, res) => {
    const request = options.store.get(req.params.id);
    if (!request) {
      res.status(404).json({ error: "INTERVENTION_NOT_FOUND" });
      return;
    }
    res.json(decorateRequest(request));
  });

  app.post("/api/interventions/:id/claim", (req, res) => {
    void req;
    try {
      const session = sessionForIntervention(options.store, req.params.id);
      if (!session) throw new Error(`No live session is registered for intervention ${req.params.id}`);
      const claimed = options.store.claim(req.params.id);
      session.session.control.transferTo("human", req.params.id);
      res.json(decorateRequest(claimed));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/session/:id/frame", async (req, res) => {
    const registration = sessions.get(req.params.id);
    if (!registration) {
      res.status(404).json({ error: "SESSION_NOT_FOUND" });
      return;
    }
    try {
      const jpeg = await registration.session.page.screenshot({ type: "jpeg", quality: 60 });
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.send(jpeg);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/session/:id/input", async (req, res) => {
    const registration = sessions.get(req.params.id);
    if (!registration) {
      res.status(404).json({ error: "SESSION_NOT_FOUND" });
      return;
    }

    const session = registration.session;
    if (session.control.holder !== "human" || !session.control.interventionId) {
      res.status(409).json({ error: "CONTROL_LOST" });
      return;
    }

    const parsed = parseInput(req.body);
    if (!parsed) {
      res.status(400).json({ error: "INVALID_INPUT" });
      return;
    }

    const policy = registration.policy ?? options.policy;
      const policyDecision = policy
      ? policy.check(humanPolicyAction(parsed), {
        resolvedUrl: parsed.kind === "navigate" ? parsed.url : liveSessionUrl(session),
        risk: "safe",
        mode: "replay",
      })
      : { decision: "deny" as const, reason: "No policy is registered for this session" };
    if (policyDecision.decision !== "allow") {
      res.status(403).json({ error: "POLICY_BLOCKED", reason: policyDecision.reason });
      return;
    }

    const interventionId = session.control.interventionId;
    const at = new Date().toISOString();
    const action = { ...parsed, at } as HumanAction;
    try {
      const binding = interventionBindings.get(interventionId);
      options.store.appendHumanAction(interventionId, action);
      binding?.logger?.emit("human.action", { interventionId, action });
      await dispatchHumanInput(session, parsed);
      res.json({ ok: true, action });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/interventions/:id/resolve", (req, res) => {
    const decision = parseDecision(req.body);
    if (!decision) {
      res.status(400).json({ error: "INVALID_RESOLUTION" });
      return;
    }
    try {
      const resolved = options.store.resolve(req.params.id, decision);
      if (decision.decision === "resume" || decision.decision === "approve") {
        const registration = sessionForIntervention(options.store, req.params.id, false);
        registration?.session.control.transferTo("automation");
      }
      res.json(decorateRequest(resolved));
    } catch (error) {
      sendError(res, error);
    }
  });

  return app;
}

export async function startOperatorServer(options: OperatorServerOptions): Promise<OperatorServer> {
  const app = createOperatorApp(options);
  const port = options.port ?? Number(process.env.OPERATOR_PORT ?? "4610");
  const host = options.host ?? "127.0.0.1";
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    app,
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export const createOperatorServer = startOperatorServer;

function publicDirectory(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
}

function sessionForIntervention(
  store: InterventionStore,
  interventionId: string,
  required = true,
): SessionRegistration | undefined {
  const binding = interventionBindings.get(interventionId);
  const registration = binding ? sessions.get(binding.sessionId) : undefined;
  if (registration) return registration;
  for (const candidate of sessions.values()) {
    if (candidate.session.control.interventionId === interventionId) return candidate;
  }
  if (required) throw new Error(`No live session is registered for intervention ${interventionId}`);
  void store;
  return undefined;
}

function decorateRequest(request: ReturnType<InterventionStore["list"]>[number]): Record<string, unknown> {
  const binding = interventionBindings.get(request.id);
  const registration = binding ? sessions.get(binding.sessionId) : undefined;
  return {
    ...request,
    sessionId: binding?.sessionId,
    control: registration ? {
      holder: registration.session.control.holder,
      interventionId: registration.session.control.interventionId,
      since: registration.session.control.since,
    } : undefined,
  };
}

type ParsedInput =
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "navigate"; url: string };

function parseInput(value: unknown): ParsedInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.kind === "click" && typeof input.x === "number" && Number.isFinite(input.x) && typeof input.y === "number" && Number.isFinite(input.y)) {
    return { kind: "click", x: input.x, y: input.y };
  }
  if (input.kind === "type" && typeof input.text === "string") return { kind: "type", text: input.text };
  if (input.kind === "key" && typeof input.key === "string" && input.key.length > 0) return { kind: "key", key: input.key };
  if (input.kind === "navigate" && typeof input.url === "string") return { kind: "navigate", url: input.url };
  return null;
}

function parseDecision(value: unknown): { decision: ResolutionDecision; note?: string } | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.decision !== "resume" && body.decision !== "approve" && body.decision !== "abort") return null;
  if (body.note !== undefined && typeof body.note !== "string") return null;
  return { decision: body.decision, note: body.note as string | undefined };
}

function humanPolicyAction(input: ParsedInput): import("../schema/index.js").Action {
  const coordinateTarget = {
    role: "generic" as const,
    nameMatch: "exact" as const,
    framePath: [],
    strategies: [{ kind: "coordinate" as const, x: 0, y: 0, viewport: { width: 1, height: 1 }, confidence: 0, origin: "derived" as const }],
  };
  if (input.kind === "navigate") return { type: "navigate", url: input.url };
  if (input.kind === "click") return { type: "click", target: coordinateTarget };
  if (input.kind === "type") return { type: "type", target: coordinateTarget, value: input.text, clearFirst: false };
  return { type: "press", key: input.key };
}

function liveSessionUrl(session: BrowserSession): string {
  const child = [...session.page.frames()].reverse().find((frame) => frame !== session.page.mainFrame() && frame.url() && !frame.url().startsWith("about:"));
  return child?.url() ?? session.page.url();
}

async function dispatchHumanInput(session: BrowserSession, input: ParsedInput): Promise<void> {
  if (input.kind === "type") {
    await session.page.keyboard.type(input.text);
    return;
  }

  const frames = input.kind === "navigate" ? [session.page.mainFrame()] : session.page.frames();
  const settles = frames.map((frame) => settleAfterAction(frame, { timeoutMs: 5000 }));
  if (input.kind === "click") await session.page.mouse.click(input.x, input.y);
  else if (input.kind === "key") await session.page.keyboard.press(input.key);
  else await session.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 5000 });
  await Promise.all(settles);
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof InterventionNotFoundError) {
    res.status(404).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof InterventionStateError || error instanceof ControlLostError) {
    res.status(409).json({ error: error instanceof ControlLostError ? error.errorClass : error.code, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ error: "OPERATOR_ERROR", message });
}
