import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runChatTurn } from "../src/console/chat.js";
import { startConsoleServer, type ConsoleServer } from "../src/console/console-server.js";
import type { RunHost, RunSummary } from "../src/console/run-host.js";
import type { MessageParam, ModelClient, ModelContentBlock, ToolDef } from "../src/discover/model.js";
import type { ReplayResult } from "../src/schema/index.js";

const balanceArtifact = path.join(process.cwd(), "capabilities", "member-savings-balance.v1.json");

/** Plays back a fixed sequence of model responses; chat tests script the conversation shape. */
class PlaybackModel implements ModelClient {
  readonly seen: { system: string; messages: MessageParam[]; tools: ToolDef[] }[] = [];
  private cursor = 0;

  constructor(private readonly responses: Array<ModelContentBlock[]>) {}

  async next(req: { system: string; messages: MessageParam[]; tools: ToolDef[] }): Promise<{
    stopReason: string;
    content: ModelContentBlock[];
  }> {
    // Snapshot the transcript: the loop mutates its message array after this call returns.
    this.seen.push({ ...req, messages: [...req.messages] });
    const content = this.responses[this.cursor];
    if (!content) throw new Error("PlaybackModel exhausted");
    this.cursor += 1;
    const hasTool = content.some((block) => block.type === "tool_use");
    return { stopReason: hasTool ? "tool_use" : "end_turn", content };
  }
}

const successResult: ReplayResult = {
  status: "success",
  runId: "replay-1",
  capability: { id: "cap", version: "1.0.0" },
  outputs: { primaryShareBalance: 52 },
  stepsExecuted: 5,
  durationMs: 900,
  evidenceDir: "evidence/runs/replay-1",
};

describe("a chat turn over the capability catalog", () => {
  const tools: ToolDef[] = [{
    name: "meridian.member.balance",
    description: "Read balances",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  }];

  it("invokes the capability the model chose and returns its final text", async () => {
    const model = new PlaybackModel([
      [{ type: "tool_use", id: "t1", name: "meridian.member.balance", input: { memberNumber: "100987" } }],
      [{ type: "text", text: "The balance is $52.00." }],
    ]);
    const invoked: string[] = [];
    const turn = await runChatTurn({
      messages: [{ role: "user", content: "What is 100987's balance?" }],
      tools: tools as never,
      model,
      invoke: async (name, inputs) => {
        invoked.push(name);
        expect(inputs).toEqual({ memberNumber: "100987" });
        return { runId: "replay-1", result: successResult, error: null };
      },
    });

    expect(invoked).toEqual(["meridian.member.balance"]);
    expect(turn.reply).toBe("The balance is $52.00.");
    expect(turn.invocations).toEqual([
      { capability: "meridian.member.balance", inputs: { memberNumber: "100987" }, runId: "replay-1", status: "success" },
    ]);
    // The tool result the model saw is the replay's structured verdict, not a paraphrase.
    const lastSeen = model.seen[1].messages.at(-1);
    expect(JSON.stringify(lastSeen)).toContain("primaryShareBalance");
  });

  it("hands the model an error result when the invoker cannot run the tool", async () => {
    const model = new PlaybackModel([
      [{ type: "tool_use", id: "t1", name: "not.in.catalog", input: {} }],
      [{ type: "text", text: "That capability does not exist." }],
    ]);
    const turn = await runChatTurn({
      messages: [{ role: "user", content: "Do something odd" }],
      tools: tools as never,
      model,
      invoke: async () => ({ runId: "", result: null, error: "Capability not.in.catalog is not invocable" }),
    });
    expect(turn.reply).toBe("That capability does not exist.");
    expect(turn.invocations[0].status).toBe("errored");
    expect(JSON.stringify(model.seen[1].messages.at(-1))).toContain("not invocable");
  });

  it("stops invoking once the per-turn tool budget is spent", async () => {
    const loop: ModelContentBlock[] = [{ type: "tool_use", id: "t", name: "meridian.member.balance", input: {} }];
    const model = new PlaybackModel([loop, loop, loop]);
    const turn = await runChatTurn({
      messages: [{ role: "user", content: "loop forever" }],
      tools: tools as never,
      model,
      maxToolRounds: 2,
      invoke: async () => ({ runId: "replay-n", result: successResult, error: null }),
    });
    expect(turn.invocations).toHaveLength(2);
    expect(turn.reply).toMatch(/maximum number of runs/);
  });

  it("offers start_discovery as a tool and fires it without blocking on the run", async () => {
    const model = new PlaybackModel([
      [{ type: "tool_use", id: "t1", name: "start_discovery", input: { goal: "Read the fraud review setting" } }],
      [{ type: "text", text: "Discovery started — watch the stage. The result will be a draft for your review." }],
    ]);
    const started: string[] = [];
    const turn = await runChatTurn({
      messages: [{ role: "user", content: "Yes, explore it" }],
      tools: tools as never,
      model,
      context: { targetName: "ClaimsDesk Legacy", targetOrigin: "https://claims.claimsdesk.example", mode: "automatic" },
      startDiscovery: (goal) => {
        started.push(goal);
        return { runId: "discover-1" };
      },
      invoke: async () => { throw new Error("no capability should be invoked"); },
    });
    expect(started).toEqual(["Read the fraud review setting"]);
    expect(turn.invocations).toEqual([
      { capability: "discovery", inputs: { goal: "Read the fraud review setting" }, runId: "discover-1", status: "discovering" },
    ]);
    // The model was told what it can and cannot claim: the target, and the draft lifecycle.
    expect(model.seen[0].tools.map((tool) => tool.name)).toContain("start_discovery");
    expect(model.seen[0].system).toContain("ClaimsDesk Legacy");
    expect(model.seen[0].system).toMatch(/draft/i);
    expect(JSON.stringify(model.seen[1].messages.at(-1))).toContain("human review");
  });

  it("never offers discovery in Replay Only mode", async () => {
    const model = new PlaybackModel([[{ type: "text", text: "No approved automation exists for that task." }]]);
    await runChatTurn({
      messages: [{ role: "user", content: "Read the fraud review setting" }],
      tools: tools as never,
      model,
      context: { targetName: "Meridian Core", mode: "replay_only" },
      invoke: async () => ({ runId: "", result: null, error: "unused" }),
    });
    expect(model.seen[0].tools.map((tool) => tool.name)).not.toContain("start_discovery");
    expect(model.seen[0].system).toMatch(/Replay Only/);
    expect(model.seen[0].system).toMatch(/never offer to explore/i);
  });

  it("parses a trailing OPTIONS line into tap buttons and strips it from the reply", async () => {
    const model = new PlaybackModel([[{
      type: "text",
      text: "Post $25.00 from 100234-S0001 to 100234-S0002 with memo \"teller transfer\"?\nOPTIONS: Yes, proceed | Cancel",
    }]]);
    const turn = await runChatTurn({
      messages: [{ role: "user", content: "transfer $25 from savings to checking for 100234" }],
      tools: tools as never,
      model,
      invoke: async () => ({ runId: "", result: null, error: "unused" }),
    });
    expect(turn.options).toEqual(["Yes, proceed", "Cancel"]);
    expect(turn.reply).not.toContain("OPTIONS:");
    expect(turn.reply).toContain("Post $25.00");
  });

  it("returns no options for a plain final answer", async () => {
    const model = new PlaybackModel([[{ type: "text", text: "The balance is $52.00." }]]);
    const turn = await runChatTurn({
      messages: [{ role: "user", content: "balance for 100987?" }],
      tools: tools as never,
      model,
      invoke: async () => ({ runId: "", result: null, error: "unused" }),
    });
    expect(turn.options).toEqual([]);
    // The system prompt teaches the marker, so a capable model actually uses it.
    expect(model.seen[0].system).toContain("OPTIONS:");
  });
});

describe("the chat route", () => {
  let server: ConsoleServer;
  let capabilitiesDir: string;
  let savedKey: string | undefined;

  beforeAll(() => {
    capabilitiesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-chat-"));
    fs.copyFileSync(balanceArtifact, path.join(capabilitiesDir, "member-savings-balance.v1.json"));
  });

  afterAll(() => {
    fs.rmSync(capabilitiesDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    server = await startConsoleServer({
      port: 0,
      capabilitiesDir,
      chatModel: () => new PlaybackModel([[{ type: "text", text: "Hello from the catalog." }]]),
    });
  });

  afterEach(async () => {
    await server.close();
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  async function postChat(body: unknown): Promise<{ status: number; json: any }> {
    const response = await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }

  it("requires a non-empty message history", async () => {
    expect((await postChat({})).status).toBe(400);
    expect((await postChat({ messages: [] })).status).toBe(400);
  });

  it("refuses without model credentials, with the reason", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { status, json } = await postChat({ messages: [{ role: "user", content: "hi" }] });
    expect(status).toBe(400);
    expect(json.error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("answers a turn and returns the transcript for the page to hold", async () => {
    const { status, json } = await postChat({ messages: [{ role: "user", content: "hi" }] });
    expect(status).toBe(200);
    expect(json.reply).toBe("Hello from the catalog.");
    expect(json.messages).toHaveLength(2);
    expect(json.invocations).toEqual([]);
  });

  it("scopes the tool catalog to the selected target", async () => {
    const models: PlaybackModel[] = [];
    await server.close();
    server = await startConsoleServer({
      port: 0,
      capabilitiesDir,
      chatModel: () => {
        const model = new PlaybackModel([[{ type: "text", text: "ok" }]]);
        models.push(model);
        return model;
      },
    });
    // The catalog holds one local-app capability. On the local target it is offered; on
    // Meridian the tool list is empty - one conversation cannot reach across targets.
    await postChat({ messages: [{ role: "user", content: "hi" }], targetId: "local-app" });
    const localTools = models[0].seen[0].tools.map((tool) => tool.name);
    expect(localTools).toContain("member__savings_balance__lookup");
    await postChat({ messages: [{ role: "user", content: "hi" }], targetId: "meridian" });
    const meridianTools = models[1].seen[0].tools.filter((tool) => tool.name !== "start_discovery");
    expect(meridianTools).toEqual([]);
    // A custom target (named by URL, not preset id) is scoped the same way: an unknown origin
    // gets no capability tools, only discovery.
    await postChat({ messages: [{ role: "user", content: "hi" }], entryUrl: "https://legacy.example.com/login" });
    const customToolNames = models[2].seen[0].tools.map((tool) => tool.name);
    expect(customToolNames).toEqual(["start_discovery"]);
    expect(models[2].seen[0].system).toContain("Custom Target");
  });

  it("fails closed when a named target cannot be resolved, instead of unscoping to the whole catalog", async () => {
    expect((await postChat({ messages: [{ role: "user", content: "hi" }], targetId: "stale-id" })).status).toBe(400);
  });

  it("offers no replay tools at all in Discover Only mode", async () => {
    const models: PlaybackModel[] = [];
    await server.close();
    server = await startConsoleServer({
      port: 0,
      capabilitiesDir,
      chatModel: () => {
        const model = new PlaybackModel([[{ type: "text", text: "ok" }]]);
        models.push(model);
        return model;
      },
    });
    await postChat({ messages: [{ role: "user", content: "look up a balance" }], targetId: "local-app", mode: "discover_only" });
    expect(models[0].seen[0].tools.map((tool) => tool.name)).toEqual(["start_discovery"]);
    expect(models[0].seen[0].system).toMatch(/Discover Only/);
  });

  it("refuses to invoke a capability that is not on the selected target, even if the model names it", async () => {
    // The catalog only holds a local-app capability; scoping to Meridian removes its tool,
    // but a transcript-primed model could still emit the name - the invoke callback is the gate.
    await server.close();
    server = await startConsoleServer({
      port: 0,
      capabilitiesDir,
      chatModel: () => new PlaybackModel([
        [{ type: "tool_use", id: "t1", name: "member__savings_balance__lookup", input: { memberId: "10001" } }],
        [{ type: "text", text: "That automation is not on this target." }],
      ]),
    });
    const { status, json } = await postChat({ messages: [{ role: "user", content: "balance" }], targetId: "meridian" });
    expect(status).toBe(200);
    expect(json.invocations[0].status).toBe("errored");
    expect(JSON.stringify(json.messages)).toContain("does not operate on the selected target");
  });

  it("reports an existing similar draft instead of silently rediscovering", async () => {
    fs.copyFileSync(
      path.join(process.cwd(), "capabilities", "member-savings-balance.discovered.v1.json"),
      path.join(capabilitiesDir, "member-savings-balance.discovered.v1.json"),
    );
    try {
      const startedRequests: unknown[] = [];
      const fakeHost = { startDiscovery(request: unknown) { startedRequests.push(request); return { runId: "discover-x" }; } };
      await server.close();
      server = await startConsoleServer({
        port: 0,
        capabilitiesDir,
        host: fakeHost as unknown as RunHost,
        chatModel: () => new PlaybackModel([
          [{ type: "tool_use", id: "t1", name: "start_discovery", input: { goal: "Look up a member's savings balance" } }],
          [{ type: "text", text: "A draft already covers this." }],
        ]),
      });
      const { json } = await postChat({ messages: [{ role: "user", content: "explore it" }], targetId: "local-app" });
      expect(startedRequests).toHaveLength(0);
      expect(json.invocations).toEqual([]);
      expect(JSON.stringify(json.messages)).toContain("draft_exists");
    } finally {
      fs.rmSync(path.join(capabilitiesDir, "member-savings-balance.discovered.v1.json"), { force: true });
    }
  });

  it("starts a discovery run through the host when the model calls start_discovery", async () => {
    const startedRequests: any[] = [];
    const fakeHost = {
      startDiscovery(request: unknown) {
        startedRequests.push(request);
        return { runId: "discover-chat-1" };
      },
    };
    await server.close();
    server = await startConsoleServer({
      port: 0,
      capabilitiesDir,
      host: fakeHost as unknown as RunHost,
      chatModel: () => new PlaybackModel([
        [{ type: "tool_use", id: "t1", name: "start_discovery", input: { goal: "Learn the fraud setting" } }],
        [{ type: "text", text: "Discovery started." }],
      ]),
    });
    const { status, json } = await postChat({
      messages: [{ role: "user", content: "yes, explore" }],
      targetId: "meridian",
      mode: "automatic",
    });
    expect(status).toBe(200);
    expect(json.invocations).toEqual([
      { capability: "discovery", inputs: { goal: "Learn the fraud setting" }, runId: "discover-chat-1", status: "discovering" },
    ]);
    expect(startedRequests[0]).toMatchObject({
      goal: "Learn the fraud setting",
      entryUrl: "https://web-sample.interface-hiring.com/signon",
      secretNames: ["MERIDIAN_OPERATOR", "MERIDIAN_PASSWORD"],
    });
  });
});
