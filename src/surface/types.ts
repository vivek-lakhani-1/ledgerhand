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
