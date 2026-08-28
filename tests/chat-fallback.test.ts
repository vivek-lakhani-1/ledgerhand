import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startConsoleServer, type ConsoleServer } from "../src/console/console-server.js";
import { RunHost, type DiscoveryRunRequest, type RunSummary } from "../src/console/run-host.js";
import type { MessageParam, ModelClient, ModelContentBlock, ToolDef } from "../src/discover/model.js";

/**
 * The scenario behind these tests: every artifact in capabilities/ has been deleted (or the
 * directory itself is gone). The console must degrade to "Ledgerhand knows nothing yet" and
 * route the user into Discovery - never into an error.
 */

class PlaybackModel implements ModelClient {
  readonly seen: { system: string; messages: MessageParam[]; tools: ToolDef[] }[] = [];
  private cursor = 0;

  constructor(private readonly responses: Array<ModelContentBlock[]>) {}

  async next(req: { system: string; messages: MessageParam[]; tools: ToolDef[] }): Promise<{
    stopReason: string;
    content: ModelContentBlock[];
  }> {
    this.seen.push({ ...req, messages: [...req.messages] });
    const content = this.responses[this.cursor];
    if (!content) throw new Error("PlaybackModel exhausted");
    this.cursor += 1;
    return { stopReason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn", content };
  }
}

/** Records discovery requests instead of launching a browser and spending model credits. */
class StubDiscoveryHost extends RunHost {
  readonly discoveries: Array<Omit<DiscoveryRunRequest, "kind">> = [];

  override startDiscovery(request: Omit<DiscoveryRunRequest, "kind">): RunSummary {
    this.discoveries.push(request);
    return {
      runId: "discover-stub0001",
      kind: "discovery",
      status: "running",
      capabilityName: null,
      capabilityPath: null,
      goal: request.goal,
      entryUrl: request.entryUrl,
      tenant: null,
      inject: null,
      inputs: request.inputs,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      discovery: null,
      error: null,
      exitCode: null,
      operatorUrl: null,
      eventCount: 0,
      pendingIntervention: null,
      credentialProfile: null,
    };
  }
}

describe("the console with an empty or deleted capability catalog", () => {
  let server: ConsoleServer | null = null;
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-fallback-"));
    savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  async function boot(options: { model?: PlaybackModel; host?: RunHost; createDir?: boolean }): Promise<ConsoleServer> {
    const capabilitiesDir = path.join(tmpDir, "capabilities");
    if (options.createDir) fs.mkdirSync(capabilitiesDir, { recursive: true });
    server = await startConsoleServer({
      port: 0,
      capabilitiesDir,
      host: options.host,
      chatModel: options.model ? () => options.model as ModelClient : undefined,
    });
    return server;
  }

  it("plans Discovery for an unknown task instead of erroring", async () => {
    const booted = await boot({});
    const response = await fetch(`${booted.url}/api/automation/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "automatic", goal: "find the balance for member 100234", targetId: "meridian" }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { decision: { kind: string; secretNames?: string[] } };
    expect(payload.decision.kind).toBe("discovery");
    // Discovery inherits the target's configured credential env-var names, not a hardcoded pair.
    expect(payload.decision.secretNames).toEqual(["MERIDIAN_OPERATOR", "MERIDIAN_PASSWORD"]);
  });

  it("chat offers start_discovery as the only tool and starts it with the target's secrets", async () => {
    const model = new PlaybackModel([
      [{ type: "tool_use", id: "t1", name: "start_discovery", input: { goal: "find the balance for member 100234" } }],
      [{ type: "text", text: "No automation covers this yet, so I started Discovery — watch the stage." }],
    ]);
    const host = new StubDiscoveryHost();
    const booted = await boot({ model, host });
    const response = await fetch(`${booted.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "find balance for 100234" }],
        targetId: "meridian",
        mode: "automatic",
      }),
    });
    expect(response.status).toBe(200);
    const turn = await response.json() as { reply: string; invocations: { status: string; runId: string }[] };
    expect(turn.invocations).toEqual([
      expect.objectContaining({ capability: "discovery", status: "discovering", runId: "discover-stub0001" }),
    ]);
    expect(host.discoveries[0]?.secretNames).toEqual(["MERIDIAN_OPERATOR", "MERIDIAN_PASSWORD"]);
    expect(host.discoveries[0]?.entryUrl).toBe("https://web-sample.interface-hiring.com/signon");
    // With nothing in the catalog, exploration is the only tool the model is offered.
    expect(model.seen[0]?.tools.map((tool) => tool.name)).toEqual(["start_discovery"]);
  });

  it("behaves identically when the directory exists but holds no artifacts", async () => {
    const model = new PlaybackModel([
      [{ type: "tool_use", id: "t1", name: "start_discovery", input: { goal: "check a balance" } }],
      [{ type: "text", text: "Exploring now." }],
    ]);
    const host = new StubDiscoveryHost();
    const booted = await boot({ model, host, createDir: true });
    const response = await fetch(`${booted.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "check the balance for 100234" }],
        targetId: "meridian",
      }),
    });
    expect(response.status).toBe(200);
    expect(host.discoveries).toHaveLength(1);
  });

  it("keeps the catalog and targets routes serving when the directory is gone", async () => {
    const booted = await boot({});
    const catalog = await fetch(`${booted.url}/api/catalog`).then((r) => r.json());
    expect(catalog).toEqual([]);
    const targets = await fetch(`${booted.url}/api/targets`).then((r) => r.json()) as { id: string; approvedCount?: number }[];
    expect(Array.isArray(targets)).toBe(true);
    expect(targets.find((target) => target.id === "meridian")).toBeTruthy();
  });
});
