import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reconcileBgTasks } from "../src/her-core/bg-task-reconcile.ts";
import { type BgTaskRecord, loadBgTask, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask, stopBgTask } from "../src/her-core/bg-task-spawn.ts";

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g223-envelope-"));
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
		command: [process.execPath, "-e", "setTimeout(()=>{},10000)"],
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

async function envelope(root: string): Promise<Record<string, unknown>[]> {
	const raw = await readFile(join(root, "runs", "events.jsonl"), "utf8").catch(() => "");
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("G-223: bg-task status migrations append wakeable run envelopes once", async () => {
	const root = await memoryRoot();
	const started = await spawnBgTask(root, {
		objective: "envelope completed task",
		command: [process.execPath, "-e", "setTimeout(()=>{},10000)"],
		skipGates: true,
		ownerSessionId: "owner-session",
	});
	assert.equal(started.status, "running");
	if (started.status !== "running") return;
	const runningLines = await envelope(root);
	assert.equal(runningLines.length, 1);
	assert.deepEqual(runningLines[0], {
		type: "run",
		runId: started.id,
		status: "running",
		kind: "subagent",
		source: "cheap_worker",
		title: "envelope completed task",
		at: runningLines[0]?.at,
		ownerWorkspaceId: "owner-session",
		bgTaskId: started.id,
	});
	await writeFile(
		join(tasksDir(root), `${started.id}.done`),
		JSON.stringify({ exitCode: 0, endedAt: "2026-08-04T12:00:00.000Z" }),
		"utf8",
	);
	await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:00:01.000Z") });
	assert.equal((await loadBgTask(root, started.id))?.record.status, "completed");
	const completedLines = await envelope(root);
	assert.equal(completedLines.length, 2);
	assert.equal(completedLines[1]?.runId, started.id);
	assert.equal(completedLines[1]?.status, "done");
	assert.equal(completedLines[1]?.ownerWorkspaceId, "owner-session");
	assert.equal(completedLines[1]?.bgTaskId, started.id);
	await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:00:02.000Z") });
	assert.equal((await envelope(root)).length, 2, "reconcile must not append the same terminal state every tick");
	await stopBgTask(root, started.id);
});

test("G-223: failed and blocked-failed migrations append failed envelopes", async () => {
	const root = await memoryRoot();
	await seed(root, {
		id: "overrun",
		status: "running",
		objective: "envelope timeout task",
		ownerSessionId: "owner-session",
		startedAt: "2026-08-04T11:59:00.000Z",
		deadlineAt: "2026-08-04T12:00:00.000Z",
	});
	await reconcileBgTasks(root, {
		hostname: hostname(),
		now: new Date("2026-08-04T12:00:01.000Z"),
		stopTaskFn: async () => "already_gone",
	});
	await seed(root, {
		id: "upstream",
		status: "failed",
		objective: "upstream failure",
		ownerSessionId: "owner-session",
	});
	await seed(root, {
		id: "blocked",
		status: "pending",
		objective: "blocked failure",
		ownerSessionId: "owner-session",
		blockedBy: ["upstream"],
	});
	await reconcileBgTasks(root, { hostname: hostname(), now: new Date("2026-08-04T12:00:02.000Z") });
	const lines = await envelope(root);
	const byId = new Map(lines.map((line) => [line.runId, line]));
	assert.equal(byId.get("overrun")?.status, "failed");
	assert.equal(byId.get("blocked")?.status, "failed");
	assert.equal(byId.get("overrun")?.bgTaskId, "overrun");
	assert.equal(byId.get("blocked")?.ownerWorkspaceId, "owner-session");
	assert.equal(byId.get("overrun")?.piSessionId, undefined);
	assert.equal(byId.get("blocked")?.piSessionId, undefined);
});
