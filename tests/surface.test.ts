import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "../target-app/server.js";
import { RunLogger } from "../src/evidence/logger.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { Redactor } from "../src/policy/redact.js";
import { ControlLostError } from "../src/session/control.js";
import { BrowserSession } from "../src/session/session.js";
import { TargetDescriptor } from "../src/schema/index.js";
import { captureDescriptor } from "../src/surface/web/capture.js";
import { findFrame } from "../src/surface/web/perception.js";
import { PolicyBlockedError, WebSurface } from "../src/surface/web/web-surface.js";
import type { PerceivedControl } from "../src/surface/types.js";

const TEST_PORT = 4637;
const ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
const APP_USER = "OPER01";
const APP_PASSWORD = "demo-pass-01";

let server: Server;
let session: BrowserSession;
let surface: WebSurface;

beforeAll(async () => {
  server = startServer(TEST_PORT);
  await waitForHealth();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-surface-"));
  const logger = new RunLogger(`surface-${Date.now()}-${Math.random().toString(16).slice(2)}`, new Redactor({ secrets: [], piiValues: [] }), root);
  const policy = new PolicyEngine({ allowedOrigins: [ORIGIN], allowedPathPatterns: ["/**"], maxRisk: "safe" });
  session = await BrowserSession.launch({
    headless: true,
    viewport: { width: 1280, height: 900 },
    sessionId: `session-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  surface = new WebSurface({ session, policy, logger, caller: "automation" });
  await loginAs("alpha");
});

afterEach(async () => {
  await session.close();
});

describe("surface abstraction against the live legacy app", () => {
  it("recurses the frameset and perceives controls in the content frame", async () => {
    const observation = await surface.observe();
    const content = observation.frames.find((frame) => frame.path.join("/") === "content");

    expect(content).toBeDefined();
    expect(content?.controls.length).toBeGreaterThan(0);
    expect(content?.controls.every((control) => control.framePath.join("/") === "content")).toBe(true);
  });

  it("captures and resolves the member-search submit button by aria name Retrieve", async () => {
    const observation = await surface.observe();
    const perceived = findPerceived(observation.frames.find((frame) => frame.path[0] === "content")?.controls, (control) => control.role === "button" && control.name === "Retrieve");
    const content = requireFrame("content");
    const handle = await content.locator('input[type="submit"]').elementHandle();
    if (!handle) throw new Error("submit button handle was not available");

    const descriptor = await captureDescriptor(content, handle, perceived);
    expect(descriptor.strategies[0]).toMatchObject({ kind: "aria", name: "Retrieve", role: "button" });
    const resolved = await surface.resolve(descriptor);

    expect(resolved?.strategy).toBe("aria");
    expect(resolved?.attempts[0]).toMatchObject({ strategy: "aria", matchCount: 1 });
    await handle.dispose();
  });

  it("captures a balance cell with table_cell scope and resolves one cell", async () => {
    const searchControls = (await surface.observe()).frames.find((frame) => frame.path[0] === "content")?.controls;
    const memberInput = findPerceived(searchControls, (control) => control.role === "textbox" && control.nearbyText === "Member ID:");
    const retrieve = findPerceived(searchControls, (control) => control.role === "button" && control.name === "Retrieve");
    const content = requireFrame("content");
    const inputHandle = await content.locator('input[name="q"]').elementHandle();
    const submitHandle = await content.locator('input[type="submit"]').elementHandle();
    if (!inputHandle || !submitHandle) throw new Error("search control handles were not available");
    const inputDescriptor = await captureDescriptor(content, inputHandle, memberInput);
    const submitDescriptor = await captureDescriptor(content, submitHandle, retrieve);
    await surface.act({ type: "type", target: inputDescriptor, value: "10001", clearFirst: true }, { risk: "safe", mode: "replay" });
    await surface.act({ type: "click", target: submitDescriptor }, { risk: "safe", mode: "replay" });

    const memberFrame = requireFrame("content");
    const observation = await surface.observe();
    const balance = findPerceived(observation.frames.find((frame) => frame.path[0] === "content")?.controls, (control) => control.role === "cell" && control.name === "1250.75");
    const balanceHandle = await memberFrame.getByRole("cell", { name: "1250.75", exact: true }).elementHandle();
    if (!balanceHandle) throw new Error("balance cell handle was not available");
    const descriptor = await captureDescriptor(memberFrame, balanceHandle, balance);
    const tableStrategy = descriptor.strategies.find((strategy) => strategy.kind === "table_cell");

    expect(tableStrategy).toMatchObject({ kind: "table_cell", columnHeader: "Current Balance" });
    expect((tableStrategy as { rowMatch: string }).rowMatch).toBe("90000001");
    if (!tableStrategy) throw new Error("table_cell strategy was not captured");
    const tableOnly = TargetDescriptor.parse({ ...descriptor, strategies: [tableStrategy] });
    const resolved = await surface.resolve(tableOnly);

    expect(resolved?.strategy).toBe("table_cell");
    expect(resolved ? await resolved.locator.count() : 0).toBe(1);
    await inputHandle.dispose();
    await submitHandle.dispose();
    await balanceHandle.dispose();
  });

  it("refuses a coordinate descriptor after the viewport changes", async () => {
    const descriptor = TargetDescriptor.parse({
      role: "button",
      framePath: ["content"],
      strategies: [{ kind: "coordinate", x: 10, y: 10, viewport: { width: 1280, height: 900 }, confidence: 0.2, origin: "derived" }],
    });
    await session.page.setViewportSize({ width: 1024, height: 768 });

    const resolved = await surface.resolve(descriptor);

    expect(resolved).toBeNull();
    expect(surface.lastResolveAttempts).toContainEqual(expect.objectContaining({
      strategy: "coordinate",
      error: expect.stringContaining("captured viewport 1280x900, current viewport 1024x768"),
    }));
  });

  it("throws ControlLostError when a human holds the session", async () => {
    const observation = await surface.observe();
    const perceived = findPerceived(observation.frames.find((frame) => frame.path[0] === "content")?.controls, (control) => control.role === "button" && control.name === "Retrieve");
    const content = requireFrame("content");
    const handle = await content.locator('input[type="submit"]').elementHandle();
    if (!handle) throw new Error("submit button handle was not available");
    const descriptor = await captureDescriptor(content, handle, perceived);
    session.control.transferTo("human", "intervention-1");

    await expect(surface.act({ type: "click", target: descriptor }, { risk: "safe", mode: "replay" })).rejects.toBeInstanceOf(ControlLostError);
    await handle.dispose();
  });

  it("denies an off-allowlist navigate before the page moves", async () => {
    const before = await surface.url();

    await expect(surface.act({ type: "navigate", url: "https://off-allowlist.example/escape" }, { risk: "safe", mode: "replay" })).rejects.toBeInstanceOf(PolicyBlockedError);

    expect(await surface.url()).toBe(before);
  });

  it("uses adjacent table text when the member-id textbox has no AX name", async () => {
    const alphaObservation = await surface.observe();
    const alphaInput = findPerceived(alphaObservation.frames.find((frame) => frame.path[0] === "content")?.controls, (control) => control.role === "textbox" && control.name === "");
    expect(alphaInput.nearbyText).toBe("Member ID:");

    await loginAs("beta");
    const betaObservation = await surface.observe();
    const betaInput = findPerceived(betaObservation.frames.find((frame) => frame.path[0] === "content")?.controls, (control) => control.role === "textbox" && control.name === "");
    expect(betaInput.nearbyText).toBe("Account Number:");
  });
});

async function loginAs(tenant: "alpha" | "beta"): Promise<void> {
  await session.page.goto(`${ORIGIN}/t/${tenant}/msc/login`, { waitUntil: "domcontentloaded" });
  await session.page.locator('input[name="u"]').fill(APP_USER);
  await session.page.locator('input[name="p"]').fill(APP_PASSWORD);
  await session.page.locator('input[type="submit"]').click();
  await session.page.waitForURL(`${ORIGIN}/t/${tenant}/msc/console`);
  const content = requireFrame("content");
  await content.waitForURL((url) => url.toString().includes(`/t/${tenant}/msc/search`));
}

function requireFrame(name: string) {
  const frame = findFrame(session.page, [name]);
  if (!frame) throw new Error(`Expected frame ${name}`);
  return frame;
}

function findPerceived(controls: PerceivedControl[] | undefined, predicate: (control: PerceivedControl) => boolean): PerceivedControl {
  const control = controls?.find(predicate);
  if (!control) throw new Error("Expected perceived control was not found");
  return control;
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/_health`);
      if (response.ok) return;
    } catch {
      // The server may still be binding its dedicated test port.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Target app did not become healthy");
}
