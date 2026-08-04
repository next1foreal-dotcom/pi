#!/usr/bin/env node
/**
 * Append one Her run envelope line (G-106). Used from PowerShell heartbeat wrapper.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val && !val.startsWith("--")) {
      out[key] = val;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const memory = args.memory?.trim();
const runId = args["run-id"]?.trim();
const status = args.status?.trim();
const kind = args.kind?.trim() ?? "longtask";
const source = args.source?.trim() ?? "heartbeat";
const title = args.title?.trim() ?? runId;

if (!memory || !runId || !status) {
  console.error(
    "usage: node append-run-event.mjs --memory DIR --run-id ID --status running|done|failed [--kind] [--source] [--title]",
  );
  process.exit(2);
}

const at = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
const path = join(memory, "runs", "events.jsonl");
mkdirSync(dirname(path), { recursive: true });
const line = {
  type: "run",
  runId,
  status,
  kind,
  source,
  title,
  at,
};
appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
