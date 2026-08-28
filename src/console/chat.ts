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
  /**
   * Quick replies for this turn, parsed from the model's structured OPTIONS line. The page
   * renders them as one-tap buttons, so a confirmation is a click on "Yes, proceed" rather
   * than something the user has to type.
   */
  options: string[];
};

const CHAT_SYSTEM_PROMPT = [
  "You are Ledgerhand, the conversational front door to a catalog of approved browser",
  "automations for legacy enterprise systems. Each tool replays a recorded, deterministic",
  "browser flow against the live target system and returns a structured result.",
  "",
  "When a tool covers the user's task, say you found an existing automation, name it (the tool",
  "name with dots restored, e.g. a tool a__b__c is the automation a.b.c), and run it — as in:",
  "\"I found an existing automation for this task: <automation name>. Running it now.\" The run",
  "appears on the live stage next to this chat.",
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
  "Bias to action, not to questions. When the user's request already contains everything a",
  "tool needs (or a sensible default fills the gap), run it immediately and say what you are",
  "doing in one short line — do not ask permission first, do not double-check values they",
  "already gave, and never ask two questions where zero or one would do. Ask only when a",
  "required value is genuinely missing or genuinely ambiguous. Read-only tasks (balances,",
  "lookups, listings) are never confirmed — just run them and report.",
  "",
  "Guide, don't interrogate. Fetch real options instead of asking the user to recall values:",
  "- When a transfer, hold, or share question names a member but not a full share ID (a full id",
  "  looks like 100234-S0001), first call the member shares tool and present its rows as a short",
  "  list of options — one line per share with the exact share id, type, and balance — then ask",
  "  the user to pick. Never guess or complete a partial share id yourself; if what the user",
  "  said (like 'MMKT4' or 'checking') matches exactly one fetched share, use it and say which",
  "  one you matched instead of asking.",
  "- Apply sensible defaults and say so rather than asking: if no memo was given, use",
  "  'teller transfer' and mention it in the confirmation. A memo must never be empty.",
  "",
  "Irreversible actions (funds transfer posts, holds, opening shares) are the ONE exception to",
  "the no-confirmation rule:",
  "- Before invoking one, restate the exact details in one short block - from, to, amount, memo -",
  "  and wait for the user's explicit confirmation in their next message. Only skip the wait when",
  "  the current message already restated and confirmed those exact values. This is the only",
  "  moment you ask for confirmation; everything else just runs.",
  "",
  "Whenever your reply asks the user to pick from a small set (a share, a reason code, a",
  "branch) or to confirm an action, end the message with one final line of exactly this form:",
  "OPTIONS: <first> | <second> | <third>",
  "with 2-4 short options (under 40 characters each) matching what you asked. For a",
  "confirmation the options are exactly: OPTIONS: Yes, proceed | Cancel",
  "The console renders that line as tap buttons; never refer to the OPTIONS line in prose,",
  "and never emit it when your reply is a final answer that asks nothing.",
].join("\n");

/**
 * The model marks choice-shaped replies with a trailing "OPTIONS: a | b" line. Parsing it
 * here (not in the page) keeps the reply contract typed: the UI gets clean prose plus a
 * list, and a model that skips the marker degrades to plain text, never to a broken parse.
 */
export function extractOptions(reply: string): { reply: string; options: string[] } {
  const match = reply.match(/(?:^|\n)\s*OPTIONS:\s*([^\n]+)\s*$/i);
  if (!match || typeof match.index !== "number") return { reply, options: [] };
  const options = match[1]
    .split("|")
    .map((option) => option.trim())
    .filter((option) => option.length > 0 && option.length <= 60)
    .slice(0, 4);
  if (options.length < 2) return { reply, options: [] };
  return { reply: reply.slice(0, match.index).trimEnd(), options };
}

export type ChatTurnOptions = {
  messages: MessageParam[];
  tools: AnthropicToolDefinition[];
  model: ModelClient;
  invoke: ChatInvoker;
  /** Upper bound on capability invocations in one turn; a runaway loop spends real money. */
  maxToolRounds?: number;
  /** The console's current selection, woven into the system prompt so replies match the UI. */
  context?: { targetName?: string; targetOrigin?: string; mode?: string };
  /**
   * Starts a Discovery run and returns immediately (the run streams to the stage; this
   * request must not block on it), or reports that an existing draft already covers the
   * task. Absent when discovery is unavailable or the mode is Replay Only — the model then
   * has no way to trigger exploration.
   */
  startDiscovery?: (goal: string) => { runId: string } | { existingDraft: { name: string; title: string } };
};

const startDiscoveryTool: AnthropicToolDefinition = {
  name: "start_discovery",
  description: [
    "Start a Discovery run: the AI explores the selected target system once to learn a new",
    "workflow. Returns immediately with a run id; the run is watched on the live stage.",
    "Discovery produces a DRAFT automation that a human must review and approve before it",
    "becomes a normal, callable automation.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      goal: { type: "string", description: "What the automation should accomplish, in one sentence." },
    },
    required: ["goal"],
    additionalProperties: false,
  },
};

function systemPromptFor(options: ChatTurnOptions): string {
  const lines = [CHAT_SYSTEM_PROMPT];
  const context = options.context ?? {};
  if (context.targetName) {
    lines.push(
      "",
      `The user's selected target system is ${context.targetName}${context.targetOrigin ? ` (${context.targetOrigin})` : ""}.`,
      "Only automations for this target are available in this conversation; each run is locked",
      "to this one target.",
    );
  }
  if (context.mode === "replay_only") {
    lines.push(
      "",
      "Automation mode is Replay Only: run approved automations only. If no automation covers",
      "the task, say that no approved automation exists for it and that Discovery can be",
      "started from Manual Run — never offer to explore yourself.",
    );
  } else if (context.mode === "discover_only") {
    lines.push(
      "",
      "Automation mode is Discover Only: never run an existing automation. Choosing this mode",
      "IS the user's consent to explore — when the user states a task, call start_discovery",
      "immediately and tell them in one line that Ledgerhand is exploring to learn the",
      "workflow and that the result is a draft they will review and approve. Do not ask",
      "permission first and never ask twice. If start_discovery is unavailable, explain that",
      "Discovery can be started from the Manual Run panel.",
    );
  } else if (options.startDiscovery) {
    lines.push(
      "",
      "Automatic mode's rule for an unknown task is: start Discovery. If no tool covers the",
      "task, call start_discovery right away and tell the user in one line that no approved",
      "automation exists yet, so Ledgerhand is exploring the target to learn it — the result",
      "is a draft they review and approve before normal use. Do not ask permission first; the",
      "mode already authorizes exploration. Only hold off if the user explicitly said not to",
      "explore.",
    );
  } else {
    lines.push(
      "",
      "If no tool covers the task, say you don't have an approved automation for it and that a",
      "new one can be created with Discovery from the Manual Run panel.",
    );
  }
  return lines.join("\n");
}

/**
 * Runs one user turn: ask the model, execute any tool calls through the invoker, and repeat
 * until the model answers in text. The transcript is client-held state - the page sends the
 * whole history each time - so the server stays stateless across turns.
 */
export async function runChatTurn(options: ChatTurnOptions): Promise<ChatTurnResult> {
  const messages: MessageParam[] = [...options.messages];
  const invocations: ChatInvocation[] = [];
  const maxRounds = options.maxToolRounds ?? 5;
  const tools = options.startDiscovery ? [...options.tools, startDiscoveryTool] : options.tools;
  const system = systemPromptFor(options);
  let reply = "";

  for (let round = 0; round <= maxRounds; round += 1) {
    const response = await options.model.next({
      system,
      messages,
      tools,
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
      if (use.name === startDiscoveryTool.name) {
        // Discovery is fire-and-watch: the chat reply must not block for the minutes the
        // exploration takes, so the tool result is just the run reference.
        const goal = typeof use.input?.goal === "string" ? use.input.goal : "";
        if (!goal || !options.startDiscovery) {
          results[use.id] = { error: "A goal is required to start discovery" };
          continue;
        }
        const started = options.startDiscovery(goal);
        if ("existingDraft" in started) {
          results[use.id] = {
            status: "draft_exists",
            draft: started.existingDraft,
            note: "An unapproved draft automation likely already covers this task. Tell the user to review and approve it (Manual Run → Drafts awaiting review) instead of rediscovering.",
          };
          continue;
        }
        invocations.push({ capability: "discovery", inputs: { goal }, runId: started.runId, status: "discovering" });
        results[use.id] = {
          runId: started.runId,
          status: "discovering",
          note: "Discovery started; it runs on the live stage. The result will be a draft automation requiring human review and approval.",
        };
        continue;
      }
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

  const parsed = extractOptions(reply);
  return { messages, reply: parsed.reply, invocations, options: parsed.options };
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
