import type { ElementHandle, Frame, Locator } from "playwright";
import type { Action, TargetDescriptor } from "../../schema/index.js";
import type { RunLogger } from "../../evidence/logger.js";
import type { PolicyEngine } from "../../policy/policy.js";
import { BrowserSession } from "../../session/session.js";
import type { SessionHolder } from "../../session/control.js";
import type {
  ActContext,
  ControlHandle,
  Observation,
  PerceivedControl,
  ResolvedAction,
  Surface,
} from "../types.js";
import { captureDescriptor as captureWebDescriptor } from "./capture.js";
import { enumerateFrames, findFrame, perceive, type WebControlHandle } from "./perception.js";
import { WebLocatorResolver, type Resolved } from "./locator.js";

export class PolicyBlockedError extends Error {
  readonly errorClass = "POLICY_BLOCKED" as const;

  constructor(reason: string) {
    super(reason);
    this.name = "PolicyBlockedError";
  }
}

export class TargetNotResolvedError extends Error {
  readonly errorClass = "TARGET_NOT_FOUND" as const;

  constructor(target: TargetDescriptor, attempts: unknown[]) {
    super(`Could not resolve ${target.description ?? target.role} in frame [${target.framePath.join(" / ")}]; attempts: ${JSON.stringify(attempts)}`);
    this.name = "TargetNotResolvedError";
  }
}

export class AmbiguousTargetError extends Error {
  readonly errorClass = "AMBIGUOUS_TARGET" as const;

  constructor(target: TargetDescriptor, attempts: unknown[]) {
    super(`More than one visible control matched ${target.description ?? target.role} in frame [${target.framePath.join(" / ")}]; attempts: ${JSON.stringify(attempts)}`);
    this.name = "AmbiguousTargetError";
  }
}

export class WebSurface implements Surface {
  readonly kind = "legacy-web" as const;
  readonly sessionId: string;

  private readonly session: BrowserSession;
  private readonly policy: PolicyEngine;
  private readonly logger: RunLogger;
  private readonly caller: SessionHolder;
  private readonly resolver: WebLocatorResolver;
  private readonly sensitiveTargets: TargetDescriptor[] = [];

  constructor(options: {
    session: BrowserSession;
    policy: PolicyEngine;
    logger: RunLogger;
    caller: SessionHolder;
  }) {
    this.session = options.session;
    this.policy = options.policy;
    this.logger = options.logger;
    this.caller = options.caller;
    this.sessionId = options.session.sessionId;
    this.resolver = new WebLocatorResolver(this.session.page);
    this.session.configureNavigationPolicy(this.policy, this.logger, { abortOnPolicyViolation: true });
  }

  async observe(): Promise<Observation> {
    return perceive(this.session.page, { includeScreenshot: true });
  }

  async resolve(target: TargetDescriptor, options: { timeoutMs?: number } = {}): Promise<Resolved | null> {
    return this.resolver.resolve(target, options);
  }

  /**
   * Resolve the observation-scoped ref to the live element and capture its descriptor now.
   * The model supplies only the ref; all locator strategies still come from the perception
   * and capture layers.
   */
  async captureDescriptorForRef(ref: string, observation: Observation): Promise<TargetDescriptor | null> {
    const perceived = observation.frames
      .flatMap((frame) => frame.controls)
      .find((control) => control.ref === ref);
    if (!perceived) return null;

    const frame = findFrame(this.session.page, perceived.framePath) ?? findFrameByObservationPath(this.session.page, perceived.framePath);
    if (!frame) return null;
    const livePath = enumerateFrames(this.session.page).find((item) => item.frame === frame)?.path ?? perceived.framePath;
    const livePerceived: PerceivedControl = { ...perceived, framePath: livePath };
    const role = (perceived.role === "image" ? "img" : perceived.role) as Parameters<Frame["getByRole"]>[0];
    const frameControls = observation.frames.find((entry) => samePath(entry.path, perceived.framePath))?.controls
      .filter((control) => control.visible && control.role === perceived.role) ?? [];
    const index = frameControls.findIndex((control) => control.ref === ref);
    if (index < 0) return null;

    const locator = perceived.name
      ? frame.getByRole(role, { name: perceived.name, exact: true })
      : frame.getByRole(role).nth(index);
    let elementHandle = await locator.elementHandle().catch(() => null);
    if (!elementHandle) {
      const fallbackSelector = fallbackSelectorForRole(perceived.role);
      if (fallbackSelector) {
        elementHandle = await frame.locator(fallbackSelector).filter({ visible: true }).nth(index).elementHandle().catch(() => null);
      }
    }
    if (!elementHandle) return null;

    const handle: WebControlHandle = { frame, elementHandle, perceived: livePerceived };
    return this.captureDescriptor(handle);
  }

  get lastResolveAttempts() {
    return [...this.resolver.lastAttempts];
  }

  async act(action: ResolvedAction, ctx: ActContext): Promise<void> {
    // These checks deliberately stay at the top of this method. Every caller, including
    // callers that supply a pre-resolved target, passes both gates before resolution or I/O.
    this.session.control.assertHeldBy(this.caller);

    const actingUrl = await this.urlForAction(action);
    const decision = this.policy.check(action, {
      resolvedUrl: action.type === "navigate" ? action.url : actingUrl,
      risk: ctx.risk,
      mode: ctx.mode,
    });
    this.logger.emit("policy.decision", {
      action: action.type,
      decision: decision.decision,
      reason: decision.reason,
      resolvedUrl: action.type === "navigate" ? action.url : actingUrl,
      approvalGranted: ctx.approvalGranted ?? false,
    });
    const allowedAfterApproval = decision.decision === "require_approval" && ctx.approvalGranted === true;
    if (decision.decision !== "allow" && !allowedAfterApproval) throw new PolicyBlockedError(decision.reason);

    const timeoutMs = ctx.timeoutMs ?? 5000;
    let resolved: Resolved | null = null;
    let actingFrame: Frame | null = null;
    if (hasTarget(action)) {
      resolved = await this.resolve(action.target, { timeoutMs });
      if (!resolved) {
        const ambiguous = this.resolver.lastAttempts.some((attempt) => attempt.matchCount > 1);
        if (ambiguous) throw new AmbiguousTargetError(action.target, this.resolver.lastAttempts);
        throw new TargetNotResolvedError(action.target, this.resolver.lastAttempts);
      }
      // Locator/frame handles are intentionally reacquired by semantic frame path after
      // resolution and after navigating actions. They are never cached between operations.
      actingFrame = findFrame(this.session.page, action.target.framePath);
      if (!actingFrame) throw new TargetNotResolvedError(action.target, [{ strategy: "frame", matchCount: 0, error: "Frame disappeared after resolution" }]);
    }

    await this.perform(action, resolved, actingFrame, timeoutMs);

    this.logger.emit("target.resolved", {
      action: action.type,
      resolvedBy: resolved?.strategy ?? "none",
      strategyIndex: resolved?.strategyIndex,
      attempts: resolved?.attempts ?? [],
      framePath: hasTarget(action) ? action.target.framePath : [],
    });
    this.logger.emit("action.performed", {
      action: action.type,
      strategy: resolved?.strategy ?? "none",
      resolvedUrl: await this.url(),
    });
  }

  registerSensitiveTargets(targets: TargetDescriptor[]): void {
    this.sensitiveTargets.push(...targets);
  }

  async screenshot(options: { maskSensitive?: boolean } = {}): Promise<Buffer> {
    if (!options.maskSensitive) return this.session.page.screenshot();

    const masks: Locator[] = [];
    for (const { frame } of enumerateFrames(this.session.page)) {
      masks.push(frame.locator('input[type="password"]'));
    }
    for (const target of this.sensitiveTargets) {
      const resolved = await this.resolve(target, { timeoutMs: 1000 });
      if (resolved) masks.push(resolved.locator);
    }
    return masks.length > 0 ? this.session.page.screenshot({ mask: masks }) : this.session.page.screenshot();
  }

  async readText(target: TargetDescriptor): Promise<string | null> {
    const resolved = await this.resolve(target, { timeoutMs: 5000 });
    if (!resolved) return null;
    return resolved.locator.innerText({ timeout: 5000 }).catch(() => null);
  }

  async readAttribute(target: TargetDescriptor, attr: string): Promise<string | null> {
    const resolved = await this.resolve(target, { timeoutMs: 5000 });
    if (!resolved) return null;
    return resolved.locator.getAttribute(attr, { timeout: 5000 }).catch(() => null);
  }

  async url(): Promise<string> {
    return this.session.page.url();
  }

  async title(): Promise<string> {
    return this.session.page.title().catch(() => "");
  }

  async lastDocumentStatus(): Promise<{ url: string; status: number } | null> {
    return this.session.lastDocumentStatus();
  }

  async domSnapshot(): Promise<string> {
    const chunks: string[] = [];
    for (const { frame, path } of enumerateFrames(this.session.page)) {
      const outerHtml = await frame
        .locator("html")
        .evaluate((element) => element.outerHTML)
        .catch(() => "");
      chunks.push(`<!-- framePath: [${path.join(" / ")}] -->\n${outerHtml}`);
    }
    return chunks.join("\n");
  }

  async captureDescriptor(handle: ControlHandle): Promise<TargetDescriptor> {
    if (!isWebControlHandle(handle)) {
      throw new TypeError("WebSurface.captureDescriptor expects { frame, elementHandle, perceived }");
    }
    return captureWebDescriptor(handle.frame, handle.elementHandle, handle.perceived);
  }

  private async urlForAction(action: Action): Promise<string> {
    if (action.type === "navigate") return action.url;
    if (hasTarget(action)) {
      return findFrame(this.session.page, action.target.framePath)?.url() ?? this.session.page.url();
    }
    return this.session.page.url();
  }

  private async perform(
    action: ResolvedAction,
    resolved: Resolved | null,
    frame: Frame | null,
    timeoutMs: number,
  ): Promise<void> {
    if (action.type === "navigate") {
      const settle = settleAfterAction(this.session.page.mainFrame(), { timeoutMs });
      await this.session.page.goto(action.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await settle;
      return;
    }

    if (action.type === "wait" || action.type === "extract" || action.type === "assert") return;
    if (action.type === "press" && !hasTarget(action)) {
      const mainFrame = this.session.page.mainFrame();
      const settle = settleAfterAction(mainFrame, { timeoutMs });
      await this.session.page.keyboard.press(action.key);
      await settle;
      return;
    }
    if (!resolved || !frame || !hasTarget(action)) throw new Error(`Action ${action.type} has no resolved target`);

    const strategy = action.target.strategies[resolved.strategyIndex];
    if (strategy.kind === "coordinate") {
      // Still has to settle - a coordinate click navigates like any other.
      const settle = settleAfterAction(frame, { timeoutMs });
      await this.session.page.mouse.click(strategy.x, strategy.y);
      await settle;
      reacquireFrame(this.session.page, action.target.framePath);
      return;
    }

    if (action.type === "click") {
      const settle = settleAfterAction(frame, { timeoutMs });
      await resolved.locator.click({ timeout: timeoutMs, noWaitAfter: true });
      await settle;
      reacquireFrame(this.session.page, action.target.framePath);
      return;
    }
    if (action.type === "type") {
      if (action.clearFirst === false) {
        await resolved.locator.pressSequentially(action.value, { timeout: timeoutMs });
      } else {
        await resolved.locator.fill(action.value, { timeout: timeoutMs });
      }
      return;
    }
    if (action.type === "select") {
      const settle = settleAfterAction(frame, { timeoutMs });
      await resolved.locator.selectOption(action.value, { timeout: timeoutMs });
      await settle;
      reacquireFrame(this.session.page, action.target.framePath);
      return;
    }
    if (action.type === "press") {
      const settle = settleAfterAction(frame, { timeoutMs });
      await resolved.locator.press(action.key, { timeout: timeoutMs });
      await settle;
      reacquireFrame(this.session.page, action.target.framePath);
    }
  }
}

export type SettleOptions = { timeoutMs?: number; quietMs?: number };

/**
 * Arm this before dispatching a click/press/select/goto. It observes the child frame itself;
 * page load state alone is not sufficient for a legacy frameset navigation.
 */
export function settleAfterAction(frame: Frame, options: SettleOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const quietMs = Math.min(options.quietMs ?? 250, timeoutMs);
  const page = frame.page();
  const beforeUrl = frame.url();

  return new Promise<void>((resolve) => {
    let finished = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      page.off("framenavigated", onNavigated);
      if (quietTimer) clearTimeout(quietTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve();
    };
    const waitForFrameDomContentLoaded = async (): Promise<void> => {
      await frame.waitForLoadState("domcontentloaded", { timeout: Math.max(1, timeoutMs) }).catch(() => undefined);
      finish();
    };
    const onNavigated = (navigatedFrame: Frame): void => {
      if (navigatedFrame !== frame) return;
      void waitForFrameDomContentLoaded();
    };

    page.on("framenavigated", onNavigated);
    // The explicit frame URL wait is armed before the action dispatch. The event listener above
    // also covers same-URL POST navigations, which do not satisfy this predicate.
    void frame.waitForURL((url) => url.toString() !== beforeUrl, { timeout: timeoutMs }).then(
      () => waitForFrameDomContentLoaded(),
      () => undefined,
    );
    quietTimer = setTimeout(finish, quietMs);
    timeoutTimer = setTimeout(finish, timeoutMs);
  });
}

function hasTarget(action: Action): action is Action & { target: TargetDescriptor } {
  return "target" in action && action.target !== undefined;
}

function reacquireFrame(page: import("playwright").Page, path: string[]): Frame {
  const frame = findFrame(page, path);
  if (!frame) throw new Error(`Frame path [${path.join(" / ")}] disappeared after navigation`);
  return frame;
}

function isWebControlHandle(value: ControlHandle): value is ControlHandle & {
  frame: Frame;
  elementHandle: ElementHandle<Element>;
} {
  return Boolean(value && typeof value === "object" && "frame" in value && "elementHandle" in value && "perceived" in value);
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function findFrameByObservationPath(page: import("playwright").Page, path: string[]): Frame | null {
  let current: Frame | null = page.mainFrame();
  for (const segment of path) {
    const indexed = /^frame-(\d+)$/.exec(segment);
    if (indexed) {
      current = current.childFrames()[Number(indexed[1])] ?? null;
    } else {
      current = current.childFrames().find((child) => child.name() === segment) ?? null;
    }
    if (!current) return null;
  }
  return current;
}

function fallbackSelectorForRole(role: PerceivedControl["role"]): string | null {
  switch (role) {
    case "button":
      return 'button,input[type="submit"],input[type="button"],input[type="reset"]';
    case "link":
      return "a";
    case "textbox":
      return 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]),textarea';
    case "checkbox":
      return 'input[type="checkbox"]';
    case "radio":
      return 'input[type="radio"]';
    case "combobox":
      return "select";
    case "option":
      return "option";
    case "cell":
      return "td,th";
    case "row":
      return "tr";
    case "heading":
      return "h1,h2,h3,h4,h5,h6";
    case "image":
      return "img";
    default:
      return null;
  }
}
