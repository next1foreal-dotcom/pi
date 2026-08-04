import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { loadRuntimeConfig } from "../src/her-core/bg-task-config.ts";
import { formatWakeMessage, reconcileBgTasks } from "../src/her-core/bg-task-reconcile.ts";
import { type BgTaskRecord, formatDisplayStatus, loadBgTask, saveBgTask } from "../src/her-core/bg-task-record.ts";
import { listBgTasks, spawnBgTask, stopBgTask } from "../src/her-core/bg-task-spawn.ts";
import { ensureTaskWorktree } from "../src/her-core/long-task-worktree.ts";
import { git } from "../src/her-core/memory-utils.ts";

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g125-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(
		join(root, ".her", "config.yaml"),
		["tasks:", "  max_concurrent: 3", "  max_retries: 2", "  retry_on: [orphaned, never_started]", ""].join("\n"),
		"utf8",
	);
	return root;
}

function baseRecord(over: Partial<BgTaskRecord> & { id: string }): BgTaskRecord {
	const { id, ...rest } = over;
	return {
		status: "running",
		objective: "demo",
		worker: "cheap_worker",
		command: [process.execPath, "-e", "console.log(1)"],
		created: "2026-01-01T00:00:00.000Z",
		updated: "2026-01-01T00:00:00.000Z",
		retries: 0,
		host: "THIS-BOX",
		...rest,
		id,
	};
}

test("H.5 displayStatus annotates foreign host", async () => {
	const root = await memoryRoot();
	const record = baseRecord({ id: "t-20260726-fx", host: "other-box", status: "running" });
	await saveBgTask(root, record, "# remote\n");
	const list = await listBgTasks(root, { hostname: "THIS-BOX" });
	assert.equal(list[0]?.displayStatus, "running@other-box");
	assert.equal(formatDisplayStatus(record, "THIS-BOX"), "running@other-box");
});

test("H.3 deadline → failed/timeout + stop", async () => {
	const root = await memoryRoot();
	const id = "t-20260726-to";
	let stopped = false;
	await saveBgTask(
		root,
		baseRecord({
			id,
			status: "running",
			host: "THIS-BOX",
			deadlineAt: "2020-01-01T00:00:00.000Z",
			command: [process.execPath, "-e", "setTimeout(()=>{},99999)"],
		}),
		"# timeout\n",
	);
	const events = await reconcileBgTasks(root, {
		hostname: "THIS-BOX",
		now: new Date("2026-07-26T12:00:00.000Z"),
		skipRetry: true,
		stopTaskFn: async () => {
			stopped = true;
			return "stopped";
		},
	});
	assert.equal(stopped, true);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.failureReason, "timeout");
	const loaded = await loadBgTask(root, id);
	assert.equal(loaded?.record.status, "failed");
	assert.equal(loaded?.record.failureReason, "timeout");
	assert.ok(loaded?.record.notifiedAt);
	assert.equal(loaded?.record.lockedBy, undefined);
});

test("H.4 never_started auto-retry spawns child with parentTask", async () => {
	const root = await memoryRoot();
	const id = "t-20260726-ns";
	await saveBgTask(
		root,
		baseRecord({
			id,
			status: "pending",
			host: "THIS-BOX",
			retries: 0,
			created: "2020-01-01T00:00:00.000Z",
			command: [process.execPath, "-e", "setTimeout(()=>{}, 30000)"],
		}),
		"# never\n",
	);
	const events = await reconcileBgTasks(root, {
		hostname: "THIS-BOX",
		now: new Date("2026-07-26T12:00:00.000Z"),
		launchGraceSeconds: 1,
	});
	assert.equal(events[0]?.failureReason, "never_started");
	assert.ok(events[0]?.retryTaskId);
	const child = await loadBgTask(root, events[0]!.retryTaskId!);
	assert.equal(child?.record.parentTask, id);
	assert.equal(child?.record.retries, 1);
	assert.equal(child?.record.status, "running");
	assert.match(formatWakeMessage(events), /retry→/);
	if (child) await stopBgTask(root, child.record.id);
	await sleep(50);
});

test("H.1 lease: held lock skips second launcher (T17)", async () => {
	const root = await memoryRoot();
	const id = "t-20260726-lease";
	await saveBgTask(
		root,
		baseRecord({
			id,
			status: "running",
			host: "THIS-BOX",
			deadlineAt: "2020-01-01T00:00:00.000Z",
			lockedBy: "other-session:1",
			lockExpiresAt: "2099-01-01T00:00:00.000Z",
		}),
		"# leased\n",
	);
	const events = await reconcileBgTasks(root, {
		hostname: "THIS-BOX",
		now: new Date("2026-07-26T12:00:00.000Z"),
		lockId: "this-session:2",
		skipRetry: true,
		stopTaskFn: async () => "stopped",
	});
	assert.deepEqual(events, []);
	const loaded = await loadBgTask(root, id);
	assert.equal(loaded?.record.status, "running");
	assert.equal(loaded?.record.lockedBy, "other-session:1");
});

test("H.2 worktree=true records path and runs with HER_TASK_CWD", async () => {
	const codeRoot = await mkdtemp(join(tmpdir(), "her-code-"));
	await git(codeRoot, "init");
	await git(codeRoot, "config", "user.email", "test@her.local");
	await git(codeRoot, "config", "user.name", "her-test");
	await writeFile(join(codeRoot, "README.md"), "hi\n", "utf8");
	await git(codeRoot, "add", "README.md");
	await git(codeRoot, "commit", "-q", "-m", "init");

	const wtRoot = await mkdtemp(join(tmpdir(), "her-wt-"));
	const prev = process.env.HER_LONGTASK_WORKTREE_ROOT;
	process.env.HER_LONGTASK_WORKTREE_ROOT = wtRoot;

	const root = await memoryRoot();
	try {
		const result = await spawnBgTask(root, {
			objective: "cwd check",
			command: [process.execPath, "-e", "console.log(process.cwd())"],
			worktree: true,
			codeRoot,
			skipGates: true,
			heartbeatMs: 1000,
		});
		assert.equal(result.status, "running");
		if (result.status !== "running") return;
		assert.ok(result.worktree);
		const loaded = await loadBgTask(root, result.id);
		assert.ok(loaded?.record.worktree);
		assert.equal(loaded?.record.codeRoot, codeRoot);
		// ensure helper path matches
		const expected = await ensureTaskWorktree(codeRoot, result.id, {
			env: { ...process.env, HER_LONGTASK_WORKTREE_ROOT: wtRoot },
		});
		assert.equal(loaded?.record.worktree, expected.worktreePath);
		await stopBgTask(root, result.id);
	} finally {
		if (prev === undefined) delete process.env.HER_LONGTASK_WORKTREE_ROOT;
		else process.env.HER_LONGTASK_WORKTREE_ROOT = prev;
	}
});

test("config fail-loud throws when tasks section missing", () => {
	return (async () => {
		const root = await mkdtemp(join(tmpdir(), "her-fl-"));
		await mkdir(join(root, ".her"), { recursive: true });
		await writeFile(join(root, ".her", "config.yaml"), "llm:\n  model: x\n", "utf8");
		assert.throws(() => loadRuntimeConfig(root, { failLoud: true }), /fail-loud/);
	})();
});

test("listBgTasks keeps local status without @host", async () => {
	const root = await memoryRoot();
	const r = await spawnBgTask(root, {
		objective: "local",
		command: [process.execPath, "-e", "setTimeout(()=>{},20000)"],
		skipGates: true,
		heartbeatMs: 2000,
	});
	assert.equal(r.status, "running");
	const list = await listBgTasks(root);
	const row = list.find((t) => t.id === r.id);
	assert.equal(row?.displayStatus, "running");
	if (r.status === "running") await stopBgTask(root, r.id);
});
