import express, { type Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { injectionModes } from "../../target-app/inject.js";
import { capabilityNameForTool, loadCatalog } from "../catalog/catalog.js";
import { AnthropicModelClient, type ModelClient } from "../discover/model.js";
import { InterventionNotFoundError, InterventionStateError } from "../escalation/intervention-store.js";
import type { Capability as CapabilityValue, ReplayResult } from "../schema/index.js";
import { runChatTurn } from "./chat.js";
import {
  findCapabilityByName,
  listCapabilities,
  listingFor,
  originOf,
  readCapability,
  resolveWithin,
} from "./listing.js";
import { findSimilarDraft } from "./matcher.js";
import { parseAutomationMode, planAutomation } from "./plan.js";
import { RunHost } from "./run-host.js";
import {
  applyCredentialProfile,
  capabilitiesForTarget,
  detectTarget,
  findTarget,
  loadTargetsConfig,
  summarizeTargets,
  type ResolvedTarget,
  type TargetsConfig,
} from "./targets.js";

export type { CapabilityListing } from "./listing.js";

export type ConsoleServerOptions = {
  host?: RunHost;
  port?: number;
  capabilitiesDir?: string;
  targetAppUrl?: string;
  /** Where finished runs' evidence lives; history is rebuilt from here across restarts. */
  evidenceDir?: string;
  /** Swapped in tests so a chat turn needs no API key and no network. */
  chatModel?: () => ModelClient;
  /** The target-system presets file; defaults to config/targets.json under the working directory. */
  targetsConfigPath?: string;
};

export type ConsoleServer = {
  app: Express;
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
};

export function createConsoleApp(options: ConsoleServerOptions = {}): { app: Express; host: RunHost } {
  const host = options.host ?? new RunHost();
  const capabilitiesDir = options.capabilitiesDir ?? path.join(process.cwd(), "capabilities");
  const targetAppUrl = options.targetAppUrl ?? `http://127.0.0.1:${process.env.TARGET_APP_PORT ?? "4599"}`;
  const evidenceDir = options.evidenceDir ?? path.join(process.cwd(), "evidence", "runs");
  const targetsConfigPath = options.targetsConfigPath ?? path.join(process.cwd(), "config", "targets.json");
  // Re-read per request like the catalog, so a config edit shows up without a restart. A
  // missing or invalid file degrades to "no presets" instead of taking the console down.
  const targetsConfig = (): TargetsConfig => {
    try {
      return loadTargetsConfig(targetsConfigPath);
    } catch {
      return { targets: [], customDefaults: { discoverySecretNames: ["APP_USER", "APP_PASSWORD"] } };
    }
  };
  const modelAvailable = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
  // The chat turns are short tool-picking exchanges; they do not need discovery's deep model.
  const chatModel = options.chatModel
    ?? (() => new AnthropicModelClient({ model: process.env.CHAT_MODEL ?? "claude-sonnet-5", effort: "medium" }));

  const app = express();
  app.use(express.json({ limit: "64kb" }));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDirectory(), "console.html"));
  });

  // The page asks what this install can actually do rather than assuming. Discovery needs a
  // model key, so the UI disables that tab with a reason instead of failing on click.
  app.get("/api/config", (_req, res) => {
    res.json({
      targetAppUrl,
      injectionModes,
      discoveryAvailable: Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN),
      discoveryUnavailableReason: "ANTHROPIC_API_KEY is not set, so discovery cannot run.",
      chatAvailable: Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN),
      chatUnavailableReason: "ANTHROPIC_API_KEY is not set, so the chatbot cannot run.",
    });
  });

  app.get("/api/capabilities", (_req, res) => {
    res.json(listCapabilities(capabilitiesDir));
  });

  // The full artifact, for the human review that stands between a draft and approval.
  app.get("/api/capabilities/:name", (req, res) => {
    const found = findCapabilityByName(capabilitiesDir, req.params.name);
    if (!found) {
      res.status(404).json({ error: `Capability ${req.params.name} was not found in the catalog` });
      return;
    }
    const file = path.basename(found.path);
    res.json({ file, listing: listingFor(file, found.capability), capability: found.capability });
  });

  // Promotion is the one mutation the console performs on an artifact, and it flips exactly
  // one field. Everything the reviewer approved - steps, policy, outcomes - stays byte-for-byte
  // what discovery recorded.
  app.post("/api/capabilities/:name/approve", (req, res) => {
    const found = findCapabilityByName(capabilitiesDir, req.params.name);
    if (!found) {
      res.status(404).json({ error: `Capability ${req.params.name} was not found in the catalog` });
      return;
    }
    if (found.capability.approval !== "draft") {
      res.status(409).json({ error: `Capability ${req.params.name} is ${found.capability.approval}, not a draft awaiting review` });
      return;
    }
    const raw = JSON.parse(fs.readFileSync(found.path, "utf8")) as Record<string, unknown>;
    raw.approval = "approved";
    fs.writeFileSync(found.path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const file = path.basename(found.path);
    res.json(listingFor(file, readCapability(found.path)));
  });

  // The configured target systems, decorated with what the catalog actually knows about each.
  // A target appearing here never implies an automation exists for it - the counts say that.
  app.get("/api/targets", (_req, res) => {
    res.json(summarizeTargets(targetsConfig().targets, listCapabilities(capabilitiesDir)));
  });

  // Resolves an entry URL to its target boundary: a configured preset when the origin matches,
  // otherwise a custom target locked to that origin alone. The page uses this instead of
  // carrying its own resolver, so client and server can never disagree about the boundary.
  app.get("/api/targets/detect", (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    const config = targetsConfig();
    const target = url ? detectTarget(config.targets, url, config.customDefaults) : null;
    if (!target) {
      res.status(400).json({ error: "url must be an absolute URL" });
      return;
    }
    res.json(target);
  });

  // The deciding step of the Automation flow: given a mode, target and goal, report whether
  // Ledgerhand already knows the task, needs the user to choose, should offer an existing
  // draft, or needs Discovery. It only plans - starting the run is a separate, explicit call.
  app.post("/api/automation/plan", (req, res) => {
    const mode = parseAutomationMode(req.body?.mode) ?? "automatic";
    const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
    const capabilityName = typeof req.body?.capabilityName === "string" && req.body.capabilityName
      ? req.body.capabilityName
      : undefined;
    if (!goal && !capabilityName) {
      res.status(400).json({ error: "goal is required to plan an automation" });
      return;
    }
    const resolved = resolveTargetForRequest(targetsConfig(), req.body);
    if ("error" in resolved) {
      res.status(400).json({ error: resolved.error });
      return;
    }
    const decision = planAutomation({
      mode,
      goal,
      target: resolved.target,
      listings: listCapabilities(capabilitiesDir),
      discoveryAvailable: modelAvailable(),
      ...(capabilityName ? { capabilityName } : {}),
    });
    res.json({ mode, target: resolved.target, decision });
  });

  // The agent-facing surface. An agent picks a capability by name from the catalog, invokes it
  // with typed inputs, and gets the replay's structured result back - it never learns anything
  // about the UI underneath. Draft artifacts are listed but not invocable: approval is a human
  // decision the API must not be able to skip.
  app.get("/api/catalog", (_req, res) => {
    const catalog = loadCatalog(capabilitiesDir);
    res.json(catalog.list());
  });

  app.get("/api/catalog/tools", (_req, res) => {
    const catalog = loadCatalog(capabilitiesDir);
    res.json(catalog.toToolSchemas());
  });

  app.post("/api/catalog/:name/invoke", async (req, res) => {
    const found = findCapabilityByName(capabilitiesDir, req.params.name);
    if (!found) {
      res.status(404).json({ error: `Capability ${req.params.name} was not found in the catalog` });
      return;
    }
    if (found.capability.approval === "draft") {
      res.status(403).json({ error: `Capability ${req.params.name} is a draft and cannot be invoked` });
      return;
    }
    const inputs = isRecord(req.body?.inputs) ? req.body.inputs : {};
    const tenant = typeof req.body?.tenant === "string" && req.body.tenant ? req.body.tenant : undefined;
    const finished = await invokeCapability(host, found, inputs, { tenant, operator: req.body?.operator === true });
    if (finished.result) {
      res.json({ runId: finished.runId, result: finished.result });
      return;
    }
    // The run ended without a replay result: the browser died, the process was stopped, or an
    // infrastructure error fired. That is the API's failure, not a statement about the target.
    res.status(502).json({ runId: finished.runId, error: finished.error });
  });

  // The chatbot is a thin demo driver over the same invoke path: the model chooses a capability,
  // the invocation runs through the identical guardrails, and the page holds the transcript.
  app.post("/api/chat", async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      res.status(400).json({ error: "ANTHROPIC_API_KEY is not set, so the chatbot cannot run." });
      return;
    }
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!messages || messages.length === 0) {
      res.status(400).json({ error: "messages is required and must be a non-empty array" });
      return;
    }
    // The chat honors the same selection the rest of the console does: one target per run
    // (preset id or custom entry URL, resolved by the same rule every other route uses), and
    // a mode that decides whether the model may offer Discovery at all. Naming a target that
    // cannot be resolved fails the request - never falls open to the whole catalog.
    const chatMode = parseAutomationMode(req.body?.mode) ?? "automatic";
    const namedTarget = Boolean(req.body?.targetId ?? req.body?.entryUrl);
    const chatResolved = namedTarget ? resolveTargetForRequest(targetsConfig(), req.body) : null;
    if (chatResolved && "error" in chatResolved) {
      res.status(400).json({ error: chatResolved.error });
      return;
    }
    const chatTarget = chatResolved?.target ?? null;
    let tools = loadCatalog(capabilitiesDir).toToolSchemas();
    if (chatTarget) {
      const allowed = new Set(
        capabilitiesForTarget(listCapabilities(capabilitiesDir), chatTarget).map((listing) => listing.name),
      );
      tools = tools.filter((tool) => allowed.has(capabilityNameForTool(tool.name)));
    }
    // Discover Only means exactly that: no replay tools at all, only exploration.
    if (chatMode === "discover_only") tools = [];
    try {
      const turn = await runChatTurn({
        messages,
        tools,
        model: chatModel(),
        context: {
          mode: chatMode,
          ...(chatTarget ? { targetName: chatTarget.name, targetOrigin: chatTarget.origin } : {}),
        },
        ...(chatTarget && chatMode !== "replay_only" && modelAvailable()
          ? {
            startDiscovery: (goal: string) => {
              // The same duplicate-draft rule the plan endpoint enforces: an existing
              // similar draft is offered for review, never silently rediscovered.
              const drafts = capabilitiesForTarget(listCapabilities(capabilitiesDir), chatTarget)
                .filter((listing) => listing.approval === "draft");
              const similar = findSimilarDraft(goal, drafts);
              if (similar) {
                return { existingDraft: { name: similar.listing.name, title: similar.listing.title } };
              }
              const started = host.startDiscovery({
                goal,
                entryUrl: chatTarget.entryUrl,
                inputs: {},
                maxSteps: 25,
                secretNames: chatTarget.discoverySecretNames,
              });
              return { runId: started.runId };
            },
          }
          : {}),
        invoke: async (toolName, inputs) => {
          const name = capabilityNameForTool(toolName);
          const found = findCapabilityByName(capabilitiesDir, name);
          if (!found || found.capability.approval === "draft") {
            return { runId: "", result: null, error: `Capability ${name} is not invocable` };
          }
          // The tool-list filter is advisory (a transcript can re-prime an old tool name);
          // the boundary is enforced here, where the run would actually start.
          if (chatTarget && originOf(found.capability.target.entryUrl) !== chatTarget.origin) {
            return { runId: "", result: null, error: `Capability ${name} does not operate on the selected target ${chatTarget.name}` };
          }
          return invokeCapability(host, found, inputs, {});
        },
      });
      res.json(turn);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/runs", (req, res) => {
    const kind = req.body?.kind === "discovery" ? "discovery" : "replay";
    const inputs = isRecord(req.body?.inputs) ? req.body.inputs : {};
    const operator = req.body?.operator === true;
    const targetId = typeof req.body?.targetId === "string" && req.body.targetId ? req.body.targetId : undefined;

    if (kind === "discovery") {
      if (!modelAvailable()) {
        res.status(400).json({ error: "ANTHROPIC_API_KEY is not set, so discovery cannot run." });
        return;
      }
      const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
      if (!goal) {
        res.status(400).json({ error: "goal and entryUrl (or a targetId) are required for a discovery run" });
        return;
      }
      // The same target-boundary rule as planning: preset id and/or entry URL resolve to one
      // origin, and an entry URL off the selected target's origin is refused.
      const resolved = resolveTargetForRequest(targetsConfig(), req.body);
      if ("error" in resolved) {
        res.status(400).json({
          error: resolved.error === "targetId or entryUrl is required"
            ? "goal and entryUrl (or a targetId) are required for a discovery run"
            : resolved.error,
        });
        return;
      }
      const target = resolved.target;
      const maxSteps = Number(req.body?.maxSteps ?? 25);
      const secretNames = Array.isArray(req.body?.secretNames)
        ? req.body.secretNames.filter((name: unknown): name is string =>
            typeof name === "string" && /^[A-Z][A-Z0-9_]*$/.test(name))
        : undefined;
      res.status(201).json(host.startDiscovery({
        goal,
        entryUrl: target.entryUrl,
        inputs,
        maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? Math.min(Math.trunc(maxSteps), 60) : 25,
        operator,
        secretNames: secretNames?.length ? secretNames : target.discoverySecretNames,
      }));
      return;
    }

    const file = typeof req.body?.capabilityPath === "string" ? req.body.capabilityPath : "";
    if (!file) {
      res.status(400).json({ error: "capabilityPath is required" });
      return;
    }
    let capability: CapabilityValue;
    let resolvedPath: string;
    try {
      resolvedPath = resolveWithin(capabilitiesDir, file);
      capability = readCapability(resolvedPath);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    // A draft is knowledge Ledgerhand recorded but no human has approved. Every invocation
    // surface refuses it - including this one, which historically did not check.
    if (capability.approval === "draft") {
      res.status(403).json({ error: `Capability ${capability.name} is a draft. Review and approve it before running Replay.` });
      return;
    }
    let credentialProfile: string | undefined;
    const credentialProfileId = typeof req.body?.credentialProfileId === "string" && req.body.credentialProfileId
      ? req.body.credentialProfileId
      : undefined;
    if (targetId) {
      const target = findTarget(targetsConfig().targets, targetId);
      if (!target) {
        res.status(400).json({ error: `Target ${targetId} is not configured` });
        return;
      }
      if (originOf(capability.target.entryUrl) !== target.origin) {
        res.status(400).json({ error: `Capability ${capability.name} does not operate on the selected target ${target.name}` });
        return;
      }
      if (credentialProfileId) {
        const profile = target.credentialProfiles.find((candidate) => candidate.id === credentialProfileId);
        if (!profile) {
          res.status(400).json({ error: `Credential profile ${credentialProfileId} is not configured for ${target.name}` });
          return;
        }
        try {
          capability = applyCredentialProfile(capability, profile);
        } catch (error) {
          res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
          return;
        }
        credentialProfile = profile.label;
      }
    } else if (credentialProfileId) {
      res.status(400).json({ error: "credentialProfileId requires a targetId" });
      return;
    }
    res.status(201).json(host.startReplay({
      capability,
      capabilityPath: resolvedPath,
      inputs,
      tenant: typeof req.body?.tenant === "string" && req.body.tenant ? req.body.tenant : undefined,
      inject: typeof req.body?.inject === "string" && req.body.inject ? req.body.inject : undefined,
      operator,
      ...(credentialProfile ? { credentialProfile } : {}),
    }));
  });

  app.post("/api/runs/:id/stop", async (req, res) => {
    if (!host.get(req.params.id)) {
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    const stopped = await host.stop(req.params.id);
    res.json({ stopped });
  });

  // The approval and human-help cards live in the main console; these routes let it read and
  // resolve a paused run's interventions without the separate operator page. Only approve and
  // abort are accepted here - resuming after a manual takeover stays an operator-console call.
  app.get("/api/runs/:id/interventions", (req, res) => {
    if (!host.get(req.params.id)) {
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    res.json(host.interventions(req.params.id));
  });

  app.post("/api/runs/:id/interventions/:interventionId/resolve", (req, res) => {
    if (!host.get(req.params.id)) {
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    const decision = req.body?.decision;
    if (decision !== "approve" && decision !== "abort") {
      res.status(400).json({ error: "decision must be approve or abort" });
      return;
    }
    const note = typeof req.body?.note === "string" ? req.body.note : undefined;
    try {
      res.json(host.resolveIntervention(req.params.id, req.params.interventionId, { decision, note }));
    } catch (error) {
      if (error instanceof InterventionStateError) {
        res.status(409).json({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof InterventionNotFoundError) {
        res.status(404).json({ error: error.code, message: error.message });
        return;
      }
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Live runs come from the host; everything older is rebuilt from the evidence directory, so
  // history survives a console restart. A run id present in both is live - the host knows more.
  app.get("/api/runs", (_req, res) => {
    const live = host.list();
    const liveIds = new Set(live.map((run) => run.runId));
    const historical = listHistoryRuns(evidenceDir).filter((run) => !liveIds.has(run.runId));
    res.json([...live, ...historical].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")));
  });

  app.get("/api/runs/:id", (req, res) => {
    const summary = host.get(req.params.id);
    if (summary) {
      res.json({ ...summary, events: host.events(req.params.id) });
      return;
    }
    const historical = readHistoryRun(evidenceDir, req.params.id);
    if (!historical) {
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    res.json(historical);
  });

  // What a finished run left behind, so a reviewer can open the artifacts a run is judged by.
  app.get("/api/runs/:id/evidence", (req, res) => {
    const runDir = evidenceRunDir(evidenceDir, req.params.id);
    if (!runDir) {
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    const listing = (sub: string): string[] => {
      const dir = path.join(runDir, sub);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).sort();
    };
    res.json({
      screenshots: listing("screenshots"),
      dom: listing("dom"),
      files: ["run.jsonl", "result.json", "capability.json"].filter((file) => fs.existsSync(path.join(runDir, file))),
    });
  });

  app.get("/api/runs/:id/evidence/:sub/:name", (req, res) => {
    const runDir = evidenceRunDir(evidenceDir, req.params.id);
    const sub = req.params.sub;
    if (!runDir || !["screenshots", "dom"].includes(sub)) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    const file = path.join(runDir, sub, path.basename(req.params.name));
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    res.sendFile(file);
  });

  app.get("/api/runs/:id/evidence/:name", (req, res) => {
    const runDir = evidenceRunDir(evidenceDir, req.params.id);
    const name = path.basename(req.params.name);
    if (!runDir || !["run.jsonl", "result.json", "capability.json"].includes(name)) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    const file = path.join(runDir, name);
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    res.type(name.endsWith(".jsonl") ? "text/plain" : "application/json");
    res.sendFile(file);
  });

  // Server-sent events: the run pushes as it goes rather than the page polling for changes,
  // so a step appears the moment the executor emits it.
  app.get("/api/runs/:id/stream", (req, res) => {
    if (!host.get(req.params.id)) {
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (kind: string, payload: unknown): void => {
      res.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const unsubscribe = host.subscribe(
      req.params.id,
      (event) => send("run-event", event),
      (summary) => send("run-state", summary),
    );
    // Proxies and browsers drop an idle event stream; a comment line keeps it open without
    // showing up as an event.
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    });
  });

  app.get("/api/runs/:id/frame", async (req, res) => {
    if (!host.get(req.params.id)) {
      // Not a live run: fall back to the last screenshot its evidence recorded, so a
      // historical run still shows the page it ended on.
      const runDir = evidenceRunDir(evidenceDir, req.params.id);
      const shots = runDir && fs.existsSync(path.join(runDir, "screenshots"))
        ? fs.readdirSync(path.join(runDir, "screenshots")).sort()
        : [];
      const last = shots.at(-1);
      if (runDir && last) {
        res.sendFile(path.join(runDir, "screenshots", last));
        return;
      }
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    const jpeg = await host.frame(req.params.id);
    if (!jpeg) {
      // The run exists but its browser has not painted yet. That is a normal moment during
      // startup, not an error, and 404 would make the poller log a failure every second.
      res.status(204).end();
      return;
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.send(jpeg);
  });

  return { app, host };
}

export async function startConsoleServer(options: ConsoleServerOptions = {}): Promise<ConsoleServer> {
  const { app } = createConsoleApp(options);
  const port = options.port ?? Number(process.env.CONSOLE_PORT ?? "4620");
  const server = await new Promise<Server>((resolve, reject) => {
    // Express 5.1's listen callback is error-first; resolving unconditionally here once made a
    // failed bind (port already taken) report success with a URL nothing was serving.
    const listener = app.listen(port, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve(listener)));
    listener.on("error", reject);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    app,
    server,
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Resolves the target boundary a request names, either by preset id or by detecting it from
 * an entry URL. When both are supplied they must agree; the entry URL may narrow the preset's
 * default entry point but never move the run to another origin.
 */
function resolveTargetForRequest(
  config: TargetsConfig,
  body: unknown,
): { target: ResolvedTarget } | { error: string } {
  const request = isRecord(body) ? body : {};
  const targetId = typeof request.targetId === "string" && request.targetId ? request.targetId : undefined;
  const entryUrl = typeof request.entryUrl === "string" && request.entryUrl ? request.entryUrl.trim() : undefined;

  if (targetId) {
    const target = findTarget(config.targets, targetId);
    if (!target) return { error: `Target ${targetId} is not configured` };
    if (!entryUrl) return { target };
    let origin: string;
    try {
      origin = new URL(entryUrl).origin;
    } catch {
      return { error: "entryUrl must be an absolute URL" };
    }
    if (origin !== target.origin) {
      return { error: `Entry URL ${entryUrl} is outside the selected target ${target.name} (${target.origin})` };
    }
    return { target: { ...target, entryUrl } };
  }

  if (entryUrl) {
    const target = detectTarget(config.targets, entryUrl, config.customDefaults);
    if (!target) return { error: "entryUrl must be an absolute URL" };
    return { target: { ...target, entryUrl } };
  }

  return { error: "targetId or entryUrl is required" };
}

/** Resolves a run id to its evidence directory, refusing anything that is not a direct child. */
function evidenceRunDir(evidenceDir: string, runId: string): string | null {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(runId)) return null;
  const dir = path.join(evidenceDir, runId);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : null;
}

type HistoryRun = ReturnType<RunHost["list"]>[number];

/**
 * Rebuilds a run summary from what the run wrote to disk. The log's first event carries the
 * start time and (for discovery) the goal; result.json is the replay's structured verdict. A
 * run directory with a log but no clean ending is reported as errored rather than guessed at.
 */
function readHistoryRun(evidenceDir: string, runId: string): (HistoryRun & { events: unknown[] }) | null {
  const runDir = evidenceRunDir(evidenceDir, runId);
  if (!runDir) return null;
  const logPath = path.join(runDir, "run.jsonl");
  if (!fs.existsSync(logPath)) return null;

  const events: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A torn final line from a killed process must not hide the rest of the log.
    }
  }
  if (events.length === 0) return null;
  const first = events[0];
  const last = events[events.length - 1];

  let result: HistoryRun["result"] = null;
  const resultPath = path.join(runDir, "result.json");
  if (fs.existsSync(resultPath)) {
    try {
      result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as HistoryRun["result"];
    } catch {
      result = null;
    }
  }

  let capabilityName: string | null = null;
  const capabilityPath = path.join(runDir, "capability.json");
  if (fs.existsSync(capabilityPath)) {
    try {
      capabilityName = (JSON.parse(fs.readFileSync(capabilityPath, "utf8")) as { name?: string }).name ?? null;
    } catch {
      capabilityName = null;
    }
  }

  const kind = runId.includes("discover") ? "discovery" as const : "replay" as const;
  const ended = result !== null || last.type === "run.end";
  // Discovery writes no result.json; its run.end line carries the outcome the page shows.
  let discovery: HistoryRun["discovery"] = null;
  if (kind === "discovery" && last.type === "run.end") {
    const reason = [...events].reverse().find((event) => event.type === "escalation.raised")?.reason;
    discovery = {
      status: last.status === "completed" ? "completed" : last.status === "escalated" ? "escalated" : "stopped",
      reason: typeof reason === "string" ? reason : null,
      capabilityPath: null,
      traceLength: typeof last.traceEntries === "number" ? last.traceEntries : events.length,
    };
  }
  return {
    runId,
    kind,
    status: ended ? "finished" : "errored",
    capabilityName,
    capabilityPath: null,
    goal: kind === "discovery" && typeof first.goal === "string" ? first.goal : null,
    entryUrl: kind === "discovery" && typeof first.entryUrl === "string" ? first.entryUrl : null,
    tenant: typeof first.tenant === "string" && first.tenant !== "base" ? first.tenant : null,
    inject: null,
    inputs: {},
    startedAt: String(first.ts ?? ""),
    finishedAt: String(last.ts ?? ""),
    result,
    discovery,
    error: ended ? null : "The run ended without recording a result",
    exitCode: null,
    operatorUrl: null,
    eventCount: events.length,
    pendingIntervention: null,
    credentialProfile: null,
    events,
  };
}

function listHistoryRuns(evidenceDir: string): HistoryRun[] {
  if (!fs.existsSync(evidenceDir)) return [];
  const summaries: HistoryRun[] = [];
  for (const entry of fs.readdirSync(evidenceDir)) {
    const run = readHistoryRun(evidenceDir, entry);
    if (run) {
      const { events, ...summary } = run;
      void events;
      summaries.push(summary);
    }
  }
  return summaries;
}

/** Starts a replay for a resolved capability and waits for its terminal summary. */
async function invokeCapability(
  host: RunHost,
  found: { capability: CapabilityValue; path: string },
  inputs: Record<string, unknown>,
  options: { tenant?: string; operator?: boolean },
): Promise<{ runId: string; result: ReplayResult | null; error: string | null }> {
  const started = host.startReplay({
    capability: found.capability,
    capabilityPath: found.path,
    inputs,
    tenant: options.tenant,
    operator: options.operator === true,
  });
  const finished = await host.wait(started.runId);
  return {
    runId: finished.runId,
    result: finished.result,
    error: finished.result ? null : finished.error ?? `Run ended with status ${finished.status} and no result`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicDirectory(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
}
