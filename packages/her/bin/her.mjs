#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const cliPath = resolve(packageRoot, "src/cli.ts");

const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...process.argv.slice(2)], {
	cwd: repoRoot,
	env: process.env,
	stdio: "inherit",
});

process.exitCode = result.status ?? 1;
