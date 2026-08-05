import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reconcileBgTasks, resolveDependencyActions } from "../src/her-core/bg-task-reconcile.ts";
import { type BgTaskRecord, loadBgTask, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask, stopBgTask } from "../src/her-core/bg-task-spawn.ts";

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g221-"));
	await mkdir(tasksDir(root), { recursive: true });
	await writeFile(join(root, ".her", "config.yaml"), "tasks:\n  budget_daily_cap: 999\n", "utf8");
	return root;
}

function baseRecord(over: Partial<BgTaskRecord> & { id: string }): BgTaskRecord {
	const { id, ...rest } = over;
	return {
		status: "pending",
		objective: id,
		worker: "node",
		command: [process.execPath, "-e", "setTimeout(()=>{},1000)"],
		created: "2026-08-04T11:59:00.000Z",
		updated: "2026-08-04T11:59:00.000Z",
		retries: 0,
		host: hostname(),
		...rest,
		id,
	};
}

async function seed(root: string, over: Partial<BgTaskRecord> & { id: string }): Promise<void> {
	await saveBgTask(root, baseRecord(over), "# task\n");
}

test("blockedBy missing task ids fail loud", async () => {
	const root = await memoryRoot();
	await assert.rejects(
		spawnBgTask(root, {
			objective: "missing dependency",
			command: [process.execPath, "-e", ""],
			blockedBy: ["missing-a", "missing-b"],
			skipGates: true,
		}),
		/error.*missing-a.*missing-b|missing-a.*missing-b/i,
	);
});

test("resolveDependencyActions never unlocks a self-reference", () => {
	assert.deepEqual(resolveDependencyActions([{ id: "A", status: "pending", blockedBy: ["A"] }]), {
		toSpawn: [],
		toBlockFail: [],
	});
});

test("pending dependency does not launch", async () => {
	const root = await memoryRoot();
	await seed(root, { id: "upstream", status: "running" });
	const result = await spawnBgTask(root, {
		objective: "wait for upstream",
		command: [process.execPath, "-e", "setTimeout(()=>{},10000)"],
		blockedBy: ["upstream"],
		skipGates: true,
	});
	assert.equal(result.status, "pending");
	if (result.status !== "pending") return;
	assert.equal((await loadBgTask(root, result.id))?.record.status, "pending");
	await assert.rejects(readFile(join(tasksDir(root), `${result.id}.pid`)));
	await stopBgTask(root, result.id);
});

test("completed upstream unlocks exactly once", async () => {
	const root = await memoryRoot();
	await seed(root, { id: "upstream", status: "completed", notifiedAt: "2026-08-04T12:00:00.000Z" });
	await seed(root, { id: "downstream", blockedBy: ["upstream"] });
	const first = await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:00:00Z") });
	assert.deepEqual(first, []);
	const running = (await loadBgTask(root, "downstream"))?.record;
	assert.equal(running?.status, "running");
	assert.equal(typeof running?.unlockedAt, "number");
	const pid = running?.runnerPid;
	assert.equal(
		(await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:00:01Z") })).length,
		0,
	);
	assert.equal((await loadBgTask(root, "downstream"))?.record.runnerPid, pid);
	await stopBgTask(root, "downstream");
});

test("failed upstream blocks without spawning", async () => {
	const root = await memoryRoot();
	await seed(root, { id: "upstream", status: "failed", failureReason: "nonzero_exit" });
	await seed(root, { id: "downstream", blockedBy: ["upstream"] });
	const events = await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:00:00Z") });
	assert.equal(events[0]?.status, "blocked-failed");
	const record = (await loadBgTask(root, "downstream"))?.record;
	assert.equal(record?.status, "blocked-failed");
	assert.equal(record?.blockedFailedBy, "upstream");
	await assert.rejects(readFile(join(tasksDir(root), "downstream.pid")));
});

test("two reconcile passes never double-spawn", async () => {
	const root = await memoryRoot();
	await seed(root, { id: "upstream", status: "completed", notifiedAt: "2026-08-04T12:00:00.000Z" });
	await seed(root, { id: "downstream", blockedBy: ["upstream"] });
	await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:00:00Z") });
	const firstPid = (await loadBgTask(root, "downstream"))?.record.runnerPid;
	await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:00:01Z") });
	assert.equal((await loadBgTask(root, "downstream"))?.record.runnerPid, firstPid);
	await stopBgTask(root, "downstream");
});

test("task without blockedBy keeps normal spawn behavior", async () => {
	const root = await memoryRoot();
	const result = await spawnBgTask(root, {
		objective: "normal",
		command: [process.execPath, "-e", "setTimeout(()=>{},10000)"],
		skipGates: true,
	});
	assert.equal(result.status, "running");
	if (result.status === "running") await stopBgTask(root, result.id);
});

test("A to B to C unlocks in order", async () => {
	const root = await memoryRoot();
	await seed(root, { id: "A", status: "completed", notifiedAt: "2026-08-04T12:00:00.000Z" });
	await seed(root, { id: "B", blockedBy: ["A"], command: [process.execPath, "-e", "setTimeout(()=>{},1000)"] });
	await seed(root, { id: "C", blockedBy: ["B"] });
	await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:00:00Z") });
	assert.equal((await loadBgTask(root, "B"))?.record.status, "running");
	assert.equal((await loadBgTask(root, "C"))?.record.status, "pending");
	const started = Date.now();
	while (!(await readFile(join(tasksDir(root), "B.done"), "utf8").catch(() => "")) && Date.now() - started < 5000) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:00:02Z") });
	assert.equal((await loadBgTask(root, "C"))?.record.status, "running");
	await stopBgTask(root, "C");
});

// G-223 exam findings — deadline semantics for blocked tasks and late reconciles.

test("G-223: blocked task past its filed deadline keeps waiting", async () => {
	const root = await memoryRoot();
	await seed(root, { id: "upstream", status: "running", startedAt: "2026-08-04T11:59:00.000Z" });
	await writeFile(join(tasksDir(root), "upstream.heartbeat"), "2026-08-04T12:29:55.000Z", "utf8");
	await seed(root, { id: "blocked", blockedBy: ["upstream"], deadlineAt: "2026-08-04T12:00:00.000Z" });
	await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:30:00Z") });
	const record = (await loadBgTask(root, "blocked"))?.record;
	assert.equal(record?.status, "pending");
	assert.equal(record?.failureReason, undefined);
});

test("G-223: done inside the deadline beats a late reconcile", async () => {
	const root = await memoryRoot();
	await seed(root, {
		id: "ontime",
		status: "running",
		startedAt: "2026-08-04T11:59:10.000Z",
		deadlineAt: "2026-08-04T12:00:00.000Z",
	});
	await writeFile(
		join(tasksDir(root), "ontime.done"),
		JSON.stringify({ exitCode: 0, endedAt: "2026-08-04T11:59:30.000Z" }),
		"utf8",
	);
	await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:30:00Z") });
	const record = (await loadBgTask(root, "ontime"))?.record;
	assert.equal(record?.status, "completed");
	assert.equal(record?.failureReason, undefined);
});

test("G-223: running past deadline with no completion evidence still times out", async () => {
	const root = await memoryRoot();
	await seed(root, {
		id: "overrun",
		status: "running",
		startedAt: "2026-08-04T11:59:00.000Z",
		deadlineAt: "2026-08-04T12:00:00.000Z",
	});
	const record0 = await reconcileBgTasks(root, {
		hostname: hostname(),
		now: new Date("2026-08-04T12:00:01Z"),
		stopTaskFn: async () => "already_gone",
	});
	assert.equal(record0[0]?.status, "failed");
	const record = (await loadBgTask(root, "overrun"))?.record;
	assert.equal(record?.status, "failed");
	assert.equal(record?.failureReason, "timeout");
});

test("G-223: unlock re-bases the deadline to unlock time + original grant", async () => {
	const root = await memoryRoot();
	await seed(root, { id: "upstream", status: "completed", notifiedAt: "2026-08-04T12:00:00.000Z" });
	await seed(root, {
		id: "downstream",
		blockedBy: ["upstream"],
		created: "2026-08-04T11:59:00.000Z",
		deadlineAt: "2026-08-04T12:01:00.000Z",
	});
	await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:30:00Z") });
	const record = (await loadBgTask(root, "downstream"))?.record;
	assert.equal(record?.status, "running");
	const rebased = Date.parse(record?.deadlineAt ?? "");
	assert.ok(
		Number.isFinite(rebased) && rebased > Date.parse("2026-08-04T12:30:00Z"),
		`deadline should re-base past the unlock pass, got ${record?.deadlineAt}`,
	);
	await stopBgTask(root, "downstream");
});
