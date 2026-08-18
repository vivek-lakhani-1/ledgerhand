import type { ElementHandle, Frame } from "playwright";
import {
  ControlRole,
  TargetDescriptor,
  type ResolutionStrategy,
  type ControlRole as ControlRoleType,
  type TargetDescriptor as TargetDescriptorType,
} from "../../schema/index.js";
import type { PerceivedControl } from "../types.js";
import { controlRoleFromTag } from "./perception.js";

const confidence = {
  aria: 0.95,
  label: 0.9,
  placeholder: 0.88,
  table_cell: 0.85,
  text: 0.8,
  capturedAttribute: 0.7,
  nth_of_role: 0.55,
  css: 0.4,
  coordinate: 0.2,
} as const;

type ElementFacts = {
  tag: string;
  type: string;
  name: string;
  id: string;
  title: string;
  alt: string;
  value: string;
  href: string;
  placeholder: string;
  placeholderPresent: boolean;
  labelText: string;
  text: string;
  css: string;
  x: number;
  y: number;
};

export async function captureDescriptor(
  frame: Frame,
  elementHandle: ElementHandle<Element>,
  perceived: PerceivedControl,
): Promise<TargetDescriptorType> {
  const facts = await readElementFacts(elementHandle);
  const box = await elementHandle.boundingBox().catch(() => null);
  if (box) {
    facts.x = box.x + box.width / 2;
    facts.y = box.y + box.height / 2;
  }
  const strategies: ResolutionStrategy[] = [];

  if (perceived.name.trim()) {
    strategies.push({
      kind: "aria",
      role: perceived.role,
      name: perceived.name,
      exact: true,
      confidence: confidence.aria,
      origin: "captured",
    });
  }

  if (facts.labelText) {
    strategies.push({
      kind: "label",
      text: facts.labelText,
      confidence: confidence.label,
      origin: "captured",
    });
  }

  if (facts.placeholderPresent) {
    strategies.push({
      kind: "placeholder",
      text: facts.placeholder,
      confidence: confidence.placeholder,
      origin: "captured",
    });
  }

  if (perceived.tablePosition) {
    strategies.push({
      kind: "table_cell",
      rowMatch: perceived.tablePosition.rowMatch,
      columnHeader: perceived.tablePosition.columnHeader,
      confidence: confidence.table_cell,
      origin: "captured",
    });
  }

  if ((perceived.role === "link" || perceived.role === "button") && facts.text) {
    const visibleTextCount = await countVisibleTextMatches(frame, perceived.role, facts.text);
    if (visibleTextCount === 1) {
      strategies.push({
        kind: "text",
        text: facts.text,
        exact: true,
        confidence: confidence.text,
        origin: "captured",
      });
    }
  }

  const capturedAttributes: Array<ResolutionStrategy & { kind: "attribute" }> = [];
  for (const attr of ["name", "id", "title", "alt", "value", "href", "type"] as const) {
    const value = facts[attr];
    if (!value) continue;
    capturedAttributes.push({
      kind: "attribute",
      attr,
      value,
      confidence: attr === "name" || attr === "id" ? confidence.capturedAttribute : confidence.capturedAttribute - 0.05,
      origin: "captured",
    });
  }
  capturedAttributes.sort((left, right) => {
    const rank = (attr: string): number => (attr === "name" || attr === "id" ? 0 : 1);
    return rank(left.attr) - rank(right.attr);
  });
  strategies.push(...capturedAttributes);

  const nthIndex = await nthIndexInRole(frame, elementHandle, perceived.role);
  if (nthIndex !== undefined) {
    strategies.push({
      kind: "nth_of_role",
      role: perceived.role,
      index: nthIndex,
      confidence: confidence.nth_of_role,
      origin: "derived",
    });
  }

  if (facts.css) {
    strategies.push({ kind: "css", selector: facts.css, confidence: confidence.css, origin: "derived" });
  }

  if (strategies.length === 0) {
    const viewport = frame.page().viewportSize() ?? { width: 0, height: 0 };
    strategies.push({
      kind: "coordinate",
      x: facts.x,
      y: facts.y,
      viewport,
      confidence: confidence.coordinate,
      origin: "derived",
    });
  }

  const scope = perceived.tablePosition
    ? {
        withinRowMatching: perceived.tablePosition.rowMatch,
        columnHeader: perceived.tablePosition.columnHeader,
      }
    : undefined;

  return TargetDescriptor.parse({
    role: perceived.role,
    ...(perceived.name.trim() ? { name: perceived.name, nameMatch: "exact" } : {}),
    ...(facts.labelText ? { labelText: facts.labelText } : {}),
    framePath: perceived.framePath,
    ...(scope ? { scope } : {}),
    strategies,
    description: `${perceived.role}${perceived.name ? ` ${perceived.name}` : perceived.nearbyText ? ` near ${perceived.nearbyText}` : ""}`,
  });
}

async function readElementFacts(elementHandle: ElementHandle<Element>): Promise<ElementFacts & { nearbyText?: string }> {
  return elementHandle.evaluate((element) => {
    const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
    const id = element.id;
    const explicitLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrappingLabel = element.closest("label");
    const labelText = clean((explicitLabel ?? wrappingLabel)?.textContent);
    const rect = element.getBoundingClientRect();
    const path: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.body && path.length < 4) {
      const parent: Element | null = current.parentElement;
      if (!parent) break;
      const sameTag: Element[] = (Array.from(parent.children) as Element[]).filter((child: Element) => child.tagName === current?.tagName);
      path.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${sameTag.indexOf(current) + 1})`);
      current = parent;
    }
    const text = element.tagName === "INPUT" ? clean((element as HTMLInputElement).value) : clean((element as HTMLElement).innerText || element.textContent);
    return {
      tag: element.tagName,
      type: element.getAttribute("type") ?? "",
      name: element.getAttribute("name") ?? "",
      id,
      title: element.getAttribute("title") ?? "",
      alt: element.getAttribute("alt") ?? "",
      value: element.getAttribute("value") ?? "",
      href: element.getAttribute("href") ?? "",
      placeholder: element.getAttribute("placeholder") ?? "",
      placeholderPresent: element.hasAttribute("placeholder"),
      labelText,
      text,
      css: path.join(" > "),
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      nearbyText: undefined,
    };
  });
}

async function countVisibleTextMatches(frame: Frame, role: PerceivedControl["role"], text: string): Promise<number> {
  const playwrightRole = role === "image" ? "img" : role;
  try {
    const locator = frame.getByRole(playwrightRole as Parameters<Frame["getByRole"]>[0], { name: text, exact: true });
    const count = await locator.count();
    let visible = 0;
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible({ timeout: 0 }).catch(() => false)) visible += 1;
    }
    return visible;
  } catch {
    return 0;
  }
}

async function nthIndexInRole(
  frame: Frame,
  elementHandle: ElementHandle<Element>,
  role: PerceivedControl["role"],
): Promise<number | undefined> {
  const playwrightRole = role === "image" ? "img" : role;
  try {
    const locator = frame.getByRole(playwrightRole as Parameters<Frame["getByRole"]>[0]);
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = await locator.nth(index).elementHandle({ timeout: 0 }).catch(() => null);
      if (!candidate) continue;
      const same = await elementHandle.evaluate((element, other) => element === other, candidate).catch(() => false);
      await candidate.dispose();
      if (same) return index;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function roleForElement(tagName: string, type?: string): ControlRoleType {
  return controlRoleFromTag(tagName, type);
}

export { ControlRole };
