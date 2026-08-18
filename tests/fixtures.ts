export const target = {
  role: "textbox",
  name: "Member ID",
  strategies: [
    {
      kind: "aria",
      role: "textbox",
      name: "Member ID",
      exact: true,
      confidence: 0.99,
      origin: "captured",
    },
  ],
} as const;

export function validCapability(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0.0",
    id: "cap_member_lookup",
    name: "member.savings_balance.lookup",
    title: "Look up a member balance",
    version: "1.0.0",
    description: "Looks up the savings balance for a member.",
    target: {
      surface: "legacy-web",
      app: "meridian-msc",
      entryUrl: "https://bank.example/t/alpha/msc/login",
    },
    inputs: [
      {
        name: "memberId",
        type: "string",
        description: "Member identifier",
        example: "10001",
      },
    ],
    outputs: [
      {
        name: "balance",
        type: "currency",
        description: "Current balance",
        source: { kind: "text_of", target },
      },
    ],
    secretsRequired: ["APP_USER", "APP_PASSWORD"],
    steps: [
      {
        id: "s1",
        description: "Navigate to the login page",
        action: { type: "navigate", url: "{{inputs.memberId}}" },
        postcondition: { kind: "title_matches", pattern: "Login" },
      },
      {
        id: "s2",
        description: "Enter member id",
        action: { type: "type", target, value: "{{inputs.memberId}}" },
        postcondition: { kind: "control_present", target },
      },
      {
        id: "s3",
        description: "Extract the balance",
        action: { type: "extract", outputs: ["balance"] },
      },
    ],
    outcomes: [],
    recoveries: [
      {
        id: "reauthenticate",
        description: "Log in again",
        when: { kind: "text_present", text: "Your session has expired" },
        do: [{ type: "type", target, value: "{{secrets.APP_USER}}" }],
      },
    ],
    successCheckpoint: { kind: "text_present", text: "Balance" },
    policy: { allowedOrigins: ["https://bank.example"] },
    provenance: {
      recordedAt: "2026-08-18T00:00:00.000Z",
      goal: "Look up a savings balance",
      model: "test",
      discoveryRunId: "run_discovery",
      surfaceSignature: { browser: "chromium" },
      llmStepCount: 3,
    },
    ...overrides,
  };
}
