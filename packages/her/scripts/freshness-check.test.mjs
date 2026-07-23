import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "freshness-check.mjs");
const now = "2026-07-23T12:00:00";

function fixture(log = "", options = {}) {
  const memoryDir = mkdtempSync(join(tmpdir(), "freshness-check-"));
  const herDir = join(memoryDir, ".her");
  const growthLogPath = join(herDir, "growth.log");
  const circuitPath = join(memoryDir, ".heartbeat-circuit-open");

  mkdirSync(herDir, { recursive: true });
  writeFileSync(growthLogPath, log, "utf8");
  if (options.circuitOpen) writeFileSync(circuitPath, "open\n", "utf8");

  return {
    memoryDir,
    growthLogPath,
    cleanup() {
      rmSync(memoryDir, { recursive: true, force: true });
    },
  };
}

function run(memoryDir, env = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      HER_MEMORY_DIR: memoryDir,
      HER_FRESHNESS_NOW: now,
      ...env,
    },
  });
}

function healthyLog() {
  return [
    "2026-07-22 12:00:00 [consolidate] start: node consolidate",
    "2026-07-22 12:01:00 [consolidate] exit 0: {}",
    "2026-07-22 12:00:00 [synthesize] start: node synthesize",
    "2026-07-22 12:01:00 [synthesize] exit 0: {}",
    "",
  ].join("\n");
}

test("reports four OK checks for recent successful runs", () => {
  const subject = fixture(healthyLog());
  try {
    const result = run(subject.memoryDir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.match(/^OK /gm)?.length, 4);
  } finally {
    subject.cleanup();
  }
});

test("reports RED when consolidate success is stale", () => {
  const subject = fixture(healthyLog().replaceAll("2026-07-22", "2026-07-20"));
  try {
    const result = run(subject.memoryDir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RED consolidate/);
  } finally {
    subject.cleanup();
  }
});

test("reports RED when synthesize has no successful run", () => {
  const subject = fixture([
    "2026-07-22 12:00:00 [consolidate] exit 0: {}",
    "",
  ].join("\n"));
  try {
    const result = run(subject.memoryDir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RED synthesize: no successful run on record/);
  } finally {
    subject.cleanup();
  }
});

test("reports RED when the circuit-breaker file exists", () => {
  const subject = fixture(healthyLog(), { circuitOpen: true });
  try {
    const result = run(subject.memoryDir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RED circuit-breaker/);
  } finally {
    subject.cleanup();
  }
});

test("reports RED for a stale unfinished batch", () => {
  const subject = fixture(`${healthyLog()}2026-07-23 07:00:00 [consolidate] batch 3/30: node consolidate\n`);
  try {
    const result = run(subject.memoryDir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RED truncation/);
    assert.match(result.stdout, /truncat/i);
  } finally {
    subject.cleanup();
  }
});

test("does not report a recent unfinished batch as truncation", () => {
  const subject = fixture(`${healthyLog()}2026-07-23 11:30:00 [consolidate] batch 3/30: node consolidate\n`);
  try {
    const result = run(subject.memoryDir);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /RED truncation/);
  } finally {
    subject.cleanup();
  }
});

test("lists every RED condition without short-circuiting", () => {
  const subject = fixture("2026-07-20 12:00:00 [consolidate] exit 0: {}\n", { circuitOpen: true });
  try {
    const result = run(subject.memoryDir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RED consolidate/);
    assert.match(result.stdout, /RED synthesize/);
    assert.match(result.stdout, /RED circuit-breaker/);
  } finally {
    subject.cleanup();
  }
});

test("writes parseable status matching the process result", () => {
  const subject = fixture(healthyLog(), { circuitOpen: true });
  try {
    const result = run(subject.memoryDir);
    const statusPath = join(subject.memoryDir, ".her", "freshness-status.json");
    assert.equal(existsSync(statusPath), true);
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    assert.equal(status.red, result.status === 1);
    assert.equal(status.checks.length, 4);
  } finally {
    subject.cleanup();
  }
});
