import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startConsoleServer, type ConsoleServer } from "../src/console/console-server.js";
import { RunHost } from "../src/console/run-host.js";

const balanceArtifact = path.join(process.cwd(), "capabilities", "member-savings-balance.v1.json");

let server: ConsoleServer;
let evidenceDir: string;
let capabilitiesDir: string;

/** Writes what a finished replay leaves behind, the raw material history is rebuilt from. */
function seedFinishedRun(runId: string): void {
  const runDir = path.join(evidenceDir, runId);
  fs.mkdirSync(path.join(runDir, "screenshots"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.jsonl"), [
    JSON.stringify({ ts: "2026-08-27T10:00:00.000Z", runId, seq: 1, type: "run.start", capabilityId: "cap_x", tenant: "base" }),
    JSON.stringify({ ts: "2026-08-27T10:00:05.000Z", runId, seq: 2, type: "step.end", stepId: "s1", summary: "✓" }),
    JSON.stringify({ ts: "2026-08-27T10:00:09.000Z", runId, seq: 3, type: "run.end", status: "success", durationMs: 9000 }),
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({
    status: "success",
    runId,
    capability: { id: "cap_x", version: "1.0.0" },
    outputs: { balance: 12.5 },
    stepsExecuted: 1,
    durationMs: 9000,
    evidenceDir: `evidence/runs/${runId}`,
  }), "utf8");
  fs.writeFileSync(path.join(runDir, "capability.json"), JSON.stringify({ name: "meridian.member.balance" }), "utf8");
  fs.writeFileSync(path.join(runDir, "screenshots", "00-entry.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

beforeAll(() => {
  evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-evidence-"));
  capabilitiesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-history-caps-"));
  fs.copyFileSync(balanceArtifact, path.join(capabilitiesDir, "member-savings-balance.v1.json"));
  seedFinishedRun("replay-aaaa11112222");
  // A directory with a log but no clean ending: the process died mid-run.
  const torn = path.join(evidenceDir, "replay-dead00000000");
  fs.mkdirSync(torn, { recursive: true });
  fs.writeFileSync(path.join(torn, "run.jsonl"),
    JSON.stringify({ ts: "2026-08-27T11:00:00.000Z", runId: "replay-dead00000000", seq: 1, type: "run.start" }) + "\n", "utf8");
});

afterAll(() => {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.rmSync(capabilitiesDir, { recursive: true, force: true });
});

beforeEach(async () => {
  server = await startConsoleServer({ port: 0, capabilitiesDir, evidenceDir, host: new RunHost() });
});

afterEach(async () => {
  await server.close();
});

const url = (suffix: string): string => `${server.url}${suffix}`;

describe("run history rebuilt from evidence", () => {
  it("lists finished runs from disk with their capability name and result", async () => {
    const runs = await fetch(url("/api/runs")).then((r) => r.json());
    const finished = runs.find((run: { runId: string }) => run.runId === "replay-aaaa11112222");
    expect(finished).toMatchObject({
      kind: "replay",
      status: "finished",
      capabilityName: "meridian.member.balance",
    });
    expect(finished.result.outputs.balance).toBe(12.5);
  });

  it("reports a run whose log never ended as errored, not guessed successful", async () => {
    const runs = await fetch(url("/api/runs")).then((r) => r.json());
    const torn = runs.find((run: { runId: string }) => run.runId === "replay-dead00000000");
    expect(torn.status).toBe("errored");
    expect(torn.error).toMatch(/without recording a result/);
  });

  it("serves a historical run's full event log for the timeline", async () => {
    const run = await fetch(url("/api/runs/replay-aaaa11112222")).then((r) => r.json());
    expect(run.events).toHaveLength(3);
    expect(run.events[0].type).toBe("run.start");
  });

  it("lists and serves the evidence a run left behind", async () => {
    const evidence = await fetch(url("/api/runs/replay-aaaa11112222/evidence")).then((r) => r.json());
    expect(evidence.screenshots).toEqual(["00-entry.png"]);
    expect(evidence.files).toContain("result.json");

    const shot = await fetch(url("/api/runs/replay-aaaa11112222/evidence/screenshots/00-entry.png"));
    expect(shot.status).toBe(200);
    const log = await fetch(url("/api/runs/replay-aaaa11112222/evidence/run.jsonl"));
    expect(log.status).toBe(200);
  });

  it("refuses run ids and file names that reach outside the evidence tree", async () => {
    expect((await fetch(url("/api/runs/..%2F..%2Fetc/evidence"))).status).toBe(404);
    expect((await fetch(url("/api/runs/replay-aaaa11112222/evidence/..%2F..%2Fsecret"))).status).toBe(404);
    expect((await fetch(url("/api/runs/replay-aaaa11112222/evidence/screenshots/..%2F..%2Frun.jsonl"))).status).toBe(404);
  });

  it("serves the last screenshot as the frame for a run that is no longer live", async () => {
    const frame = await fetch(url("/api/runs/replay-aaaa11112222/frame"));
    expect(frame.status).toBe(200);
  });
});
