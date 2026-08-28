import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../target-app/server.js";
import { startConsoleServer, type ConsoleServer } from "../src/console/console-server.js";
import { RunHost } from "../src/console/run-host.js";

// End-to-end through the real stack: console API -> RunHost -> browser -> local target app.
// What Phase 1 changed - every replay run carries an intervention surface, an approval pause
// is visible on the run summary, and the main console can resolve it - is proven here.
const TARGET_PORT = 4655;
const ORIGIN = `http://127.0.0.1:${TARGET_PORT}`;

let targetServer: Server;
let server: ConsoleServer;
let capabilitiesDir: string;

beforeAll(async () => {
  process.env.APP_USER = "OPER01";
  process.env.APP_PASSWORD = "demo-pass-01";
  targetServer = startServer(TARGET_PORT);
  await waitFor(async () => (await fetch(`${ORIGIN}/_health`)).ok);

  // The committed artifact points at the default local port; the test target runs elsewhere.
  capabilitiesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-runhost-"));
  const raw = fs.readFileSync(path.join(process.cwd(), "capabilities", "subaccount-open.v1.json"), "utf8");
  fs.writeFileSync(
    path.join(capabilitiesDir, "subaccount-open.v1.json"),
    raw.replaceAll("http://127.0.0.1:4599", ORIGIN),
    "utf8",
  );

  server = await startConsoleServer({
    port: 0,
    capabilitiesDir,
    host: new RunHost({ secrets: () => ["demo-pass-01"] }),
  });
});

afterAll(async () => {
  await server.close();
  fs.rmSync(capabilitiesDir, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) => targetServer.close((error) => error ? reject(error) : resolve()));
});

const url = (suffix: string): string => `${server.url}${suffix}`;

async function post(suffix: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(url(suffix), {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function startRun(): Promise<string> {
  const { status, json } = await post("/api/runs", {
    kind: "replay",
    capabilityPath: "subaccount-open.v1.json",
    inputs: { memberId: "10001" },
  });
  expect(status).toBe(201);
  return json.runId;
}

async function summaryOf(runId: string): Promise<any> {
  return fetch(url(`/api/runs/${runId}`)).then((r) => r.json());
}

describe("approval pause through the main console", () => {
  it("pauses before the irreversible step without any operator opt-in, and continues on approve", async () => {
    const runId = await startRun();

    const paused = await waitForValue(async () => {
      const summary = await summaryOf(runId);
      return summary.pendingIntervention ? summary : null;
    }, 45000);
    expect(paused.pendingIntervention.reasonCode).toBe("RISKY_ACTION_APPROVAL");
    expect(paused.pendingIntervention.stepId).toBe("s9");
    // The operator surface exists for every replay run now - no checkbox required.
    expect(paused.operatorUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const interventions = await fetch(url(`/api/runs/${runId}/interventions`)).then((r) => r.json());
    expect(interventions).toHaveLength(1);
    expect(interventions[0].status).toBe("open");

    const resolved = await post(`/api/runs/${runId}/interventions/${paused.pendingIntervention.id}/resolve`, {
      decision: "approve",
      note: "Approved from the console test",
    });
    expect(resolved.status).toBe(200);

    const finished = await waitForValue(async () => {
      const summary = await summaryOf(runId);
      return summary.finishedAt ? summary : null;
    }, 45000);
    expect(finished.result.status).toBe("success");
    expect(finished.pendingIntervention).toBeNull();
  }, 100000);

  it("abort from the console leaves the irreversible action unperformed", async () => {
    const runId = await startRun();
    const paused = await waitForValue(async () => {
      const summary = await summaryOf(runId);
      return summary.pendingIntervention ? summary : null;
    }, 45000);

    const resolved = await post(`/api/runs/${runId}/interventions/${paused.pendingIntervention.id}/resolve`, {
      decision: "abort",
    });
    expect(resolved.status).toBe(200);

    const finished = await waitForValue(async () => {
      const summary = await summaryOf(runId);
      return summary.finishedAt ? summary : null;
    }, 45000);
    // The gate did its job: the run failed as POLICY_BLOCKED and nothing was posted.
    expect(finished.result.status).toBe("failed");
    expect(finished.result.error.class).toBe("POLICY_BLOCKED");
  }, 100000);
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Condition was not met in time");
}

async function waitForValue<T>(get: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await get();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Value did not appear in time");
}
