import type { Action, Risk } from "../schema/index.js";

export type PolicyDecision = {
  decision: "allow" | "deny" | "require_approval";
  reason: string;
};

export type PolicyConfig = {
  allowedOrigins: string[];
  allowedPathPatterns?: string[];
  allowedActions?: string[];
  maxRisk?: Risk;
  requireApprovalFor?: Risk[];
  maxSteps?: number;
  timeoutMs?: number;
};

export type PolicyCheckContext = {
  resolvedUrl?: string;
  risk: Risk;
  mode: "discovery" | "replay";
};

const defaultAllowedActions = [
  "navigate",
  "click",
  "type",
  "select",
  "press",
  "wait",
  "extract",
  "assert",
];

const riskRank: Record<Risk, number> = {
  safe: 0,
  sensitive: 1,
  irreversible: 2,
};

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`${source}$`);
}

export function matchesPathGlob(pathname: string, pattern: string): boolean {
  return globToRegExp(pattern).test(pathname);
}

function normalizeConfig(config: PolicyConfig): Required<PolicyConfig> {
  return {
    allowedOrigins: config.allowedOrigins,
    allowedPathPatterns: config.allowedPathPatterns ?? ["/**"],
    allowedActions: config.allowedActions ?? defaultAllowedActions,
    maxRisk: config.maxRisk ?? "safe",
    requireApprovalFor: config.requireApprovalFor ?? ["irreversible"],
    maxSteps: config.maxSteps ?? 60,
    timeoutMs: config.timeoutMs ?? 120000,
  };
}

export class PolicyEngine {
  readonly config: Required<PolicyConfig>;
  readonly allowRisky: boolean;

  constructor(config: PolicyConfig, options: { allowRisky?: boolean } = {}) {
    this.config = normalizeConfig(config);
    this.allowRisky = options.allowRisky ?? false;
  }

  check(action: Action, ctx: PolicyCheckContext): PolicyDecision {
    if (!this.config.allowedActions.includes(action.type)) {
      return {
        decision: "deny",
        reason: `Action type ${action.type} is not allowlisted`,
      };
    }

    const resolvedUrl = ctx.resolvedUrl ?? (action.type === "navigate" ? action.url : undefined);
    if (!resolvedUrl) {
      return {
        decision: "deny",
        reason: "A resolved URL is required for policy evaluation",
      };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(resolvedUrl);
    } catch {
      return { decision: "deny", reason: `Invalid resolved URL: ${resolvedUrl}` };
    }

    if (!this.config.allowedOrigins.includes(parsedUrl.origin)) {
      return {
        decision: "deny",
        reason: `Origin ${parsedUrl.origin} is not allowlisted`,
      };
    }

    if (!this.config.allowedPathPatterns.some((pattern) => matchesPathGlob(parsedUrl.pathname, pattern))) {
      return {
        decision: "deny",
        reason: `Path ${parsedUrl.pathname} does not match an allowlisted pattern`,
      };
    }

    if (riskRank[ctx.risk] > riskRank[this.config.maxRisk]) {
      return {
        decision: "deny",
        reason: `Risk ${ctx.risk} exceeds maxRisk ${this.config.maxRisk}`,
      };
    }

    if (this.config.requireApprovalFor.includes(ctx.risk)) {
      if (ctx.mode === "discovery" && !this.allowRisky) {
        return {
          decision: "deny",
          reason: `Risk ${ctx.risk} requires approval and risky discovery is disabled`,
        };
      }
      if (ctx.mode === "replay") {
        return {
          decision: "require_approval",
          reason: `Risk ${ctx.risk} requires human approval`,
        };
      }
    }

    return { decision: "allow", reason: "Action satisfies policy" };
  }

  checkNavigation(url: string): PolicyDecision {
    return this.check(
      { type: "navigate", url },
      { resolvedUrl: url, risk: "safe", mode: "replay" },
    );
  }
}

export function checkNavigation(url: string, engine: PolicyEngine): PolicyDecision {
  return engine.checkNavigation(url);
}
