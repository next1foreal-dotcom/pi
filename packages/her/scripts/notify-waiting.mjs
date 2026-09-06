#!/usr/bin/env node
/**
 * G-429 waiting notifier — scan her sessions, drop an outbox item for every new
 * "我在等你", exit 0 when clean and 1 when the notifier itself is broken.
 *
 * It does NOT send anything and needs no token: sending is `her telegram-push-outbox`,
 * which drains the same directory. Split that way so this half can be verified
 * end to end before a bot token exists.
 *
 * Deliberately off her_status's call path — she calls her_status every turn, and
 * anything that can fail there can swallow her whole status. This is a side scan:
 * idempotent, re-runnable, and harmless when it dies.
 *
 * Usage (scheduled task or by hand, from anywhere):
 *   node packages/her/scripts/notify-waiting.mjs
 *   node packages/her/scripts/notify-waiting.mjs --dry-run
 * Env:
 *   HER_MEMORY_DIR       memory root      (default <repo>/../her-memory)
 *   HER_PI_SESSION_DIR   session jsonl    (default <HER_BUILD_DIR|%TMP%/samantha-builds>/.pi-sessions)
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emptyWaitingLedger,
  parseSessionWaiting,
  planWaitingOutbox,
  scanWaitingOutbox,
  sessionDirFromEnv,
} from "../src/her-core/waiting-outbox.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function memoryRootFromEnv() {
  const raw = process.env.HER_MEMORY_DIR?.trim();
  if (raw) return resolve(raw);
  const samanthaRoot = resolve(__dirname, "../../..");
  return resolve(samanthaRoot, "../her-memory");
}

/** --dry-run reports what would be written without touching the outbox or the ledger. */
async function dryRun(sessionDir) {
  const files = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).sort();
  const sessions = [];
  for (const file of files) {
    const parsed = parseSessionWaiting(file, await readFile(join(sessionDir, file), "utf8"));
    if (parsed) sessions.push(parsed);
  }
  const plan = planWaitingOutbox(sessions, emptyWaitingLedger(), new Date().toISOString());
  console.log(`scanned ${files.length} sessions, ${sessions.length} waiting (dry run, ledger ignored)`);
  for (const entry of plan.entries) console.log(`would write outbox/${entry.file}\n${entry.body}`);
}

const sessionDir = sessionDirFromEnv();
const memoryRoot = memoryRootFromEnv();

try {
  if (process.argv.includes("--dry-run")) {
    await dryRun(sessionDir);
  } else {
    const result = await scanWaitingOutbox({ memoryRoot, sessionDir });
    for (const warning of result.warnings) console.warn(`WARN ${warning}`);
    for (const skip of result.skipped) console.log(`skip ${skip.sessionId} (${skip.reason})`);
    for (const item of result.written) console.log(`wrote ${item.path} for ${item.sessionId}`);
    console.log(`OK scanned ${result.scanned} sessions, ${result.waiting} waiting, ${result.written.length} queued`);
  }
  process.exit(0);
} catch (error) {
  console.error(`FAILED waiting notifier: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`  sessions: ${sessionDir}`);
  console.error(`  memory:   ${memoryRoot}`);
  process.exit(1);
}
