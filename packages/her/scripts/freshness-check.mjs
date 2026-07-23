#!/usr/bin/env node
// Suggested registration (run from the stable main checkout, not this worktree):
// schtasks /create /tn "\Her\freshness" /sc daily /st 06:30 /tr "node D:\@Her\Her-repo\samantha\packages\her\scripts\freshness-check.mjs" /f

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_MEMORY_DIR = "D:\\@Her\\her-memory";
const EVENT_PATTERN = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[([^\]]+)] (start:|batch \d+\/\d+:|exit \d+:)/;

function parseHours(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return hours;
}

function parseTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const timestamp = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function formatAge(timestamp, now) {
  return ((now.getTime() - timestamp.getTime()) / (60 * 60 * 1000)).toFixed(1);
}

function parseLog(log) {
  const lastSuccesses = new Map();
  const lastEvents = new Map();

  for (const line of log.split(/\r?\n/)) {
    const match = EVENT_PATTERN.exec(line);
    if (!match) continue;

    const [, timestampText, task, event] = match;
    const timestamp = parseTimestamp(timestampText);
    if (!timestamp) continue;

    lastEvents.set(task, { event, timestamp, timestampText });
    if (event === "exit 0:") {
      lastSuccesses.set(task, { timestamp, timestampText });
    }
  }

  return { lastEvents, lastSuccesses };
}

function freshnessCheck(task, hours, now, lastSuccesses) {
  const success = lastSuccesses.get(task);
  if (!success) {
    return {
      name: task,
      ok: false,
      reason: "no successful run on record",
    };
  }

  const age = formatAge(success.timestamp, now);
  if (success.timestamp.getTime() > now.getTime() || Number(age) > hours) {
    return {
      name: task,
      ok: false,
      reason: `last successful run ${success.timestampText} is ${age}h old (threshold ${hours}h)`,
      lastSuccessAt: success.timestampText,
    };
  }

  return {
    name: task,
    ok: true,
    reason: `last successful run ${success.timestampText} is ${age}h old (threshold ${hours}h)`,
    lastSuccessAt: success.timestampText,
  };
}

function truncationCheck(now, graceHours, lastEvents) {
  const stalled = [];
  for (const [task, event] of lastEvents) {
    if (event.event === "exit 0:" || /^exit \d+:$/.test(event.event)) continue;
    const age = formatAge(event.timestamp, now);
    if (event.timestamp.getTime() <= now.getTime() && Number(age) > graceHours) {
      stalled.push(`${task} ${event.timestampText} (${age}h old)`);
    }
  }

  return stalled.length > 0
    ? {
        name: "truncation",
        ok: false,
        reason: `truncated or unfinished run: ${stalled.join(", ")}`,
      }
    : {
        name: "truncation",
        ok: true,
        reason: "no stale unfinished runs",
      };
}

function circuitBreakerCheck(circuitPath) {
  return existsSync(circuitPath)
    ? {
        name: "circuit-breaker",
        ok: false,
        reason: `${circuitPath} exists`,
      }
    : {
        name: "circuit-breaker",
        ok: true,
        reason: `${circuitPath} is absent`,
      };
}

function writeStatus(statusPath, status) {
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, statusPath);
}

function run() {
  const memoryDir = process.env.HER_MEMORY_DIR || DEFAULT_MEMORY_DIR;
  const growthLogPath = process.env.HER_GROWTH_LOG || join(memoryDir, ".her", "growth.log");
  const statusPath = join(memoryDir, ".her", "freshness-status.json");
  const circuitPath = join(memoryDir, ".heartbeat-circuit-open");
  const now = process.env.HER_FRESHNESS_NOW ? new Date(process.env.HER_FRESHNESS_NOW) : new Date();
  const checks = [];

  try {
    if (Number.isNaN(now.getTime())) throw new Error("HER_FRESHNESS_NOW must be a valid ISO timestamp");
    const consolidateHours = parseHours("HER_FRESHNESS_CONSOLIDATE_HOURS", 48);
    const synthesizeHours = parseHours("HER_FRESHNESS_SYNTHESIZE_HOURS", 192);
    const graceHours = parseHours("HER_FRESHNESS_INFLIGHT_GRACE_HOURS", 2);

    if (!existsSync(growthLogPath)) {
      checks.push(
        { name: "consolidate", ok: false, reason: `growth log not found: ${growthLogPath}` },
        { name: "synthesize", ok: false, reason: `growth log not found: ${growthLogPath}` },
        { name: "truncation", ok: false, reason: `growth log not found: ${growthLogPath}` },
      );
    } else {
      const parsed = parseLog(readFileSync(growthLogPath, "utf8"));
      checks.push(
        freshnessCheck("consolidate", consolidateHours, now, parsed.lastSuccesses),
        freshnessCheck("synthesize", synthesizeHours, now, parsed.lastSuccesses),
        truncationCheck(now, graceHours, parsed.lastEvents),
      );
    }
  } catch (error) {
    checks.push(
      { name: "consolidate", ok: false, reason: `could not inspect growth log: ${error.message}` },
      { name: "synthesize", ok: false, reason: `could not inspect growth log: ${error.message}` },
      { name: "truncation", ok: false, reason: `could not inspect growth log: ${error.message}` },
    );
  }

  checks.push(circuitBreakerCheck(circuitPath));
  let red = checks.some((check) => !check.ok);
  let statusWriteError;

  try {
    writeStatus(statusPath, { checkedAt: now.toISOString(), red, checks });
  } catch (error) {
    statusWriteError = `could not write status file ${statusPath}: ${error.message}`;
    red = true;
  }

  for (const check of checks) {
    console.log(`${check.ok ? "OK" : "RED"} ${check.name}: ${check.reason}`);
  }
  if (statusWriteError) console.log(`RED status-file: ${statusWriteError}`);

  return red ? 1 : 0;
}

process.exitCode = run();
