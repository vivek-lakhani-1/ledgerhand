import type { Checkpoint } from "../schema/index.js";
import type { Surface } from "../surface/types.js";

export type CheckpointEvaluation = { ok: boolean; observed: string };

export async function evaluateCheckpoint(
  checkpoint: Checkpoint,
  surface: Surface,
  deadline: number,
): Promise<CheckpointEvaluation> {
  if (Date.now() >= deadline) {
    return { ok: false, observed: `checkpoint deadline reached while evaluating ${checkpoint.kind}` };
  }

  try {
    switch (checkpoint.kind) {
      case "text_present":
        return evaluateText(checkpoint, surface, true);
      case "text_absent":
        return evaluateText(checkpoint, surface, false);
      case "control_present": {
        const resolved = await surface.resolve(checkpoint.target);
        const label = checkpoint.target.description ?? checkpoint.target.name ?? checkpoint.target.role;
        return resolved
          ? { ok: true, observed: `control ${JSON.stringify(label)} present in frame [${checkpoint.target.framePath.join(" / ") || "main"}]` }
          : { ok: false, observed: `control ${JSON.stringify(label)} not present in frame [${checkpoint.target.framePath.join(" / ") || "main"}]` };
      }
      case "control_absent": {
        const resolved = await surface.resolve(checkpoint.target);
        const label = checkpoint.target.description ?? checkpoint.target.name ?? checkpoint.target.role;
        return resolved
          ? { ok: false, observed: `control ${JSON.stringify(label)} present in frame [${checkpoint.target.framePath.join(" / ") || "main"}]` }
          : { ok: true, observed: `control ${JSON.stringify(label)} absent from frame [${checkpoint.target.framePath.join(" / ") || "main"}]` };
      }
      case "url_matches": {
        const url = await surface.url();
        const ok = safeRegexTest(checkpoint.pattern, url);
        return { ok, observed: `URL ${JSON.stringify(url)} ${ok ? "matches" : "does not match"} ${JSON.stringify(checkpoint.pattern)}` };
      }
      case "title_matches": {
        const title = await surface.title();
        const ok = safeRegexTest(checkpoint.pattern, title);
        return { ok, observed: `title ${JSON.stringify(title)} ${ok ? "matches" : "does not match"} ${JSON.stringify(checkpoint.pattern)}` };
      }
      case "all": {
        const observations: string[] = [];
        for (const child of checkpoint.of) {
          const result = await evaluateCheckpoint(child, surface, deadline);
          observations.push(result.observed);
          if (!result.ok) return { ok: false, observed: `all checkpoint failed: ${result.observed}` };
        }
        return { ok: true, observed: `all checkpoints passed: ${observations.join("; ")}` };
      }
      case "any": {
        const observations: string[] = [];
        for (const child of checkpoint.of) {
          const result = await evaluateCheckpoint(child, surface, deadline);
          observations.push(result.observed);
          if (result.ok) return { ok: true, observed: `any checkpoint passed: ${result.observed}` };
        }
        return { ok: false, observed: `no any checkpoint matched: ${observations.join("; ")}` };
      }
      case "not": {
        const result = await evaluateCheckpoint(checkpoint.of, surface, deadline);
        return { ok: !result.ok, observed: `not checkpoint ${result.ok ? "failed because" : "passed because"}: ${result.observed}` };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, observed: `surface could not be inspected for ${checkpoint.kind}: ${message}` };
  }
}

export async function waitForCheckpoint(
  checkpoint: Checkpoint,
  surface: Surface,
  timeoutMs: number,
  pollMs = 100,
): Promise<CheckpointEvaluation> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let last: CheckpointEvaluation = { ok: false, observed: `checkpoint ${checkpoint.kind} has not been evaluated` };
  while (Date.now() <= deadline) {
    last = await evaluateCheckpoint(checkpoint, surface, deadline);
    if (last.ok) return last;
    if (Date.now() >= deadline) break;
    await wait(Math.min(Math.max(1, pollMs), Math.max(1, deadline - Date.now())));
  }
  return { ok: false, observed: `${last.observed}; deadline exceeded after ${timeoutMs}ms` };
}

async function evaluateText(
  checkpoint: Extract<Checkpoint, { kind: "text_present" | "text_absent" }>,
  surface: Surface,
  expectedPresent: boolean,
): Promise<CheckpointEvaluation> {
  const observation = await surface.observe();
  const frames = checkpoint.framePath
    ? observation.frames.filter((frame) => samePath(frame.path, checkpoint.framePath ?? []))
    : observation.frames;
  const wanted = checkpoint.text;
  const matchingFrame = frames.find((frame) => matches(frame.text, wanted, checkpoint.match));
  const present = Boolean(matchingFrame);
  const frameLabel = matchingFrame ? `[${matchingFrame.path.join(" / ") || "main"}]` : checkpoint.framePath ? `[${checkpoint.framePath.join(" / ") || "main"}]` : "in the observed surface";
  const observed = present
    ? `text ${JSON.stringify(wanted)} present in frame ${frameLabel}`
    : `text ${JSON.stringify(wanted)} absent from frame ${frameLabel}`;
  return { ok: expectedPresent ? present : !present, observed };
}

function matches(value: string, wanted: string, match: "exact" | "contains" | "regex"): boolean {
  if (match === "exact") return value.trim() === wanted.trim();
  if (match === "contains") return value.includes(wanted);
  return safeRegexTest(wanted, value);
}

function safeRegexTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

