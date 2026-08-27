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
});
