#!/usr/bin/env node
/**
 * G-83 digestion freshness — exit 0 when green, 1 when RED (stdout includes RED lines).
 * Usage: HER_MEMORY_DIR=... node freshness-check.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDigestionFreshness } from "../../../../samantha-ui/src/lib/digestion-freshness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function memoryRootFromEnv() {
  const raw = process.env.HER_MEMORY_DIR?.trim();
  if (raw) return resolve(raw);
  const samanthaRoot = resolve(__dirname, "../../..");
  return resolve(samanthaRoot, "../her-memory");
}

const root = memoryRootFromEnv();
const report = evaluateDigestionFreshness(root);

for (const line of report.info) console.log(line);

if (report.ok) {
  console.log("OK digestion freshness");
  process.exit(0);
}

for (const reason of report.red) console.log(`RED ${reason}`);
process.exit(1);
