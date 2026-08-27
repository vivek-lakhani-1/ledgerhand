import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../src/catalog/catalog.js";
import { EvidenceDir } from "../src/evidence/evidence.js";
import { RunLogger } from "../src/evidence/logger.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { Redactor } from "../src/policy/redact.js";
import { BrowserSession } from "../src/session/session.js";
import { startServer } from "../target-app/server.js";
import { WebSurface } from "../src/surface/web/web-surface.js";

const TARGET_PORT = 4663;
const ORIGIN = `http://127.0.0.1:${TARGET_PORT}`;
const sourceFile = path.join(process.cwd(), "capabilities", "member-savings-balance.v1.json");

let targetServer: Server;

beforeAll(async () => {
  process.env.APP_USER = "OPER01";
  process.env.APP_PASSWORD = "demo-pass-01";
  targetServer = startServer(TARGET_PORT);
  await waitForHealth();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => targetServer.close((error) => error ? reject(error) : resolve()));
});

describe("agent-facing capability catalog", () => {
  it("lists and describes parsed capabilities, reports invalid files, and gates draft tools", async () => {
    const dir = makeCatalogDir();
    const catalog = loadCatalog(dir);

    expect(catalog.invalid).toEqual([
      expect.objectContaining({ file: path.join(dir, "invalid.json") }),
    ]);
    expect(catalog.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "member.savings_balance.lookup", approval: "approved" }),
      expect.objectContaining({ name: "member.savings_balance.draft", approval: "draft" }),
    ]));
    expect(catalog.describe("member.savings_balance.lookup").outputs[0]?.name).toBe("savingsBalance");

    const approvedTools = catalog.toToolSchemas();
    expect(approvedTools).toHaveLength(1);
    // Dotted capability names are mapped to API-safe tool names; the Anthropic tool-name
    // pattern has no dot in it.
    expect(approvedTools[0]).toMatchObject({
      name: "member__savings_balance__lookup",
      input_schema: {
        type: "object",
        properties: { memberId: { type: "string", pattern: "^[0-9]{5}$" } },
        required: ["memberId"],
        additionalProperties: false,
      },
    });
    expect(approvedTools[0]?.description).toContain("savingsBalance");
    expect(catalog.toToolSchemas({ includeDraft: true })).toHaveLength(2);
  });

  it("invokes a capability by catalog name and returns the replay result unchanged", async () => {
    const dir = makeCatalogDir();
    const catalog = loadCatalog(dir);
    const capability = catalog.describe("member.savings_balance.lookup");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-catalog-invoke-"));
    const redactor = new Redactor({ secrets: [], piiValues: [] });
    const runId = `catalog-${Date.now()}`;
    const logger = new RunLogger(runId, redactor, root);
    const evidence = new EvidenceDir(runId, redactor, root);
    const policy = new PolicyEngine(capability.policy);
    const session = await BrowserSession.launch({
      headless: true,
      viewport: capability.target.viewport,
      sessionId: `session-${runId}`,
    });
    const surface = new WebSurface({ session, policy, logger, caller: "automation" });

    try {
      const result = await catalog.invoke("member.savings_balance.lookup", { memberId: "10001" }, {
        surface,
        logger,
        evidence,
        policy,
      });
      expect(result).toMatchObject({ status: "success" });
      expect(result).toHaveProperty("runId", runId);
    } finally {
      await session.close();
    }
  });
});

function makeCatalogDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-catalog-"));
  const raw = JSON.parse(fs.readFileSync(sourceFile, "utf8")) as Record<string, unknown>;
  const ported = replaceStrings(raw, (value) => value.replaceAll("http://127.0.0.1:4599", ORIGIN));
  fs.writeFileSync(path.join(dir, "member.json"), JSON.stringify(ported));
  fs.writeFileSync(path.join(dir, "draft.json"), JSON.stringify({ ...ported, id: "cap_draft", name: "member.savings_balance.draft", approval: "draft" }));
  fs.writeFileSync(path.join(dir, "invalid.json"), "{not valid json");
  return dir;
}

function replaceStrings<T>(value: T, transform: (value: string) => string): T {
  if (typeof value === "string") return transform(value) as T;
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, transform)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, transform)])) as T;
  return value;
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${ORIGIN}/_health`)).ok) return;
    } catch {
      // The dedicated test server may still be binding.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Target app did not become healthy");
}
