import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { PolicyEngine } from "../policy/policy.js";
import type { RunLogger } from "../evidence/logger.js";
import { SessionControl } from "./control.js";

export type SessionViewport = { width: number; height: number };

export type BrowserSessionLaunchOptions = {
  headless: boolean;
  viewport: SessionViewport;
  sessionId: string;
  policy?: PolicyEngine;
  logger?: RunLogger;
  abortOnPolicyViolation?: boolean;
};

export class BrowserSession {
  readonly sessionId: string;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly control: SessionControl;

  private navigationListener?: (frame: import("playwright").Frame) => void;
  private responseListener?: (response: import("playwright").Response) => void;
  private lastDocument: { url: string; status: number } | null = null;
  private closed = false;
  private aborted = false;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    sessionId: string,
  ) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.sessionId = sessionId;
    this.control = new SessionControl(sessionId);
  }

  static async launch(options: BrowserSessionLaunchOptions): Promise<BrowserSession> {
    const browser = await chromium.launch({ headless: options.headless });
    const context = await browser.newContext({ viewport: options.viewport });
    const page = await context.newPage();
    const session = new BrowserSession(browser, context, page, options.sessionId);
    session.trackDocumentResponses();
    if (options.policy && options.logger) {
      session.configureNavigationPolicy(options.policy, options.logger, {
        abortOnPolicyViolation: options.abortOnPolicyViolation,
      });
    }
    return session;
  }

  configureNavigationPolicy(
    policy: PolicyEngine,
    logger: RunLogger,
    options: { abortOnPolicyViolation?: boolean } = {},
  ): void {
    if (this.navigationListener) {
      this.page.off("framenavigated", this.navigationListener);
    }

    const abortOnPolicyViolation = options.abortOnPolicyViolation ?? true;
    this.navigationListener = (frame) => {
      const url = frame.url();
      const decision = policy.checkNavigation(url);
      if (decision.decision !== "allow") {
        logger.emit("policy.decision", {
          action: "navigate",
          decision: decision.decision,
          reason: decision.reason,
          resolvedUrl: url,
          policyViolation: true,
          framePath: framePath(frame),
        });
        if (abortOnPolicyViolation) {
          this.aborted = true;
          void this.close();
        }
      }
    };
    this.page.on("framenavigated", this.navigationListener);
  }

  /**
   * Records the HTTP status of the most recent *document* response in any frame.
   *
   * Classifying an application error by scraping the error page's body text only works
   * against an app whose error page you already know. The transport-level status is the
   * generic signal, so replay can report SURFACE_ERROR for any 5xx without recognising the
   * vendor's particular error copy.
   */
  trackDocumentResponses(): void {
    if (this.responseListener) return;
    this.responseListener = (response) => {
      if (response.request().resourceType() !== "document") return;
      this.lastDocument = { url: response.url(), status: response.status() };
    };
    this.page.on("response", this.responseListener);
  }

  lastDocumentStatus(): { url: string; status: number } | null {
    return this.lastDocument;
  }

  get wasAborted(): boolean {
    return this.aborted;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.navigationListener) {
      this.page.off("framenavigated", this.navigationListener);
      this.navigationListener = undefined;
    }
    if (this.responseListener) {
      this.page.off("response", this.responseListener);
      this.responseListener = undefined;
    }
    await this.browser.close();
  }
}

function framePath(frame: import("playwright").Frame): string[] {
  const path: string[] = [];
  let current: import("playwright").Frame | null = frame;
  while (current && current.parentFrame()) {
    const parent = current.parentFrame();
    if (!parent) break;
    const index = parent.childFrames().indexOf(current);
    path.unshift(current.name() || `frame-${Math.max(index, 0)}`);
    current = parent;
  }
  return path;
}
