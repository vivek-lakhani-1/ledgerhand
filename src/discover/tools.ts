import type { ToolDef } from "./model.js";

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDef["input_schema"] => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

export const discoveryTools: ToolDef[] = [
  {
    name: "observe",
    description: "Call this before any action and whenever a ref may be stale. It returns the current numbered controls, frame text, and screenshot.",
    input_schema: objectSchema({}),
  },
  {
    name: "click",
    description: "Call this only to activate a visible control from the latest observation, using its ref exactly. Do not invent a locator or ref.",
    input_schema: objectSchema(
      {
        ref: { type: "string", description: "The ref of the control in the latest observation." },
        why: { type: "string", description: "The state change this click is intended to make." },
      },
      ["ref", "why"],
    ),
  },
  {
    name: "type_text",
    description: "Call this only for a visible textbox from the latest observation, using its ref. Declare an input before using {{inputs.x}} and never echo secret values.",
    input_schema: objectSchema(
      {
        ref: { type: "string", description: "The textbox ref in the latest observation." },
        text: { type: "string", description: "A literal or an already-declared {{inputs.x}}/{{secrets.NAME}} reference." },
        why: { type: "string", description: "Why this value is being entered." },
      },
      ["ref", "text", "why"],
    ),
  },
  {
    name: "select_option",
    description: "Call this only for a visible select control from the latest observation, using its ref and an option value present in the page.",
    input_schema: objectSchema(
      {
        ref: { type: "string", description: "The select ref in the latest observation." },
        value: { type: "string", description: "The option value to select." },
        why: { type: "string", description: "Why this option is being selected." },
      },
      ["ref", "value", "why"],
    ),
  },
  {
    name: "press_key",
    description: "Call this to press a key on a ref from the latest observation, or globally only for a key that does not require a control. Re-observe after navigation.",
    input_schema: objectSchema(
      {
        key: { type: "string", description: "A Playwright-compatible key name." },
        ref: { type: "string", description: "Optional control ref from the latest observation." },
        why: { type: "string", description: "Why this key press is needed." },
      },
      ["key", "why"],
    ),
  },
  {
    name: "navigate",
    description: "Call this only to move to an allowlisted URL needed for the goal. Re-observe after navigation and never leave the target app origin or route allowlist.",
    input_schema: objectSchema(
      {
        url: { type: "string", description: "The destination URL." },
        why: { type: "string", description: "Why this navigation is needed." },
      },
      ["url", "why"],
    ),
  },
  {
    name: "extract",
    description: "Call this only when the requested value is visible and stable. Use the visible control ref and declare the output so it can be compiled into the capability.",
    input_schema: objectSchema(
      {
        ref: { type: "string", description: "The visible value/control ref in the latest observation." },
        outputName: { type: "string", description: "The output name to expose." },
        type: { type: "string", enum: ["string", "number", "boolean", "currency", "date"] },
        description: { type: "string", description: "What the output means." },
        transform: { type: "string", enum: ["none", "trim", "digits_only", "currency_to_number", "upper", "lower"] },
      },
      ["ref", "outputName", "type", "description", "transform"],
    ),
  },
  {
    name: "declare_input",
    description: "Call this before the first use of {{inputs.x}}. Declare the input name, type, description, and sensitivity without exposing a secret value.",
    input_schema: objectSchema(
      {
        name: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_]*$" },
        type: { type: "string", enum: ["string", "number", "boolean", "date", "enum"] },
        description: { type: "string" },
        sensitivity: { type: "string", enum: ["public", "pii", "secret"] },
        example: {},
      },
      ["name", "type", "description", "sensitivity"],
    ),
  },
  {
    name: "declare_outcome",
    description: "Call this when the page shows a meaningful business outcome. Declare its stable code and distinctive visible text so replay can classify it.",
    input_schema: objectSchema(
      {
        code: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" },
        description: { type: "string" },
        detectText: { type: "string", description: "Distinctive visible text that identifies the outcome." },
      },
      ["code", "description", "detectText"],
    ),
  },
  {
    name: "assert_checkpoint",
    description: "Call this after each meaningful state change when the expected text or heading is visible. Assert what proves the preceding action succeeded.",
    input_schema: objectSchema(
      {
        kind: { type: "string", enum: ["text_present", "text_absent"] },
        text: { type: "string" },
        why: { type: "string" },
      },
      ["kind", "text", "why"],
    ),
  },
  {
    name: "finish",
    description: "Call this once the goal is met and the success condition is currently visible. Include a concrete successCriterion for the recorded capability.",
    input_schema: objectSchema(
      {
        summary: { type: "string" },
        successCriterion: { type: "string", description: "Visible text or heading proving the goal is complete." },
      },
      ["summary", "successCriterion"],
    ),
  },
  {
    name: "request_human_help",
    description: "Call this instead of guessing when the page is ambiguous, blocked, risky, or does not provide enough evidence to continue.",
    input_schema: objectSchema(
      {
        reason: { type: "string" },
        whatIWasTrying: { type: "string" },
      },
      ["reason", "whatIWasTrying"],
    ),
  },
];

export const TOOLS = discoveryTools;
