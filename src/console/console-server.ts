import express, { type Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { injectionModes } from "../../target-app/inject.js";
import { capabilityNameForTool, loadCatalog } from "../catalog/catalog.js";
import { AnthropicModelClient, type ModelClient } from "../discover/model.js";
import { Capability, type Capability as CapabilityValue, type ReplayResult } from "../schema/index.js";
import { lintCapability } from "../schema/lint.js";
import { runChatTurn } from "./chat.js";
import { RunHost } from "./run-host.js";

export type ConsoleServerOptions = {
  host?: RunHost;
  port?: number;
  capabilitiesDir?: string;
  targetAppUrl?: string;
  /** Swapped in tests so a chat turn needs no API key and no network. */
  chatModel?: () => ModelClient;
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
    try {
      const turn = await runChatTurn({
        messages,
        tools: loadCatalog(capabilitiesDir).toToolSchemas(),
        model: chatModel(),
        invoke: async (toolName, inputs) => {
          const name = capabilityNameForTool(toolName);
          const found = findCapabilityByName(capabilitiesDir, name);
          if (!found || found.capability.approval === "draft") {
            return { runId: "", result: null, error: `Capability ${name} is not invocable` };
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

    if (kind === "discovery") {
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        res.status(400).json({ error: "ANTHROPIC_API_KEY is not set, so discovery cannot run." });
        return;
      }
      const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
      const entryUrl = typeof req.body?.entryUrl === "string" ? req.body.entryUrl.trim() : "";
      if (!goal || !entryUrl) {
        res.status(400).json({ error: "goal and entryUrl are required for a discovery run" });
        return;
      }
      try {
        new URL(entryUrl);
      } catch {
        res.status(400).json({ error: "entryUrl must be an absolute URL" });
        return;
      }
      const maxSteps = Number(req.body?.maxSteps ?? 25);
      res.status(201).json(host.startDiscovery({
        goal,
        entryUrl,
        inputs,
        maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? Math.min(Math.trunc(maxSteps), 60) : 25,
        operator,
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
    res.status(201).json(host.startReplay({
      capability,
      capabilityPath: resolvedPath,
      inputs,
      tenant: typeof req.body?.tenant === "string" && req.body.tenant ? req.body.tenant : undefined,
      inject: typeof req.body?.inject === "string" && req.body.inject ? req.body.inject : undefined,
      operator,
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

  app.get("/api/runs", (_req, res) => {
    res.json(host.list());
  });

  app.get("/api/runs/:id", (req, res) => {
    const summary = host.get(req.params.id);
    if (!summary) {
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    res.json({ ...summary, events: host.events(req.params.id) });
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
    const listener = app.listen(port, "127.0.0.1", () => resolve(listener));
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

export type CapabilityListing = {
  file: string;
  name: string;
  title: string;
  version: string;
  approval: string;
  description: string;
  inputs: { name: string; required: boolean; example?: unknown; description?: string }[];
  outputs: string[];
  /** "base" plus every tenant the artifact declares an override for. */
  tenants: string[];
  stepCount: number;
  hasIrreversibleStep: boolean;
  entryUrl: string;
};

function listCapabilities(directory: string): CapabilityListing[] {
  if (!fs.existsSync(directory)) return [];
  const listings: CapabilityListing[] = [];
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const capability = readCapability(path.join(directory, entry));
      listings.push({
        file: entry,
        name: capability.name,
        title: capability.title,
        version: capability.version,
        approval: capability.approval,
        description: capability.description,
        inputs: capability.inputs.map((input) => ({
          name: input.name,
          required: input.required,
          example: input.example,
          description: input.description,
        })),
        outputs: capability.outputs.map((output) => output.name),
        tenants: ["base", ...Object.keys(capability.tenantOverrides ?? {})],
        stepCount: capability.steps.length,
        hasIrreversibleStep: capability.steps.some((step) => step.risk === "irreversible"),
        entryUrl: capability.target.entryUrl,
      });
    } catch {
      // A capability that no longer validates should not blank the whole list.
    }
  }
  return listings.sort((a, b) => a.name.localeCompare(b.name));
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

/** Finds the artifact file whose capability name matches, since invocation is by name, not file. */
function findCapabilityByName(directory: string, name: string): { capability: CapabilityValue; path: string } | null {
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    const candidate = path.join(directory, entry);
    try {
      const capability = readCapability(candidate);
      if (capability.name === name) return { capability, path: candidate };
    } catch {
      // Invalid artifacts are already surfaced by the listing; skip them here.
    }
  }
  return null;
}

function readCapability(filename: string): CapabilityValue {
  const parsed = Capability.safeParse(JSON.parse(fs.readFileSync(filename, "utf8")) as unknown);
  if (!parsed.success) throw new Error(`Invalid capability ${path.basename(filename)}`);
  const problems = lintCapability(parsed.data);
  if (problems.length > 0) throw new Error(`Lint-invalid capability ${path.basename(filename)}: ${problems.join("; ")}`);
  return parsed.data;
}

/** Keeps a request from reaching a file outside the capabilities directory. */
function resolveWithin(directory: string, candidate: string): string {
  const root = path.resolve(directory);
  const resolved = path.resolve(root, path.basename(candidate));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Capability path is outside the catalog");
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicDirectory(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
}
