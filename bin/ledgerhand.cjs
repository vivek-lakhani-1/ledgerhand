#!/usr/bin/env node
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tsx = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
const cli = path.join(__dirname, "..", "src", "cli", "index.ts");
const result = spawnSync(tsx, [cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
