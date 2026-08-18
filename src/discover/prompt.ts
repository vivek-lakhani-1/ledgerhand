export type DiscoveryPromptOptions = {
  goal: string;
  entryUrl: string;
  targetApp?: string;
};

export function buildDiscoveryPrompt(options: DiscoveryPromptOptions): string {
  const targetApp = options.targetApp ?? "Meridian Member Services Console";
  return [
    "You are recording a safe, reviewable capability for " + targetApp + ".",
    "",
    "Goal: " + options.goal,
    "Entry URL: " + options.entryUrl,
    "",
    "Operator credentials are supplied as secrets. Reference them only as {{secrets.APP_USER}} and {{secrets.APP_PASSWORD}}. Never echo their values into a message, reason, summary, extracted output, or checkpoint.",
    "",
    "Call observe before acting. Choose controls by ref from the latest observation only; never author a CSS selector, XPath, coordinate, or other locator. Call declare_input before using {{inputs.x}}. After every meaningful state change, call assert_checkpoint for the visible evidence that proves it worked. When the goal is met, call finish with a concrete successCriterion that is true in the current page. If you are stuck or uncertain, call request_human_help rather than guessing.",
    "",
    "Keep actions within the supplied target app and policy. Re-observe after navigation or any substantial page change.",
  ].join("\n");
}

export const DISCOVERY_SYSTEM_PROMPT = buildDiscoveryPrompt({
  goal: "record the requested capability",
  entryUrl: "the supplied entry URL",
});
