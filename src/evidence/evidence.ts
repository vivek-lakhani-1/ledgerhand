import fs from "node:fs";
import path from "node:path";
import type { Capability, ReplayResult } from "../schema/index.js";
import { Redactor } from "../policy/redact.js";

function safeLabel(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unnamed";
}

export class EvidenceDir {
  readonly runId: string;
  readonly runDir: string;
  private readonly redactor: Redactor;
  private screenshotSequence = 0;
  private domSequence = 0;

  constructor(runId: string, redactor: Redactor, rootDir = "evidence") {
    this.runId = runId;
    this.redactor = redactor;
    this.runDir = path.join(rootDir, "runs", runId);
    fs.mkdirSync(path.join(this.runDir, "screenshots"), { recursive: true });
    fs.mkdirSync(path.join(this.runDir, "dom"), { recursive: true });
  }

  registerSecret(value: string | undefined): void {
    this.redactor.registerSecret(value);
  }

  registerPii(value: string | undefined): void {
    this.redactor.registerPii(value);
  }

  writeResult(result: ReplayResult): string {
    const resultPath = path.join(this.runDir, "result.json");
    fs.writeFileSync(resultPath, `${JSON.stringify(this.redactor.redactJson(result), null, 2)}\n`, "utf8");
    return resultPath;
  }

  writeCapability(capability: Capability): string {
    const capabilityPath = path.join(this.runDir, "capability.json");
    fs.writeFileSync(
      capabilityPath,
      `${JSON.stringify(this.redactor.redactJson(capability), null, 2)}\n`,
      "utf8",
    );
    return capabilityPath;
  }

  screenshotPath(label: string): string {
    this.screenshotSequence += 1;
    return path.join(
      this.runDir,
      "screenshots",
      `${String(this.screenshotSequence).padStart(2, "0")}-${safeLabel(label)}.png`,
    );
  }

  domPath(label: string): string {
    this.domSequence += 1;
    return path.join(
      this.runDir,
      "dom",
      `${String(this.domSequence).padStart(2, "0")}-${safeLabel(label)}.html`,
    );
  }

  writeText(relPath: string, contents: string): string {
    const destination = path.isAbsolute(relPath) ? relPath : path.join(this.runDir, relPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, this.redactor.redactString(contents), "utf8");
    return destination;
  }
}
