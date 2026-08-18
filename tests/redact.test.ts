import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceDir } from "../src/evidence/evidence.js";
import { RunLogger } from "../src/evidence/logger.js";
import { Redactor } from "../src/policy/redact.js";
import { Capability, ReplayResult } from "../src/schema/index.js";
import { validCapability } from "./fixtures.js";

describe("Redactor", () => {
  it("does not leak secret or PII values in capability, run log, or ReplayResult", () => {
    const secret = "super-secret-pass";
    const pii = "10001";
    const redactor = new Redactor({ secrets: [secret], piiValues: [pii] });
    const capability = Capability.parse(
      validCapability({
        inputs: [{ name: "memberId", type: "string", description: "id", example: pii }],
        provenance: { ...validCapability().provenance, goal: secret },
      }),
    );
    const capabilityJson = JSON.stringify(redactor.redactJson(capability));
    expect(capabilityJson.includes(secret)).toBe(false);
    expect(capabilityJson.includes(pii)).toBe(false);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerhand-redact-"));
    const logger = new RunLogger("run_redact", redactor, root);
    logger.emit("action.performed", { value: secret, memberId: pii });
    const logLine = fs.readFileSync(path.join(root, "run_redact", "run.jsonl"), "utf8");
    expect(logLine.includes(secret)).toBe(false);
    expect(logLine.includes(pii)).toBe(false);

    const result: ReplayResult = {
      status: "failed",
      runId: "run_redact",
      capability: { id: "cap_member_lookup", version: "1.0.0" },
      error: {
        class: "INTERNAL",
        stepId: "s1",
        stepDescription: secret,
        expected: "member",
        observed: pii,
        message: `${secret} ${pii}`,
        recoveryAttempts: [],
      },
      evidenceDir: "/tmp/run_redact",
    };
    const resultJson = JSON.stringify(redactor.redactJson(result));
    expect(resultJson.includes(secret)).toBe(false);
    expect(resultJson.includes(pii)).toBe(false);

    const evidence = new EvidenceDir("run_redact", redactor, root);
    const resultPath = evidence.writeResult(result);
    expect(fs.readFileSync(resultPath, "utf8").includes(secret)).toBe(false);
  });

  it("sweeps SSNs, cards, long digit runs, and credential assignments", () => {
    const redactor = new Redactor({ secrets: [], piiValues: [] });
    const raw = "ssn 123-45-6789 card 4111 1111 1111 1111 account 123456789 password=topsecret";
    const redacted = redactor.redactString(raw);
    expect(redacted).not.toContain("123-45-6789");
    expect(redacted).not.toContain("4111 1111 1111 1111");
    expect(redacted).not.toContain("123456789");
    expect(redacted).not.toContain("topsecret");
    expect(redacted).toContain("«redacted:pii»");
    expect(redacted).toContain("«redacted:secret»");
    expect(redactor.maskPii("10001")).toBe("1***1");
    expect(redactor.maskPii("a")).toBe("***");
  });

  // Regression: sensitive values do not always arrive as strings. ParamSpec and OutputSpec
  // both permit "number"/"currency", so an extracted member id or balance is a JS number.
  it("redacts sensitive values carried as numbers, not just strings", () => {
    const redactor = new Redactor({ secrets: ["99887766"], piiValues: ["10001"] });

    const outputs = { memberId: 10001, savingsBalance: 1250.75, seq: 7 };
    const redacted = redactor.redactJson(outputs) as Record<string, unknown>;

    expect(JSON.stringify(redacted).includes("10001")).toBe(false);
    expect(redacted.memberId).toBe("1***1");
    // Non-sensitive numerics keep their type so logs stay useful.
    expect(redacted.savingsBalance).toBe(1250.75);
    expect(redacted.seq).toBe(7);

    // ...including when nested inside arrays/objects.
    const nested = { steps: [{ count: 10001 }], secretNum: 99887766 };
    const nestedJson = JSON.stringify(redactor.redactJson(nested));
    expect(nestedJson.includes("10001")).toBe(false);
    expect(nestedJson.includes("99887766")).toBe(false);
  });

  // Regression: an incomplete metacharacter escape made secrets containing '*' compile to a
  // quantifier, so they were never matched and never redacted.
  it("redacts secrets containing regex metacharacters", () => {
    for (const secret of ["pa*ss+word", "a.b?c", "x[y]z", "p^q$r", "(paren)"]) {
      const redactor = new Redactor({ secrets: [secret], piiValues: [] });
      const out = redactor.redactString(`value is ${secret} here`);
      expect(out.includes(secret)).toBe(false);
      expect(out).toContain("«redacted:secret»");
    }
  });
});
