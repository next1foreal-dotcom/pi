import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { parseTasksPublish } from "../src/her-core/bg-task-config.ts";
import { loadBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask } from "../src/her-core/bg-task-spawn.ts";
import {
	claimWarmSlot,
	clampWarmPoolSize,
	drainWarmPool,
	ensureWarmPool,
	listReadySlots,
	WARM_POOL_MAX,
	waitForWarmReady,
} from "../src/her-core/warm-worker-pool.ts";

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-warm-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	return root;
}

async function writeEchoStdinFixture(dir: string): Promise<string> {
	const path = join(dir, "echo-stdin.mjs");
	await writeFile(
		path,
		[
			"const chunks = [];",
			"process.stdin.on('data', (c) => chunks.push(c));",
			"process.stdin.on('end', () => {",
			"  process.stdout.write(Buffer.concat(chunks));",
			"  process.exit(0);",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	return path;
}

async function waitForDone(root: string, id: string, ms = 15_000): Promise<void> {
	const donePath = join(tasksDir(root), `${id}.done`);
	const start = Date.now();
	while (Date.now() - start < ms) {
		try {
			await readFile(donePath, "utf8");
			return;
		} catch {
			await sleep(50);
		}
	}
	throw new Error(`timeout waiting for ${id}.done`);
}

test("clampWarmPoolSize clamps to 0..2", () => {
	assert.equal(clampWarmPoolSize(-1), 0);
	assert.equal(clampWarmPoolSize(0), 0);
	assert.equal(clampWarmPoolSize(1), 1);
	assert.equal(clampWarmPoolSize(2), 2);
	assert.equal(clampWarmPoolSize(99), WARM_POOL_MAX);
	assert.equal(clampWarmPoolSize(1.9), 1);
});

test("parseTasksPublish reads warm_pool_size", () => {
	const parsed = parseTasksPublish("tasks:\n  warm_pool_size: 2\n  max_concurrent: 3\n");
	assert.equal(parsed.tasks?.warmPoolSize, 2);
});

test("ensureWarmPool pre-boots ready slots; drain clears them", async () => {
	const root = await memoryRoot();
	const taskDir = tasksDir(root);
	ensureWarmPool(taskDir, 2);
	assert.equal(waitForWarmReady(taskDir, 2, 8_000), true);
	const ready = listReadySlots(taskDir);
	assert.equal(ready.length, 2);
	assert.ok(ready.every((r) => r.pid > 0));
	drainWarmPool(taskDir);
	assert.equal(listReadySlots(taskDir).length, 0);
});

test("AC warm hit: spawnBgTask claims pre-warmed slot (pid.warm true)", async () => {
	const root = await memoryRoot();
	const fixture = await writeEchoStdinFixture(root);
	await writeFile(
		join(root, ".her", "config.yaml"),
		[
			"tasks:",
			"  warm_pool_size: 1",
			"  max_concurrent: 3",
			"workers:",
			"  fake:",
			`    argv: ["${process.execPath.replace(/\\/g, "/")}", "${fixture.replace(/\\/g, "/")}"]`,
			"",
		].join("\n"),
		"utf8",
	);

	const taskDir = tasksDir(root);
	ensureWarmPool(taskDir, 1);
	assert.equal(waitForWarmReady(taskDir, 1, 8_000), true);
	const before = listReadySlots(taskDir);
	assert.equal(before.length, 1);
	const warmPid = before[0].pid;

	const brief = "warm-hit-payload";
	const result = await spawnBgTask(root, {
		objective: "warm hit",
		worker: "fake",
		brief,
		skipGates: true,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status !== "running") return;

	const pidInfo = JSON.parse(await readFile(join(taskDir, `${result.id}.pid`), "utf8"));
	assert.equal(pidInfo.runnerPid, warmPid);
	assert.equal(pidInfo.warm, true);

	const loaded = await loadBgTask(root, result.id);
	assert.equal(loaded?.record.warmClaim, true);

	await waitForDone(root, result.id);
	const log = await readFile(join(taskDir, `${result.id}.log`), "utf8");
	assert.equal(log, brief);

	drainWarmPool(taskDir);
});

test("AC cold miss: claimWarmSlot on empty pool returns null; spawn still works cold", async () => {
	const root = await memoryRoot();
	const fixture = await writeEchoStdinFixture(root);
	const taskDir = tasksDir(root);
	assert.equal(claimWarmSlot(taskDir, "t-empty", [process.execPath, "-e", "process.exit(0)"]), null);

	await writeFile(
		join(root, ".her", "config.yaml"),
		[
			"tasks:",
			"  warm_pool_size: 0",
			"workers:",
			"  fake:",
			`    argv: ["${process.execPath.replace(/\\/g, "/")}", "${fixture.replace(/\\/g, "/")}"]`,
			"",
		].join("\n"),
		"utf8",
	);

	const result = await spawnBgTask(root, {
		objective: "cold path",
		worker: "fake",
		brief: "cold",
		skipGates: true,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status !== "running") return;

	await waitForDone(root, result.id);
	const pidInfo = JSON.parse(await readFile(join(taskDir, `${result.id}.pid`), "utf8"));
	assert.notEqual(pidInfo.warm, true);
});

test("AC warm_pool_size 0: never claims", async () => {
	const root = await memoryRoot();
	const fixture = await writeEchoStdinFixture(root);
	await writeFile(
		join(root, ".her", "config.yaml"),
		[
			"tasks:",
			"  warm_pool_size: 0",
			"workers:",
			"  fake:",
			`    argv: ["${process.execPath.replace(/\\/g, "/")}", "${fixture.replace(/\\/g, "/")}"]`,
			"",
		].join("\n"),
		"utf8",
	);

	const result = await spawnBgTask(root, {
		objective: "pool off",
		worker: "fake",
		brief: "off",
		skipGates: true,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status !== "running") return;
	const loaded = await loadBgTask(root, result.id);
	assert.notEqual(loaded?.record.warmClaim, true);
	await waitForDone(root, result.id);
});

test("exclusive claim: two claimants do not share one slot", async () => {
	const root = await memoryRoot();
	const taskDir = tasksDir(root);
	ensureWarmPool(taskDir, 1);
	assert.equal(waitForWarmReady(taskDir, 1, 8_000), true);

	const exitNow = [process.execPath, "-e", "setTimeout(() => process.exit(0), 200)"];
	const a = claimWarmSlot(taskDir, "t-claim-a", exitNow, { heartbeatMs: 1000, env: process.env });
	assert.ok(a !== null);

	const b = claimWarmSlot(taskDir, "t-claim-b", exitNow, { heartbeatMs: 1000, env: process.env });
	assert.equal(b, null);

	drainWarmPool(taskDir);
});
