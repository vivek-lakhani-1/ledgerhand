import type { Action, ControlRole, Risk, TargetDescriptor } from "../schema/index.js";

export interface Surface {
  readonly kind: "web" | "legacy-web" | "desktop";
  readonly sessionId: string;

  observe(): Promise<Observation>;
  resolve(target: TargetDescriptor): Promise<Resolved | null>;
  act(action: ResolvedAction, ctx: ActContext): Promise<void>;
  readText(target: TargetDescriptor): Promise<string | null>;
  readAttribute(target: TargetDescriptor, attr: string): Promise<string | null>;
  url(): Promise<string>;
  title(): Promise<string>;
  screenshot(opts?: { maskSensitive?: boolean }): Promise<Buffer>;
  domSnapshot(): Promise<string>;
  /**
   * Transport-level status of the most recent document load, when the surface has one.
   * Lets replay classify an application error generically (any 5xx) instead of recognising
   * a particular vendor's error-page wording. Surfaces without a transport (e.g. a native
   * desktop app) return null and fall back to content-based detection.
   */
  lastDocumentStatus(): Promise<{ url: string; status: number } | null>;
  captureDescriptor(handle: ControlHandle): Promise<TargetDescriptor>;
}

export interface Observation {
  url: string;
  title: string;
  frames: Array<{ path: string[]; title: string; controls: PerceivedControl[]; text: string }>;
  screenshotBase64?: string;
  viewport: { width: number; height: number };
}

export interface PerceivedControl {
  ref: string;
  role: ControlRole;
  name: string;
  value?: string;
  framePath: string[];
  enabled: boolean;
  visible: boolean;
  nearbyText?: string;
  tablePosition?: { rowMatch: string; columnHeader: string };
}

export type ResolvedAction = Action;

export interface ActContext {
  risk: Risk;
  mode: "discovery" | "replay";
  timeoutMs?: number;
  resolvedUrl?: string;
  /** Set only after the executor has received an approval decision. */
  approvalGranted?: boolean;
}

export interface ControlHandle {
  frame: unknown;
  elementHandle: unknown;
  perceived: PerceivedControl;
}

export interface Resolved {
  locator: unknown;
  strategy: string;
  strategyIndex: number;
  attempts: Array<{ strategy: string; matchCount: number; error?: string }>;
}
