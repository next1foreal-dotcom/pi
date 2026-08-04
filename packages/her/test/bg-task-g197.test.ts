/**
 * G-197 — the task gate was denominated in a currency that never flows.
 *
 * Every configured worker runs on a subscription (`codex exec`, `claude -p`) or
 * on this machine (`deer`), so a background task costs no metered dollars. The
 * old gate reserved a flat $5 per task regardless, and four no-ops locked her
 * out for the day against money nobody spent.
 *
 * The two halves pinned here: a task's reservation comes from its *worker's*
 * declared price (absent = free), and the runaway guard counts **tasks** — the
 * unit that is actually scarce, because a loop that burns the subscription's
 * rate-limit window locks Fei out of his own tool.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_TASKS_CONFIG } from "../src/her-core/bg-task-config.ts";
import { type BgTaskRecord, loadBgTask, newTaskId, saveBgTask } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask } from "../src/her-core/bg-task-spawn.ts";
import { parseWorkers } from "../src/her-core/worker-profile.ts";

const NODE = process.execPath;

/** Two profiles: one subscription-shaped (no price), one that really costs money. */
function workersYaml(tasksSection = ""): string {
	return `${tasksSection}workers:
  free:
    argv: ["${NODE}", "-e", "0"]
  billed:
    argv: ["${NODE}", "-e", "0"]
    price_usd: 0.75
`;
}

async function memoryRoot(configYaml: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g197-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(join(root, ".her", "config.yaml"), configYaml, "utf8");
	return root;
}

function record(id: string): BgTaskRecord {
	return {
		id,
		status: "completed",
		objective: "seeded",
		worker: "free",
		command: [NODE, "-e", "0"],
		created: "2026-08-03T00:00:00.000Z",
		updated: "2026-08-03T00:00:00.000Z",
		retries: 0,
		host: "THIS-BOX",
	};
}

test("G-197-1 a worker may declare a price; absent means free", () => {
	const workers = parseWorkers(workersYaml());
	assert.equal(workers.billed.priceUsd, 0.75);
	assert.equal(workers.free.priceUsd, undefined, "a worker with no price_usd must not invent one");
});

test("G-197-2 a malformed price is loud, not silently free", () => {
	assert.throws(
		() =>
			parseWorkers(`workers:
  bad:
    argv: ["${NODE}"]
    price_usd: lots
`),
		/price_usd/,
	);
});

test("G-197-3 the default per-task reservation is zero, not five dollars", () => {
	assert.equal(
		DEFAULT_TASKS_CONFIG.budgetCap,
		0,
		"nothing on this machine bills per token; a non-zero default charges for a currency that never flows",
	);
});

test("G-197-4 an unpriced worker reserves nothing", async () => {
	const root = await memoryRoot(workersYaml());
	const result = await spawnBgTask(root, {
		objective: "free work",
		worker: "free",
		brief: "hi",
		skipGates: true,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	const saved = await loadBgTask(root, result.id);
	assert.equal(saved?.record.budgetReserved, 0);
});

test("G-197-5 a priced worker still reserves its real price", async () => {
	const root = await memoryRoot(workersYaml());
	const result = await spawnBgTask(root, {
		objective: "billed work",
		worker: "billed",
		brief: "hi",
		skipGates: true,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	const saved = await loadBgTask(root, result.id);
	assert.equal(saved?.record.budgetReserved, 0.75, "dollars must keep working for a worker that really costs them");
});

test("G-197-6 the runaway guard counts today's tasks and says so in tasks", async () => {
	const root = await memoryRoot(workersYaml("tasks:\n  daily_task_max: 2\n"));
	await saveBgTask(root, record(newTaskId()), "# seeded\n");
	await saveBgTask(root, record(newTaskId()), "# seeded\n");

	const result = await spawnBgTask(root, {
		objective: "the third one today",
		worker: "free",
		brief: "hi",
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "failed");
	if (result.status !== "failed") return;
	const gate = result.gates?.find((g) => g.name === "daily_tasks");
	assert.ok(gate, `expected a daily_tasks gate, got ${JSON.stringify(result.gates)}`);
	assert.match(gate.reason, /task/i);
	assert.doesNotMatch(gate.reason, /\$|usd|cost/i, "the reason must not quote money nobody spent");
});

test("G-197-7 yesterday's tasks do not count against today", async () => {
	const root = await memoryRoot(workersYaml("tasks:\n  daily_task_max: 2\n"));
	const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
	await saveBgTask(root, record(newTaskId(yesterday)), "# seeded\n");
	await saveBgTask(root, record(newTaskId(yesterday)), "# seeded\n");

	const result = await spawnBgTask(root, {
		objective: "first one today",
		worker: "free",
		brief: "hi",
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running", "a fresh day must start with a fresh count");
});
