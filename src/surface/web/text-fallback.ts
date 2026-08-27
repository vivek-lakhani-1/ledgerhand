import type { Frame } from "playwright";
import type { BrowserSession } from "../../session/session.js";
import type { Observation } from "../types.js";
import type { WebSurface } from "./web-surface.js";

/**
 * Outside the test runner - the CLI and the console server both transpile through tsx - a legacy
 * frameset can finish its document swap after the perception callback has already inspected the
 * frame, leaving an empty text body that text checkpoints then fail against. Preserve the
 * observation and fill only an empty frame's text from the same live frame before replay
 * evaluates it.
 */
export function withFramesetTextFallback(surface: WebSurface, session: BrowserSession): WebSurface {
  const observe = surface.observe.bind(surface);
  surface.observe = async (): Promise<Observation> => {
    const observation = await observe();
    if (observation.frames.every((frame) => frame.text.length > 0)) return observation;
    const frames = await Promise.all(observation.frames.map(async (frameInfo) => {
      if (frameInfo.text.length > 0) return frameInfo;
      const liveFrame = session.page.frames().find((candidate) => samePath(framePath(candidate), frameInfo.path));
      const text = liveFrame ? await liveFrame.locator("body").innerText({ timeout: 1000 }).catch(() => "") : "";
      return text ? { ...frameInfo, text } : frameInfo;
    }));
    return { ...observation, frames };
  };
  return surface;
}

function framePath(frame: Frame): string[] {
  const pathParts: string[] = [];
  let current: Frame | null = frame;
  while (current?.parentFrame()) {
    const parent = current.parentFrame();
    if (!parent) break;
    const index = parent.childFrames().indexOf(current);
    pathParts.unshift(current.name() || `frame-${Math.max(index, 0)}`);
    current = parent;
  }
  return pathParts;
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}
