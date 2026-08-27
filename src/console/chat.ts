import { capabilityNameForTool, type AnthropicToolDefinition } from "../catalog/catalog.js";
import type { MessageParam, ModelClient, ToolUseBlock } from "../discover/model.js";
import type { ReplayResult } from "../schema/index.js";

/**
 * What the chat layer is allowed to do with a capability: invoke it by name and get the replay's
 * structured verdict back. The invoker sits on the same path as the HTTP invoke route, so every
 * guardrail below it - draft refusal, input validation, policy, approval gates - applies to the
 * chatbot exactly as it applies to any other API caller.
 */
export type ChatInvoker = (
  name: string,
  inputs: Record<string, unknown>,
) => Promise<{ runId: string; result: ReplayResult | null; error: string | null }>;

export type ChatInvocation = {
  capability: string;
  inputs: Record<string, unknown>;
  runId: string;
  status: string;
};

export type ChatTurnResult = {
  /** The full transcript including this turn, ready to send back on the next request. */
  messages: MessageParam[];
  reply: string;
  invocations: ChatInvocation[];
};

const CHAT_SYSTEM_PROMPT = [
  "You are the conversational front door to a catalog of recorded browser capabilities for the",
  "Meridian Core member-servicing console. Each tool replays a recorded, deterministic browser",
  "flow against the live console and returns a structured result.",
  "",
  "Rules:",
  "- Use the tools to act; never claim an action happened without a tool result to show for it.",
  "- Never invent input values. If the user has not given a required value, ask for it.",
  "- Amounts are plain dollar strings such as 25.00. Member numbers are six digits.",
  "- Report results plainly: quote confirmation numbers, balances, and names from the tool result.",
  "- A business_outcome result is a legitimate answer, not an error. Explain what the console",
  "  reported, such as a member not being found or insufficient funds.",
  "- An escalated result means the run stopped for a human: say why and do not retry it yourself.",
  "- A failed result is a real failure: report what was expected and observed, and the run id.",
  "",
  "Guide, don't interrogate. Fetch real options instead of asking the user to recall values:",
  "- When a transfer, hold, or share question names a member but not a full share ID (a full id",
  "  looks like 100234-S0001), first call the member shares tool and present its rows as a short",
  "  list of options — one line per share with the exact share id, type, and balance — then ask",
  "  the user to pick. Never guess or complete a partial share id yourself; map what the user",
  "  said (like 'MMKT4' or 'checking') onto the fetched list and confirm the match.",
  "- Offer sensible defaults the user can accept in one word: if no memo was given, propose one",
  "  like 'teller transfer' and ask them to confirm or change it. A memo must never be empty.",
  "",
  "Irreversible actions (funds transfer posts, holds):",
  "- Before invoking one, restate the exact details in one short block - from, to, amount, memo -",
  "  and wait for the user's explicit confirmation in their next message. Only skip the wait when",
  "  the current message already restated and confirmed those exact values.",
].join("\n");

export type ChatTurnOptions = {
  messages: MessageParam[];
  tools: AnthropicToolDefinition[];
  model: ModelClient;
  invoke: ChatInvoker;
  /** Upper bound on capability invocations in one turn; a runaway loop spends real money. */
  maxToolRounds?: number;
};

/**
 * Runs one user turn: ask the model, execute any tool calls through the invoker, and repeat
 * until the model answers in text. The transcript is client-held state - the page sends the
 * whole history each time - so the server stays stateless across turns.
 */
export async function runChatTurn(options: ChatTurnOptions): Promise<ChatTurnResult> {
  const messages: MessageParam[] = [...options.messages];
  const invocations: ChatInvocation[] = [];
  const maxRounds = options.maxToolRounds ?? 5;
  let reply = "";

  for (let round = 0; round <= maxRounds; round += 1) {
    const response = await options.model.next({
      system: CHAT_SYSTEM_PROMPT,
      messages,
      tools: options.tools,
    });

    const toolUses = response.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
    const text = response.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    messages.push({ role: "assistant", content: response.content });

    if (toolUses.length === 0) {
      reply = text || "(no reply)";
      break;
    }

    if (round === maxRounds) {
      reply = "I stopped before invoking further capabilities: this conversation turn already ran the maximum number of runs.";
      messages.push({ role: "user", content: toolResults(toolUses, () => ({ error: "Tool budget for this turn is exhausted" })) });
      break;
    }

    const results: Record<string, unknown> = {};
    for (const use of toolUses) {
      const outcome = await options.invoke(use.name, use.input);
      invocations.push({
        capability: capabilityNameForTool(use.name),
        inputs: use.input,
        runId: outcome.runId,
        status: outcome.result?.status ?? "errored",
      });
      results[use.id] = outcome.result ?? { error: outcome.error ?? "The run ended without a result" };
    }
    messages.push({ role: "user", content: toolResults(toolUses, (use) => results[use.id]) });
  }

  return { messages, reply, invocations };
}

function toolResults(
  toolUses: ToolUseBlock[],
  resultFor: (use: ToolUseBlock) => unknown,
): Array<{ type: "tool_result"; tool_use_id: string; content: string }> {
  return toolUses.map((use) => ({
    type: "tool_result" as const,
    tool_use_id: use.id,
    content: JSON.stringify(resultFor(use)),
  }));
}
