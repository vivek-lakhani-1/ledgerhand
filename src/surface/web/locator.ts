import type { Frame, Locator, Page } from "playwright";
import type { ResolutionStrategy, TargetDescriptor } from "../../schema/index.js";
import type { Resolved as SurfaceResolved } from "../types.js";
import { enumerateFrames, findFrame } from "./perception.js";

export type ResolveAttempt = { strategy: string; matchCount: number; error?: string };

const INTERACTIVE_ROLES = new Set<TargetDescriptor["role"]>(["button", "link", "textbox", "checkbox", "radio", "combobox", "option"]);

export type Resolved = Omit<SurfaceResolved, "locator" | "strategy"> & {
  locator: Locator;
  strategy: ResolutionStrategy["kind"];
};

export type ResolveOptions = { timeoutMs?: number };

export class WebLocatorResolver {
  private readonly page: Page;
  readonly lastAttempts: ResolveAttempt[] = [];

  constructor(page: Page) {
    this.page = page;
  }

  async resolve(target: TargetDescriptor, options: ResolveOptions = {}): Promise<Resolved | null> {
    this.lastAttempts.length = 0;
    const frame = findFrame(this.page, target.framePath);
    if (!frame) {
      this.lastAttempts.push({
        strategy: "frame",
        matchCount: 0,
        error: `Frame path [${target.framePath.join(" / ")}] was not found; frame names must match the live frameset`,
      });
      return null;
    }

    const deadline = Date.now() + (options.timeoutMs ?? 5000);
    for (let strategyIndex = 0; strategyIndex < target.strategies.length; strategyIndex += 1) {
      const strategy = target.strategies[strategyIndex];
      const attempt: ResolveAttempt = { strategy: strategy.kind, matchCount: 0 };
      try {
        if (strategy.kind === "coordinate") {
          const currentViewport = this.page.viewportSize() ?? { width: 0, height: 0 };
          if (
            currentViewport.width !== strategy.viewport.width ||
            currentViewport.height !== strategy.viewport.height
          ) {
            attempt.error = `Coordinate refused: captured viewport ${strategy.viewport.width}x${strategy.viewport.height}, current viewport ${currentViewport.width}x${currentViewport.height}`;
            this.lastAttempts.push(attempt);
            continue;
          }
        }

        const candidate = await this.locatorForStrategy(frame, strategy, target.role, deadline);
        if (!candidate) {
          attempt.error = "Strategy could not be constructed";
          this.lastAttempts.push(attempt);
          continue;
        }

        let inspected = await visibleMatches(candidate, deadline);
        if (inspected.indexes.length > 1 && target.scope) {
          const scoped = await this.applyScope(frame, candidate, target.scope, deadline);
          if (scoped) inspected = await visibleMatches(scoped, deadline);
        }
        attempt.matchCount = inspected.indexes.length;
        if (inspected.indexes.length === 1) {
          this.lastAttempts.push(attempt);
          return {
            locator: inspected.locator.nth(inspected.indexes[0]),
            strategy: strategy.kind,
            strategyIndex,
            attempts: [...this.lastAttempts],
          };
        }
        attempt.error = inspected.indexes.length === 0 ? "No visible match" : "More than one visible match after scoping";
      } catch (error) {
        attempt.error = error instanceof Error ? error.message : String(error);
      }
      this.lastAttempts.push(attempt);
    }
    return null;
  }

  private async locatorForStrategy(
    frame: Frame,
    strategy: ResolutionStrategy,
    targetRole: TargetDescriptor["role"],
    deadline: number,
  ): Promise<Locator | null> {
    switch (strategy.kind) {
      case "aria": {
        const name = strategy.exact
          ? strategy.name
          : strategy.name;
        return frame.getByRole(playwrightRole(strategy.role), {
          name,
          exact: strategy.exact,
        });
      }
      case "label":
        return frame.getByLabel(strategy.text, { exact: true });
      case "placeholder":
        return frame.getByPlaceholder(strategy.text, { exact: true });
      case "table_cell":
        return this.tableCellLocator(frame, strategy, targetRole, deadline);
      case "text":
        return frame.getByRole(playwrightRole(targetRole), {
          name: strategy.text,
          exact: strategy.exact,
        });
      case "attribute":
        return frame.locator(`[${strategy.attr}="${cssAttributeValue(strategy.value)}"]`);
      case "nth_of_role":
        return frame.getByRole(playwrightRole(strategy.role)).nth(strategy.index);
      case "css":
        return frame.locator(strategy.selector);
      case "coordinate":
        // The action performer uses the selected strategy's x/y. Body is only a stable,
        // visible anchor for the Resolved contract; coordinate matching is checked above.
        return frame.locator("body");
    }
  }

  private async tableCellLocator(
    frame: Frame,
    strategy: Extract<ResolutionStrategy, { kind: "table_cell" }>,
    targetRole: TargetDescriptor["role"],
    deadline: number,
  ): Promise<Locator | null> {
    const tables = frame.locator("table");
    const tableCount = await tables.count();
    const matches: Locator[] = [];
    for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
      if (Date.now() >= deadline) throw new Error("Resolution timeout while inspecting table headers");
      const table = tables.nth(tableIndex);
      const info = await table.evaluate((element) => {
        const rows = Array.from(element.querySelectorAll("tr"));
        const header = rows.find((row) => row.querySelector("th")) ?? rows[0];
        const cells = header ? Array.from(header.querySelectorAll(":scope > th, :scope > td")) : [];
        return cells.map((cell) => (cell as HTMLElement).innerText.replace(/\s+/g, " ").trim());
      });
      const columnIndex = info.findIndex((header) => header === strategy.columnHeader);
      if (columnIndex < 0) continue;
      const rows = table.locator("tr").filter({ hasText: strategy.rowMatch });
      const cell = rows.locator("td,th").nth(columnIndex);
      // For control roles the action target is the control inside the cell, not the cell
      // itself - performing e.g. selectOption on the <td> fails with "not a <select>".
      matches.push(INTERACTIVE_ROLES.has(targetRole) ? cell.getByRole(playwrightRole(targetRole)) : cell);
    }
    if (matches.length === 0) return frame.locator('[data-ledgerhand-no-match="true"]');
    return unionLocators(matches);
  }

  private async applyScope(
    frame: Frame,
    candidate: Locator,
    scope: NonNullable<TargetDescriptor["scope"]>,
    deadline: number,
  ): Promise<Locator | null> {
    let scoped = candidate;
    if (scope.withinRowMatching) {
      const rowDescendants = frame.locator("tr").filter({ hasText: scope.withinRowMatching }).locator("*");
      scoped = scoped.and(rowDescendants);
    }
    if (scope.columnHeader) {
      const tables = frame.locator("table");
      const candidates: Locator[] = [];
      for (let tableIndex = 0; tableIndex < await tables.count(); tableIndex += 1) {
        if (Date.now() >= deadline) throw new Error("Resolution timeout while applying table scope");
        const table = tables.nth(tableIndex);
        const hasHeader = await table.evaluate((element, wanted) => {
          const rows = Array.from(element.querySelectorAll("tr"));
          const header = rows.find((row) => row.querySelector("th")) ?? rows[0];
          return Array.from(header?.querySelectorAll(":scope > th, :scope > td") ?? [])
            .some((cell) => (cell as HTMLElement).innerText.replace(/\s+/g, " ").trim() === wanted);
        }, scope.columnHeader);
        if (hasHeader) candidates.push(table.locator("*"));
      }
      if (candidates.length > 0) scoped = scoped.and(unionLocators(candidates));
    }
    if (scope.nth !== undefined) scoped = scoped.nth(scope.nth);
    return scoped;
  }
}

export async function resolve(
  page: Page,
  target: TargetDescriptor,
  options: ResolveOptions = {},
): Promise<Resolved | null> {
  return new WebLocatorResolver(page).resolve(target, options);
}

async function visibleMatches(locator: Locator, deadline: number): Promise<{ locator: Locator; indexes: number[] }> {
  const count = await locator.count();
  const indexes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (Date.now() >= deadline) throw new Error("Target resolution timed out");
    if (await locator.nth(index).isVisible({ timeout: Math.max(0, Math.min(50, deadline - Date.now())) }).catch(() => false)) {
      indexes.push(index);
    }
  }
  return { locator, indexes };
}

function unionLocators(locators: Locator[]): Locator {
  return locators.slice(1).reduce((combined, locator) => combined.or(locator), locators[0]);
}

function playwrightRole(role: string): Parameters<Frame["getByRole"]>[0] {
  return (role === "image" ? "img" : role) as Parameters<Frame["getByRole"]>[0];
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ");
}
