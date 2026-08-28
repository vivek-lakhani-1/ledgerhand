import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The claim "no model in the loop during replay" is a sentence in the README until something
// fails when it stops being true. These checks read the source tree so the claim breaks the
// build, not just the pitch.

const SRC = path.join(process.cwd(), "src");

// Everything a replay run can reach. Discovery (the one model-driven phase) and its two
// callers, cli and console, are the only directories allowed to know the model exists.
const REPLAY_SIDE = ["replay", "surface", "session", "schema", "policy", "evidence", "catalog", "escalation"];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("architecture invariants", () => {
  it("keeps the model SDK and the discover module out of the replay side", () => {
    for (const dir of REPLAY_SIDE) {
      for (const file of tsFilesUnder(path.join(SRC, dir))) {
        const source = fs.readFileSync(file, "utf8");
        expect(source, `${file} imports the model SDK`).not.toContain("@anthropic-ai/sdk");
        expect(source, `${file} imports from discover/`).not.toMatch(/from "[^"]*discover\//);
      }
    }
  });

  it("confines the model SDK import to the discovery model client", () => {
    const importers = tsFilesUnder(SRC)
      .filter((file) => fs.readFileSync(file, "utf8").includes("@anthropic-ai/sdk"))
      .map((file) => path.relative(process.cwd(), file));
    expect(importers).toEqual([path.join("src", "discover", "model.ts")]);
  });
});
