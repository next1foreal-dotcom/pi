import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { herTaskOutput, readLogChunk } from "../src/her-core/bg-task-output.ts";
import { formatWakeMessage, reconcileBgTasks } from "../src/her-core/bg-task-reconcile.ts";
import { loadBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask, stopBgTask } from "../src/her-core/bg-task-spawn.ts";
import { resolveWorkerCommand } from "../src/her-core/task-executor.ts";

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-bg-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	return root;
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

test("T1: node -e worker completes with exit 0 and log", async () => {
	const root = await memoryRoot();
	const result = await spawnBgTask(root, {
		objective: "echo ok",
		command: [process.execPath, "-e", "console.log('OK')"],
		heartbeatMs: 1000,
		skipGates: true,
	});
	assert.equal(result.status, "running");
	await waitForDone(root, result.id);
	const events = await reconcileBgTasks(root);
	assert.equal(events.length, 1);
	assert.equal(events[0].status, "completed");
	assert.equal(events[0].exitCode, 0);
	const log = await readFile(join(tasksDir(root), `${result.id}.log`), "utf8");
	assert.match(log, /OK/);
	// T12: second reconcile no wake
	assert.deepEqual(await reconcileBgTasks(root), []);
});

test("T2: nonzero exit → failed", async () => {
	const root = await memoryRoot();
	const result = await spawnBgTask(root, {
		objective: "fail",
		command: [process.execPath, "-e", "process.exit(3)"],
		heartbeatMs: 1000,
		skipGates: true,
	});
	assert.equal(result.status, "running");
	await waitForDone(root, result.id);
	const events = await reconcileBgTasks(root);
	assert.equal(events[0].status, "failed");
	assert.equal(events[0].failureReason, "nonzero_exit");
	assert.equal(events[0].exitCode, 3);
});

test("T6: stop is idempotent", async () => {
	const root = await memoryRoot();
	const result = await spawnBgTask(root, {
		objective: "long",
		command: [process.execPath, "-e", "setTimeout(()=>{}, 60000)"],
		heartbeatMs: 1000,
		skipGates: true,
	});
	assert.equal(result.status, "running");
	await sleep(200);
	const first = await stopBgTask(root, result.id);
	assert.equal(first.result, "stopped");
	assert.equal(first.status, "cancelled");
	const second = await stopBgTask(root, result.id);
	assert.ok(second.result === "stopped" || second.result === "already_gone");
});

test("T6b: stop immediately after spawn kills the runner (no pid-file window)", async () => {
	const root = await memoryRoot();
	const result = await spawnBgTask(root, {
		objective: "long",
		command: [process.execPath, "-e", "setTimeout(()=>{}, 60000)"],
		heartbeatMs: 1000,
		skipGates: true,
	});
	assert.equal(result.status, "running");
	// No sleep: stop lands inside the runner-boot window and must still kill the tree.
	const stopped = await stopBgTask(root, result.id);
	assert.equal(stopped.result, "stopped");
	assert.equal(stopped.status, "cancelled");
	const pid = JSON.parse(await readFile(join(tasksDir(root), `${result.id}.pid`), "utf8")) as {
		runnerPid: number;
	};
	const start = Date.now();
	for (;;) {
		try {
			process.kill(pid.runnerPid, 0);
		} catch {
			break; // runner gone — no orphan
		}
		if (Date.now() - start > 10_000) {
			assert.fail(`runner ${pid.runnerPid} still alive after stop`);
		}
		await sleep(50);
	}
});

test("T8: UTF-8 safe chunk read", () => {
	// Chinese "测" is e6 b5 8b — split mid-sequence
	const bytes = Buffer.from("ab测cd", "utf8");
	const partial = bytes.subarray(0, 4); // ab + first byte of 测
	const { chunk, nextOffset } = readLogChunk(partial, partial.length, 0);
	assert.equal(chunk, "ab");
	assert.equal(nextOffset, 2);
});

test("her_task_output paginates", async () => {
	const root = await memoryRoot();
	const result = await spawnBgTask(root, {
		objective: "log",
		command: [process.execPath, "-e", "console.log('ABCDEFGHIJ')"],
		heartbeatMs: 1000,
		skipGates: true,
	});
	await waitForDone(root, result.id);
	const a = await herTaskOutput(root, result.id, { offset: 0, limit: 4 });
	assert.ok(a.chunk.length <= 4);
	const b = await herTaskOutput(root, result.id, { offset: a.nextOffset, limit: 100 });
	assert.equal(`${a.chunk}${b.chunk}`.includes("ABCDEFGHIJ"), true);
});

test("resolveWorkerCommand wraps .cmd on win32", () => {
	if (process.platform !== "win32") return;
	const resolved = resolveWorkerCommand(["C:\\\\fake\\\\tool.cmd", "--version"]);
	assert.match(resolved.file.toLowerCase(), /cmd\.exe$/);
	assert.ok(resolved.args.includes("/c"));
});

test("formatWakeMessage empty → empty", () => {
	assert.equal(formatWakeMessage([]), "");
});

test("T15 foreign host skipped by reconcile", async () => {
	const root = await memoryRoot();
	const id = "t-20260726-foreign";
	const md = `---
id: ${id}
status: running
objective: remote
worker: cheap_worker
command:
  - node
created: 2026-01-01T00:00:00.000Z
updated: 2026-01-01T00:00:00.000Z
retries: 0
host: other-box
---
# remote
`;
	await writeFile(join(tasksDir(root), `${id}.md`), md, "utf8");
	const events = await reconcileBgTasks(root, { hostname: "THIS-BOX" });
	assert.deepEqual(events, []);
	const loaded = await loadBgTask(root, id);
	assert.equal(loaded?.record.status, "running");
});
