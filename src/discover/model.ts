import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";

export type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";

/**
 * The agent loop needs only the shape of a block, not the provider's full response type.
 * Declaring these locally keeps the seam stable across SDK releases (the SDK's ToolUseBlock
 * has gained required fields before) and keeps a test double from having to fabricate
 * provider-internal metadata it does not use.
 */
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
  };
};

export type ModelContentBlock = TextBlock | ToolUseBlock;

export interface ModelClient {
  next(req: {
    system: string;
    messages: MessageParam[];
    tools: ToolDef[];
  }): Promise<{ stopReason: string; content: Array<TextBlock | ToolUseBlock> }>;
}

export class DiscoveryConfigurationError extends Error {
  readonly code = "DISCOVERY_CONFIGURATION" as const;

  constructor(message = "Anthropic discovery requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN") {
    super(message);
    this.name = "DiscoveryConfigurationError";
  }
}

export class DiscoveryRefusedError extends Error {
  readonly code = "DISCOVERY_REFUSED" as const;
  readonly stopReason = "refusal" as const;

  constructor() {
    super("The discovery model refused the request");
    this.name = "DiscoveryRefusedError";
  }
}

export class ScriptedModelExhaustedError extends Error {
  readonly code = "SCRIPTED_MODEL_EXHAUSTED" as const;

  constructor() {
    super("ScriptedModelClient was called more times than its scripted tool calls");
    this.name = "ScriptedModelExhaustedError";
  }
}

export type ScriptedToolCall = {
  name: string;
  input: Record<string, unknown>;
  id?: string;
};

export class ScriptedModelClient implements ModelClient {
  private readonly scripted: readonly ScriptedToolCall[];
  private cursor = 0;

  constructor(calls: readonly ScriptedToolCall[]) {
    this.scripted = calls.map((call) => ({ ...call, input: { ...call.input } }));
  }

  get callsUsed(): number {
    return this.cursor;
  }

  async next(req: { system: string; messages: MessageParam[]; tools: ToolDef[] }): Promise<{
    stopReason: string;
    content: Array<TextBlock | ToolUseBlock>;
  }> {
    void req;
    const call = this.scripted[this.cursor];
    if (!call) throw new ScriptedModelExhaustedError();
    this.cursor += 1;
    return {
      stopReason: "tool_use",
      content: [
        {
          id: call.id ?? "scripted-tool-" + this.cursor,
          input: call.input,
          name: call.name,
          type: "tool_use",
        },
      ],
    };
  }
}

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  constructor() {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new DiscoveryConfigurationError();
    }
    this.client = new Anthropic();
  }

  async next(req: { system: string; messages: MessageParam[]; tools: ToolDef[] }): Promise<{
    stopReason: string;
    content: Array<TextBlock | ToolUseBlock>;
  }> {
    // Adaptive thinking lets the model decide reasoning depth per step rather than us
    // guessing a fixed budget; effort "high" suits a navigation task where a wrong click
    // costs more than the extra tokens.
    const response = await this.client.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      // Driving a UI is inherently sequential: every action can change the page, so a second
      // call decided from the same observation is already stale. Ask for one at a time.
      // The loop still handles parallel calls defensively if they arrive.
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });

    if (response.stop_reason === "refusal") {
      throw new DiscoveryRefusedError();
    }

    // Narrow the provider's richer block union down to the two kinds the loop acts on.
    // Thinking blocks are deliberately dropped here: the loop reasons about tool calls, and
    // the transcript records what was *done*, not the model's internal reasoning.
    const content: Array<TextBlock | ToolUseBlock> = [];
    for (const block of response.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    return { stopReason: response.stop_reason ?? "unknown", content };
  }
}
