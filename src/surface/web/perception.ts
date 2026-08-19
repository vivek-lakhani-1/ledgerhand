import type { ElementHandle, Frame, Locator, Page } from "playwright";
import { ControlRole, type ControlRole as ControlRoleType } from "../../schema/index.js";
import type { Observation, PerceivedControl } from "../types.js";

type PlaywrightRole = Parameters<Frame["getByRole"]>[0];

const roleMap: Array<[ControlRoleType, PlaywrightRole]> = [
  ["button", "button"],
  ["link", "link"],
  ["textbox", "textbox"],
  ["checkbox", "checkbox"],
  ["radio", "radio"],
  ["combobox", "combobox"],
  ["option", "option"],
  ["cell", "cell"],
  ["row", "row"],
  ["heading", "heading"],
  ["image", "img"],
];

export type FrameInfo = { frame: Frame; path: string[] };

export function frameSegment(parent: Frame, child: Frame): string {
  const index = parent.childFrames().indexOf(child);
  return child.name() || `frame-${Math.max(index, 0)}`;
}

/**
 * A frameset's child frames attach before their `name` is readable, so perception run too
 * early sees unnamed frames and falls back to a positional `frame-N` segment. That index is
 * not a stable identity: it was getting captured into artifacts, which then failed to replay
 * even against the page they were recorded on. Wait for the names to appear instead.
 *
 * Best-effort: a frame that genuinely has no name (rare in the legacy apps this targets, and
 * still addressable positionally) must not hang the run, so this returns after the timeout.
 */
export async function waitForNamedFrames(page: Page, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const unnamed = page
      .mainFrame()
      .childFrames()
      .filter((child) => child.name() === "");
    if (unnamed.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function enumerateFrames(page: Page): FrameInfo[] {
  const frames: FrameInfo[] = [];
  const visit = (frame: Frame, path: string[]): void => {
    frames.push({ frame, path });
    for (const child of frame.childFrames()) {
      visit(child, [...path, frameSegment(frame, child)]);
    }
  };
  visit(page.mainFrame(), []);
  return frames;
}

export function findFrame(page: Page, path: string[]): Frame | null {
  return enumerateFrames(page).find((entry) => samePath(entry.path, path))?.frame ?? null;
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

export async function perceive(page: Page, options: { includeScreenshot?: boolean } = {}): Promise<Observation> {
  // Never perceive a frameset mid-attach: an unnamed child yields a positional frame path
  // that is not a stable identity and must not reach a descriptor or a checkpoint.
  await waitForNamedFrames(page);

  const frames: Observation["frames"] = [];
  let nextRef = 1;

  for (const { frame, path } of enumerateFrames(page)) {
    const result = await perceiveFrame(frame, path, nextRef);
    nextRef = result.nextRef;
    frames.push({ path, title: result.title, controls: result.controls, text: result.text });
  }

  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const observation: Observation = {
    url: page.url(),
    title: await page.title().catch(() => ""),
    frames,
    viewport,
  };
  if (options.includeScreenshot ?? true) {
    observation.screenshotBase64 = (await page.screenshot()).toString("base64");
  }
  return observation;
}

async function perceiveFrame(
  frame: Frame,
  framePath: string[],
  firstRef: number,
): Promise<{ title: string; controls: PerceivedControl[]; text: string; nextRef: number }> {
  const controls: Array<{
    locator: Locator;
    role: ControlRoleType;
    order: number[];
    snapshot: string;
    visible: boolean;
    enabled: boolean;
  }> = [];
  const seen = new Set<string>();

  // This is the accessibility-first seam. The role locators are backed by the browser's
  // computed accessibility tree; ariaSnapshot is also captured for each node so names are
  // never inferred solely from tag names or CSS.
  for (const [role, playwrightRole] of roleMap) {
    let roleLocator: Locator;
    try {
      roleLocator = frame.getByRole(playwrightRole);
    } catch {
      continue;
    }

    const count = await roleLocator.count();
    for (let index = 0; index < count; index += 1) {
      const locator = roleLocator.nth(index);
      let visible = false;
      try {
        visible = await locator.isVisible({ timeout: 0 });
      } catch {
        continue;
      }
      if (!visible) continue;

      const identity = await locator
        .evaluate((element) => {
          const order: number[] = [];
          let current: Element | null = element;
          while (current?.parentElement) {
            order.unshift(Array.prototype.indexOf.call(current.parentElement.children, current));
            current = current.parentElement;
          }
          return order.join(".");
        })
        .catch(() => `role:${role}:${index}`);
      if (seen.has(identity)) continue;
      seen.add(identity);

      const [order, snapshot, enabled] = await Promise.all([
        locator.evaluate((element) => {
          const order: number[] = [];
          let current: Element | null = element;
          while (current?.parentElement) {
            order.unshift(Array.prototype.indexOf.call(current.parentElement.children, current));
            current = current.parentElement;
          }
          return order;
        }).catch(() => [Number.MAX_SAFE_INTEGER]),
        locator.ariaSnapshot({ depth: 0 }).catch(() => ""),
        locator.isEnabled({ timeout: 0 }).catch(() => true),
      ]);
      controls.push({ locator, role, order, snapshot, visible, enabled });
    }
  }

  controls.sort((left, right) => compareOrder(left.order, right.order));
  const perceived: PerceivedControl[] = [];
  let ref = firstRef;
  for (const item of controls) {
    const [name, value, nearbyText, tablePosition] = await Promise.all([
      parseAccessibleName(item.snapshot),
      readValue(item.locator),
      item.locator.evaluate((element) => {
        const clean = (value: string | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
        const cell = element.closest("td,th");
        if (!cell) return undefined;
        const previousCell = cell.previousElementSibling;
        if (previousCell?.matches("td,th")) {
          const text = clean((previousCell as HTMLElement).innerText);
          if (text) return text;
        }
        const row = cell.closest("tr");
        if (row) {
          const cells = Array.from(row.children);
          const cellIndex = cells.indexOf(cell);
          for (let position = cellIndex - 1; position >= 0; position -= 1) {
            const text = clean((cells[position] as HTMLElement).innerText);
            if (text) return text;
          }
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          let candidate: string | undefined;
          let node: Node | null = walker.nextNode();
          while (node) {
            if (node.parentElement && (node.parentElement.compareDocumentPosition(cell) & Node.DOCUMENT_POSITION_FOLLOWING)) {
              const text = clean(node.textContent ?? "");
              if (text) candidate = text;
            }
            node = walker.nextNode();
          }
          if (candidate) return candidate;
        }
        const containingText = clean((cell as HTMLElement).innerText);
        return containingText || undefined;
      }).catch(() => undefined),
      item.locator.evaluate((element) => {
        const table = element.closest("table");
        const row = element.closest("tr");
        const cell = element.closest("td,th");
        if (!table || !row || !cell) return undefined;
        const rowCells = Array.from(row.querySelectorAll(":scope > th, :scope > td"));
        const columnIndex = rowCells.indexOf(cell);
        if (columnIndex < 0) return undefined;
        const headerRow = Array.from(table.querySelectorAll("tr")).find((candidate) => candidate.querySelector("th")) ?? table.querySelector("tr");
        const headerCells = headerRow ? Array.from(headerRow.querySelectorAll(":scope > th, :scope > td")) : [];
        const clean = (value: string): string => value.replace(/\s+/g, " ").trim();
        const rowMatch = clean((rowCells[0] as HTMLElement | undefined)?.innerText ?? "");
        const columnHeader = clean((headerCells[columnIndex] as HTMLElement | undefined)?.innerText ?? "");
        if (!rowMatch || !columnHeader) return undefined;
        return { rowMatch, columnHeader };
      }).catch(() => undefined),
    ]);
    perceived.push({
      ref: `c${ref++}`,
      role: item.role,
      name,
      ...(value === undefined ? {} : { value }),
      framePath,
      enabled: item.enabled,
      visible: item.visible,
      ...(nearbyText ? { nearbyText } : {}),
      ...(tablePosition ? { tablePosition } : {}),
    });
  }

  return {
    title: await frame.evaluate(() => document.title).catch(() => ""),
    controls: perceived,
    text: await renderFrameText(frame),
    nextRef: ref,
  };
}

async function readValue(locator: Locator): Promise<string | undefined> {
  const value = await locator.getAttribute("value").catch(() => null);
  if (value !== null) return value;
  if (await locator.evaluate((element) => /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)).catch(() => false)) {
    return locator.inputValue({ timeout: 0 }).catch(() => undefined);
  }
  return undefined;
}

function parseAccessibleName(snapshot: string): string {
  const line = snapshot.split("\n").map((value) => value.trim()).find(Boolean) ?? "";
  const match = line.match(/^[-*]\s+[^\s:]+(?:\s+"((?:\\.|[^"\\])*)")?/);
  if (!match?.[1]) return "";
  return match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

async function renderFrameText(frame: Frame): Promise<string> {
  const text = await frame
    .evaluate(() => {
      const visible = (element: Element): boolean => {
        const node = element as HTMLElement;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const clean = (value: string): string => value.replace(/\s+/g, " ").trim();
      const lines: string[] = [];
      const add = (value: string): void => {
        const cleaned = clean(value.replaceAll("\t", " | "));
        if (cleaned && !lines.includes(cleaned)) lines.push(cleaned);
      };

      for (const heading of Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
        if (visible(heading)) add((heading as HTMLElement).innerText);
      }
      for (const row of Array.from(document.querySelectorAll("table tr"))) {
        if (!visible(row)) continue;
        const cells = Array.from(row.querySelectorAll(":scope > th, :scope > td")).map((cell) => clean((cell as HTMLElement).innerText));
        if (cells.some(Boolean)) add(cells.join(" | "));
      }
      for (const paragraph of Array.from(document.querySelectorAll("p,label"))) {
        if (visible(paragraph)) add((paragraph as HTMLElement).innerText);
      }
      for (const line of (document.body?.innerText ?? "").split(/\n+/)) add(line);
      return lines.join("\n");
    })
    .catch(() => "");

  const limit = 4000;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated]`;
}

function domOrderKey(element: Element): string {
  return domOrder(element).join(".");
}

function domOrder(element: Element): number[] {
  const order: number[] = [];
  let current: Element | null = element;
  while (current?.parentElement) {
    order.unshift(Array.prototype.indexOf.call(current.parentElement.children, current));
    current = current.parentElement;
  }
  return order;
}

function compareOrder(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? -1;
    const rightValue = right[index] ?? -1;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

function nearbyTextFor(element: Element): string | undefined {
  const clean = (value: string | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
  const cell = element.closest("td,th");
  if (!cell) return undefined;

  const previousCell = cell.previousElementSibling;
  if (previousCell?.matches("td,th")) {
    const text = clean((previousCell as HTMLElement).innerText);
    if (text) return text;
  }

  const row = cell.closest("tr");
  if (row) {
    const cells = Array.from(row.children);
    const cellIndex = cells.indexOf(cell);
    for (let index = cellIndex - 1; index >= 0; index -= 1) {
      const text = clean((cells[index] as HTMLElement).innerText);
      if (text) return text;
    }
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let candidate: string | undefined;
    let node: Node | null = walker.nextNode();
    while (node) {
      if (node.parentElement && node.parentElement.compareDocumentPosition(cell) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const text = clean(node.textContent ?? "");
        if (text) candidate = text;
      }
      node = walker.nextNode();
    }
    if (candidate) return candidate;
  }

  const containingText = clean((cell as HTMLElement).innerText);
  return containingText || undefined;
}

function tablePositionFor(element: Element): { rowMatch: string; columnHeader: string } | undefined {
  const table = element.closest("table");
  const row = element.closest("tr");
  const cell = element.closest("td,th");
  if (!table || !row || !cell) return undefined;

  const rowCells = Array.from(row.querySelectorAll(":scope > th, :scope > td"));
  const columnIndex = rowCells.indexOf(cell);
  if (columnIndex < 0) return undefined;

  const headerRow = Array.from(table.querySelectorAll("tr")).find((candidate) => candidate.querySelector("th"))
    ?? table.querySelector("tr");
  const headerCells = headerRow ? Array.from(headerRow.querySelectorAll(":scope > th, :scope > td")) : [];
  const clean = (value: string): string => value.replace(/\s+/g, " ").trim();
  const rowMatch = clean((rowCells[0] as HTMLElement | undefined)?.innerText ?? "");
  const columnHeader = clean((headerCells[columnIndex] as HTMLElement | undefined)?.innerText ?? "");
  if (!rowMatch || !columnHeader) return undefined;
  return { rowMatch, columnHeader };
}

export function controlRoleFromTag(tagName: string, type?: string): ControlRoleType {
  const tag = tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || (tag === "input" && ["submit", "button", "reset"].includes((type ?? "").toLowerCase()))) return "button";
  if (tag === "textarea" || (tag === "input" && !["checkbox", "radio", "submit", "button", "reset", "hidden"].includes((type ?? "").toLowerCase()))) return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "option") return "option";
  if (tag === "td" || tag === "th") return "cell";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "img") return "image";
  return "generic";
}

export type WebControlHandle = {
  frame: Frame;
  elementHandle: ElementHandle<Element>;
  perceived: PerceivedControl;
};

export { ControlRole };
