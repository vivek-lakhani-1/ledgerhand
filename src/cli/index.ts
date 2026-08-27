#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { startServer } from "../../target-app/server.js";
import { loadCatalog, type CapabilityCatalog } from "../catalog/catalog.js";
import { startConsoleServer } from "../console/console-server.js";
import { RunHost } from "../console/run-host.js";
import { EvidenceDir } from "../evidence/evidence.js";
import { RunLogger } from "../evidence/logger.js";
import { makeOperatorEscalator } from "../escalation/escalator.js";
import { InterventionStore } from "../escalation/intervention-store.js";
import { startOperatorServer } from "../escalation/operator-server.js";
import { AnthropicModelClient } from "../discover/model.js";
import { runDiscovery } from "../discover/agent.js";
import { recordCapability, writeCapability } from "../discover/recorder.js";
import { PolicyEngine } from "../policy/policy.js";
import { Redactor } from "../policy/redact.js";
import { replay } from "../replay/executor.js";
import { BrowserSession } from "../session/session.js";
import { Capability, Risk, type Capability as CapabilityValue, type ReplayResult } from "../schema/index.js";
import { lintCapability } from "../schema/lint.js";
import { WebSurface } from "../surface/web/web-surface.js";
import { withFramesetTextFallback } from "../surface/web/text-fallback.js";

type ReplayCommandOptions = {
  input?: string[];
  tenant?: string;
  inject?: string;
  operator?: boolean;
  headed?: boolean;
};

type DiscoverCommandOptions = {
  goal: string;
  url: string;
  input?: string[];
  operator?: boolean;
  maxSteps?: string;
  maxRisk?: string;
};

const program = new Command();
program
  .name("ledgerhand")
  .description("Discover, replay, and expose typed browser capabilities")
  .showHelpAfterError();

program
  .command("app")
  .description("Start the local legacy-bank stand-in")
  .option("--port <port>", "target app port", process.env.TARGET_APP_PORT ?? "4599")
  .action((options: { port: string }) => {
    loadEnvFile();
    const server = startServer(Number(options.port));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : Number(options.port);
    console.log(`[ledgerhand] target app listening at http://127.0.0.1:${port}`);
    return neverResolve();
  });

program
  .command("discover")
  .description("Use the model once, then write a typed capability artifact")
  .requiredOption("--goal <text>", "the operator goal")
  .requiredOption("--url <entry>", "the entry URL")
  .option("--input <key=value>", "declared input value; repeatable", collect, [])
  .option("--operator", "start an operator console while discovery runs")
  .option("--max-steps <count>", "maximum model tool calls", "25")
  .option("--max-risk <risk>", "highest action risk discovery may perform: safe, sensitive or irreversible", "safe")
  .action(async (options: DiscoverCommandOptions) => {
    loadEnvFile();
    const inputs = parsePairs(options.input ?? []);
    const runId = `discover-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const redactor = new Redactor({ secrets: secretValues(), piiValues: [] });
    const logger = new RunLogger(runId, redactor);
    const evidence = new EvidenceDir(runId, redactor);
    const entryOrigin = new URL(options.url).origin;
    // Some targets name their navigation links after the transactions behind them ("Funds
    // Transfer"), which the risk heuristic reads as the transaction itself. Raising maxRisk is
    // an explicit operator decision per discovery run, never a default.
    const maxRisk = Risk.parse(options.maxRisk ?? "safe");
    const policy = new PolicyEngine({ allowedOrigins: [entryOrigin], allowedPathPatterns: ["/**"], maxRisk }, { allowRisky: Boolean(options.operator) });
    const session = await BrowserSession.launch({
      headless: true,
      viewport: { width: 1280, height: 900 },
      sessionId: `session-${runId}`,
    });
    const surface = withFramesetTextFallback(new WebSurface({ session, policy, logger, caller: "automation" }), session);
    let operator: Awaited<ReturnType<typeof startOperatorServer>> | undefined;
    try {
      if (options.operator) {
        operator = await startOperatorServer({ store: new InterventionStore({ redactor }), policy });
        console.log(`[ledgerhand] operator console: ${operator.url}`);
      }
      const discovery = await runDiscovery({
        goal: options.goal,
        entryUrl: options.url,
        inputs,
        surface,
        policy,
        logger,
        evidence,
        model: new AnthropicModelClient(),
        maxSteps: Number(options.maxSteps ?? "25"),
      });
      if (discovery.status !== "completed" || !discovery.finish) {
        console.log(`[ledgerhand] discovery ${discovery.status}: ${discovery.reason ?? "no completed capability"}`);
        return;
      }
      const capability = recordCapability({
        trace: discovery.trace,
        goal: options.goal,
        entryUrl: options.url,
        inputs,
        inputDeclarations: discovery.inputs,
        finish: discovery.finish,
        surface,
        policy,
        runId,
        model: "claude-opus-5",
        surfaceSignature: { browser: "chromium", surface: surface.kind },
        logger,
      });
      const destination = writeCapability(capability, process.cwd());
      console.log(`[ledgerhand] discovery completed; wrote ${destination}`);
    } finally {
      await operator?.close().catch(() => undefined);
      await session.close();
    }
  });

program
  .command("replay")
  .description("Replay a capability artifact deterministically")
  .argument("<capabilityFile>")
  .option("--input <key=value>", "capability input; repeatable", collect, [])
  .option("--tenant <tenant>", "tenant override to resolve")
  .option("--inject <mode>", "demo injection mode")
  .option("--operator", "start the operator console and wait for human resolution")
  .option("--headed", "show the replay browser")
  .action(async (file: string, options: ReplayCommandOptions) => {
    loadEnvFile();
    const capability = readCapability(file);
    const inputs = parsePairs(options.input ?? []);
    if (options.inject) await inject(capability, options.inject);
    const result = await runCapability(capability, inputs, {
      tenant: options.tenant,
      headed: Boolean(options.headed),
      operator: Boolean(options.operator),
      capabilityPath: file,
    });
    printReplayResult(result);
    process.exitCode = resultExitCode(result);
  });

const catalogCommand = program.command("catalog").description("Inspect the agent-facing capability catalog");
catalogCommand
  .command("list")
  .action(() => {
    const catalog = reportCatalog(loadCatalog());
    console.log(JSON.stringify(catalog.list(), null, 2));
  });
catalogCommand
  .command("describe")
  .argument("<name>")
  .action((name: string) => {
    const catalog = reportCatalog(loadCatalog());
    console.log(JSON.stringify(catalog.describe(name), null, 2));
  });
catalogCommand
  .command("tools")
  .option("--include-draft", "include draft capabilities")
  .action((options: { includeDraft?: boolean }) => {
    const catalog = reportCatalog(loadCatalog());
    console.log(JSON.stringify(catalog.toToolSchemas({ includeDraft: options.includeDraft }), null, 2));
  });

program
  .command("invoke")
  .description("Invoke a catalog capability by name")
  .argument("<name>")
  .requiredOption("--input <json>", "JSON object of typed capability arguments")
  .option("--tenant <tenant>", "tenant override to resolve")
  .option("--headed", "show the replay browser")
  .action(async (name: string, options: { input: string; tenant?: string; headed?: boolean }) => {
    loadEnvFile();
    const catalog = reportCatalog(loadCatalog());
    const args = parseJsonObject(options.input);
    const capability = catalog.describe(name);
    const result = await runCapability(capability, args, { tenant: options.tenant, headed: Boolean(options.headed), operator: false });
    printReplayResult(result);
    process.exitCode = resultExitCode(result);
  });

program
  .command("console")
  .description("Start the browser console that runs capabilities and streams what they do")
  .option("--port <port>", "console port", process.env.CONSOLE_PORT ?? "4620")
  .option("--target-app <url>", "target app base URL", `http://127.0.0.1:${process.env.TARGET_APP_PORT ?? "4599"}`)
  .action(async (options: { port: string; targetApp: string }) => {
    loadEnvFile();
    const server = await startConsoleServer({
      port: Number(options.port),
      targetAppUrl: options.targetApp,
      host: new RunHost({ secrets: secretValues, rootDir: process.cwd() }),
    });
    console.log(`[ledgerhand] console at ${server.url}`);
    console.log(`[ledgerhand] target app expected at ${options.targetApp}`);
    return neverResolve();
  });

program
  .command("operator")
  .description("Start the standalone operator console")
  .option("--port <port>", "operator port", process.env.OPERATOR_PORT ?? "4610")
  .action(async (options: { port: string }) => {
    loadEnvFile();
    const redactor = new Redactor({ secrets: secretValues(), piiValues: [] });
    const operator = await startOperatorServer({
      store: new InterventionStore({ redactor }),
      port: Number(options.port),
    });
    console.log(`[ledgerhand] operator console at ${operator.url}`);
    return neverResolve();
  });

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  await program.parseAsync(["node", "ledgerhand", ...argv]);
}

async function runCapability(
  capability: CapabilityValue,
  inputs: Record<string, unknown>,
  options: { tenant?: string; headed: boolean; operator: boolean; capabilityPath?: string },
): Promise<ReplayResult> {
  const runId = `replay-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const redactor = new Redactor({ secrets: secretValues(), piiValues: [] });
  const logger = new RunLogger(runId, redactor);
  const evidence = new EvidenceDir(runId, redactor);
  const policy = new PolicyEngine(capability.policy);
  const session = await BrowserSession.launch({
    headless: !options.headed,
    viewport: capability.target.viewport,
    sessionId: `session-${runId}`,
  });
  const surface = withFramesetTextFallback(new WebSurface({ session, policy, logger, caller: "automation" }), session);
  let operator: Awaited<ReturnType<typeof startOperatorServer>> | undefined;
  try {
    let escalate: ReturnType<typeof makeOperatorEscalator> | undefined;
    if (options.operator) {
      const store = new InterventionStore({ redactor });
      operator = await startOperatorServer({ store, policy });
      console.log(`[ledgerhand] operator console: ${operator.url}`);
      escalate = makeOperatorEscalator({
        store,
        session,
        logger,
        evidence,
        operatorUrl: operator.url,
        timeoutMs: capability.policy.timeoutMs,
        policy,
      });
    }
    return await replay(capability, {
      inputs,
      tenant: options.tenant,
      surface,
      logger,
      evidence,
      policy,
      // Persist the stability counters back to the artifact. Without this the artifact
      // reports runs=0 forever, and the counters are meant to be the evidence a
      // draft->approved gate would eventually key off.
      ...(options.capabilityPath ? { capabilityPath: options.capabilityPath } : {}),
      ...(escalate ? { escalate } : {}),
    });
  } finally {
    await operator?.close().catch(() => undefined);
    await session.close();
  }
}

function readCapability(file: string): CapabilityValue {
  const filename = path.resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read capability ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = Capability.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid capability ${filename}: ${parsed.error.message}`);
  const problems = lintCapability(parsed.data);
  if (problems.length > 0) throw new Error(`Lint-invalid capability ${filename}: ${problems.join("; ")}`);
  return parsed.data;
}

function reportCatalog(catalog: CapabilityCatalog): CapabilityCatalog {
  for (const issue of catalog.invalid) {
    console.error(`[ledgerhand] invalid capability ${issue.file}: ${issue.error}${issue.problems ? ` (${issue.problems.join("; ")})` : ""}`);
  }
  return catalog;
}

async function inject(capability: CapabilityValue, mode: string): Promise<void> {
  const entry = capability.target.entryUrl.replace(/\{\{[^}]+\}\}/g, "placeholder");
  const endpoint = `${new URL(entry).origin}/_inject`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`Injection ${mode} failed at ${endpoint}: HTTP ${response.status}`);
  console.log(`[ledgerhand] injected ${mode} at ${endpoint}`);
}

function printReplayResult(result: ReplayResult): void {
  if (result.status === "success") {
    console.log(`[ledgerhand] SUCCESS outputs=${JSON.stringify(result.outputs)} steps=${result.stepsExecuted} run=${result.runId}`);
  } else if (result.status === "business_outcome") {
    console.log(`[ledgerhand] BUSINESS_OUTCOME ${result.code}: ${result.message} (legitimate answer; exit 0) run=${result.runId}`);
  } else if (result.status === "escalated") {
    console.log(`[ledgerhand] ESCALATED ${result.reason} at ${result.atStepId} (exit 2) run=${result.runId}`);
  } else {
    console.log(`[ledgerhand] FAILED ${result.error.class} at ${result.error.stepId ?? "run"}: ${result.error.message}`);
    console.log(`  expected: ${result.error.expected}`);
    console.log(`  observed: ${result.error.observed}`);
    console.log(`  run: ${result.runId}`);
  }
  console.log(`  evidence: ${result.evidenceDir}`);
}

function resultExitCode(result: ReplayResult): number {
  if (result.status === "escalated") return 2;
  if (result.status === "failed") return 1;
  return 0;
}

function parsePairs(pairs: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new Error(`Input must be key=value, received ${pair}`);
    values[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return values;
}

function parseJsonObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`--input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--input JSON must be an object");
  return parsed as Record<string, unknown>;
}

function secretValues(): string[] {
  return [process.env.APP_USER, process.env.APP_PASSWORD, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN]
    .filter((value): value is string => Boolean(value));
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function loadEnvFile(): void {
  const filename = path.join(process.cwd(), ".env");
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function neverResolve(): Promise<never> {
  return new Promise<never>(() => undefined);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((error) => {
    console.error(`[ledgerhand] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
