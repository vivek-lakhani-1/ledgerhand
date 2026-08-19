import type { BusinessOutcome, Capability, OutputSpec, TargetDescriptor } from "../schema/index.js";
import type { Surface } from "../surface/types.js";
import { evaluateCheckpoint } from "./checkpoint.js";

export type ClassifiedOutcome = {
  kind: "outcome";
  outcome: BusinessOutcome;
  message: string;
  outputs: Record<string, unknown>;
};

export type NoOutcome = { kind: "none" };

export class OutputExtractionError extends Error {
  readonly outputName: string;

  constructor(outputName: string, detail: string) {
    super(`Required output ${outputName} could not be extracted: ${detail}`);
    this.name = "OutputExtractionError";
    this.outputName = outputName;
  }
}

/**
 * Ordering is significant: the first matching outcome wins. Capabilities should therefore
 * put their most-specific detections before broad message detections.
 */
export async function classify(cap: Capability, surface: Surface): Promise<ClassifiedOutcome | NoOutcome> {
  for (const outcome of cap.outcomes) {
    const detection = await evaluateCheckpoint(outcome.detect, surface, Date.now() + checkpointBudget(outcome.detect));
    if (!detection.ok) continue;

    const outputs = await extractOutputs(outcome.outputs, surface);
    const firstMessage = Object.values(outputs).find((value) => typeof value === "string" && value.trim());
    return {
      kind: "outcome",
      outcome,
      message: typeof firstMessage === "string" ? firstMessage : outcome.description,
      outputs,
    };
  }
  return { kind: "none" };
}

export async function extractOutputs(specs: OutputSpec[], surface: Surface): Promise<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  for (const spec of specs) {
    const raw = await readOutputSource(spec, surface);
    if (raw === null || raw === undefined || raw === "") {
      if (spec.required) throw new OutputExtractionError(spec.name, "source returned no value");
      continue;
    }
    const value = applyTransform(raw, spec.source.transform);
    // A secret output can prove that extraction worked, but its value is never part of the
    // caller result. Secret outputs are a rare artifact shape, yet enforcing this here keeps
    // the no-secret-return guarantee structural rather than conventional.
    if (spec.sensitivity !== "secret") outputs[spec.name] = value;
  }
  return outputs;
}

/**
 * Strategies that locate an element by where it sits rather than by what it is.
 *
 * These are acceptable for a click - worst case the click misses and a checkpoint fails. They
 * are NOT acceptable for reading business data. A positional fallback on a table of accounts
 * returns the wrong row's number with full confidence, and a wrong balance that looks right is
 * far worse than an error. Observed for real: an artifact recorded against a member with a
 * Savings account read the Checking balance of a member without one, because the semantic
 * row match failed and a CSS position matched anyway.
 */
const POSITIONAL_STRATEGY_KINDS = new Set(["nth_of_role", "css", "coordinate"]);

/**
 * A table cell's accessible name IS its text, so an aria match on a cell is a match on the
 * value itself - it only ever holds for the record it was captured from.
 */
function isValueMatch(target: TargetDescriptor, strategy: { kind: string }): boolean {
  return target.role === "cell" && strategy.kind === "aria";
}

/**
 * The target restricted so extraction never *falls back* to a positional strategy.
 *
 * The danger is not position itself - a target whose only strategy is a CSS path is the
 * author's deliberate choice, and an error message region has no better anchor. The danger is
 * falling back to position after a semantic strategy has already failed: that failure means
 * the page is not what we recorded, and a position will then confidently match the wrong
 * element. Observed for real - an artifact recorded against a member with a Savings account
 * read the *Checking* balance of a member without one, because the row match failed and a CSS
 * position matched anyway. A wrong balance that looks right is far worse than an error.
 *
 * So: if the target has any semantic strategy, positional ones are dropped and extraction
 * fails loudly when the semantic ones do. If it has only positional strategies, they stand.
 */
function semanticTargetFor(spec: OutputSpec, target: TargetDescriptor): TargetDescriptor {
  const isPositional = (strategy: { kind: string }): boolean =>
    POSITIONAL_STRATEGY_KINDS.has(strategy.kind) || isValueMatch(target, strategy);

  const semantic = target.strategies.filter((strategy) => !isPositional(strategy));
  if (semantic.length === 0) {
    // Positional-only: an explicit authoring choice, not a fallback. Coordinates are still
    // refused - they cannot survive a viewport change and are never a deliberate read target.
    const usable = target.strategies.filter((strategy) => strategy.kind !== "coordinate");
    if (usable.length === 0) {
      throw new OutputExtractionError(
        spec.name,
        "the only locator strategy is a screen coordinate, which cannot be trusted to identify a value",
      );
    }
    return { ...target, strategies: usable };
  }
  return { ...target, strategies: semantic };
}

async function readOutputSource(spec: OutputSpec, surface: Surface): Promise<string | null> {
  const source = spec.source;
  if (source.kind === "text_of") {
    if (!source.target) throw new OutputExtractionError(spec.name, "text_of source has no target");
    return surface.readText(semanticTargetFor(spec, source.target));
  }
  if (source.kind === "attribute_of") {
    if (!source.target || !source.attribute) throw new OutputExtractionError(spec.name, "attribute_of source needs target and attribute");
    return surface.readAttribute(semanticTargetFor(spec, source.target), source.attribute);
  }

  if (!source.urlPattern) throw new OutputExtractionError(spec.name, "url_capture source has no urlPattern");
  let expression: RegExp;
  try {
    expression = new RegExp(source.urlPattern);
  } catch (error) {
    throw new OutputExtractionError(spec.name, `invalid urlPattern: ${error instanceof Error ? error.message : String(error)}`);
  }
  const match = expression.exec(await surface.url());
  return match?.groups?.[spec.name] ?? null;
}

function applyTransform(value: string, transform: OutputSpec["source"]["transform"]): unknown {
  switch (transform) {
    case "none":
      return value;
    case "trim":
      return value.trim();
    case "digits_only":
      return value.replace(/\D/g, "");
    case "currency_to_number": {
      const normalized = value.replace(/[^0-9.-]/g, "");
      const number = Number(normalized);
      return Number.isFinite(number) ? number : value.trim();
    }
    case "upper":
      return value.toUpperCase();
    case "lower":
      return value.toLowerCase();
  }
}

function checkpointBudget(checkpoint: Capability["successCheckpoint"]): number {
  return checkpoint.timeoutMs ?? 1000;
}
