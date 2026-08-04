import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_TASKS_CONFIG, type TasksConfig } from "../src/her-core/bg-task-config.ts";
import { reconcileBgTasks } from "../src/her-core/bg-task-reconcile.ts";
import { type BgTaskRecord, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import {
	EVENT_WAKE_SPAWN_REFUSAL,
	eventWakeSpawnBlocked,
	recordEventWake,
	shouldEventWake,
	WAKE_TURN_BOUNDARY,
} from "../src/her-core/event-wake.ts";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const YESTERDAY = new Date("2026-07-25T23:00:00.000Z");

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g132-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(join(root, ".her", "config.yaml"), "tasks:\n  budget_daily_cap: 999\n", "utf8");
	return root;
}

function tasks(over: Partial<TasksConfig> = {}): TasksConfig {
	return { ...DEFAULT_TASKS_CONFIG, ...over };
}

async function seedAudit(root: string, usd: number): Promise<void> {
	await mkdir(join(root, "audit"), { recursive: true });
	await writeFile(
		join(root, "audit", "2026-07-26.jsonl"),
		`${JSON.stringify({ ts: "2026-07-26T09:00:00.000Z", tool: "her_task_spawn", cost: { usd } })}\n`,
		"utf8",
	);
}

// GWT-1 — idle session + new .done: the gate opens on a fresh ledger and the wake
// is recorded as "sent". (Telegram-first ordering and the single followUp are
// extension wiring — see JUDGE notes in the handoff.)
test("GWT-1 gate opens on a fresh ledger and records a sent wake", async () => {
	const root = await memoryRoot();
	const gate = await shouldEventWake(root, tasks({ eventWakeEnabled: true, eventWakeDailyMax: 6 }), NOW);
	assert.deepEqual(gate, { ok: true });

	await recordEventWake(root, ["t-1"], "sent", NOW);
	const ledger = await readFile(join(root, ".her", "tasks", "wake-ledger.jsonl"), "utf8");
	const row = JSON.parse(ledger.trim());
	assert.equal(row.status, "sent");
	assert.deepEqual(row.taskIds, ["t-1"]);
	assert.equal(row.at, NOW.toISOString());
});

// GWT-2 — exactly-once regression: once reconcile stamps notifiedAt, a second scan
// (e.g. another live session polling the same store) yields zero events, so the
// same finished task never double-wakes. This is the multi-session no-double-wake
// guarantee (design §多会话语义: no cross-session lock; per-record stamp dedupes).
test("GWT-2 a task already notifiedAt yields zero repeat wakes", async () => {
	const root = await memoryRoot();
	const id = "t-20260726-done";
	const record: BgTaskRecord = {
		id,
		status: "running",
		objective: "demo",
		worker: "cheap_worker",
		command: [process.execPath, "-e", "0"],
		created: "2026-07-26T11:00:00.000Z",
		updated: "2026-07-26T11:00:00.000Z",
		retries: 0,
		host: "THIS-BOX",
	};
	await saveBgTask(root, record, "# demo\n");
	await writeFile(join(tasksDir(root), `${id}.done`), '{"exitCode":0}\n', "utf8");

	const first = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW });
	assert.equal(first.length, 1);
	assert.equal(first[0]?.taskId, id);
	assert.equal(first[0]?.status, "completed");

	const second = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW });
	assert.deepEqual(second, []);
});

// GWT-3 — daily_cap: once today's "sent" count reaches the cap the gate closes with
// reason=daily_cap. Rows from another UTC day are ignored (day-boundary filter).
test("GWT-3 daily_cap closes the gate at the cap; other-day rows ignored", async () => {
	const root = await memoryRoot();
	const cfg = tasks({ eventWakeDailyMax: 2 });

	await recordEventWake(root, ["old"], "sent", YESTERDAY); // different UTC day — must not count
	await recordEventWake(root, ["a"], "sent", NOW);
	assert.deepEqual(await shouldEventWake(root, cfg, NOW), { ok: true }); // 1 today < 2

	await recordEventWake(root, ["b"], "sent", NOW);
	assert.deepEqual(await shouldEventWake(root, cfg, NOW), { ok: false, reason: "daily_cap" }); // 2 today >= 2
});

// GWT-4 — usd_cap: when the shared daily $ ledger is over budgetDailyCap the gate
// closes with reason=usd_cap (same ledger enforceDailyCostCap guards for spawn).
test("GWT-4 usd_cap closes the gate when the daily $ ledger is over budget", async () => {
	const root = await memoryRoot();
	await seedAudit(root, 25);
	const gate = await shouldEventWake(root, tasks({ budgetDailyCap: 20, eventWakeDailyMax: 6 }), NOW);
	assert.deepEqual(gate, { ok: false, reason: "usd_cap" });
});

// GWT-5 — send-failure path: a "failed" row must NOT consume daily_cap budget, so a
// burst of failed sends never starves a later legitimate wake.
test("GWT-5 failed rows do not count toward daily_cap", async () => {
	const root = await memoryRoot();
	const cfg = tasks({ eventWakeDailyMax: 1 });

	await recordEventWake(root, ["x"], "failed", NOW);
	await recordEventWake(root, ["y"], "failed", NOW);
	assert.deepEqual(await shouldEventWake(root, cfg, NOW), { ok: true }); // only "sent" counts

	await recordEventWake(root, ["z"], "sent", NOW);
	assert.deepEqual(await shouldEventWake(root, cfg, NOW), { ok: false, reason: "daily_cap" }); // 1 sent >= 1
});

// GWT-6 — kill switch: enabled=false short-circuits to reason=disabled regardless of
// cap/cost state, leaving pure G-120 behavior (Telegram enqueue is decoupled upstream).
test("GWT-6 enabled=false short-circuits to reason=disabled", async () => {
	const root = await memoryRoot();
	await recordEventWake(root, ["a"], "sent", NOW); // cap/cost state is irrelevant when disabled
	await seedAudit(root, 999);
	const gate = await shouldEventWake(root, tasks({ eventWakeEnabled: false }), NOW);
	assert.deepEqual(gate, { ok: false, reason: "disabled" });
});

// GWT-7 — spawn hard-block predicate: her_task_spawn is refused only when the call
// happens inside a wake turn AND the block is enabled. Outside a wake turn, or with
// the block disabled, the predicate is false (falls through to the existing G-122 gate).
test("GWT-7 spawn is blocked only inside a wake turn with the block enabled", () => {
	assert.equal(eventWakeSpawnBlocked(true, tasks({ eventWakeSpawnBlock: true })), true);
	assert.equal(eventWakeSpawnBlocked(true, tasks({ eventWakeSpawnBlock: false })), false);
	assert.equal(eventWakeSpawnBlocked(false, tasks({ eventWakeSpawnBlock: true })), false);
	assert.ok(EVENT_WAKE_SPAWN_REFUSAL.length > 0);
	assert.match(WAKE_TURN_BOUNDARY, /her_task_output/);
	assert.match(WAKE_TURN_BOUNDARY, /待办/);
});

// 闸序 — gate order is fixed: disabled > daily_cap > usd_cap. With every gate tripped
// at once, the earliest-checked reason must win.
test("gate order: disabled beats daily_cap beats usd_cap", async () => {
	const root = await memoryRoot();
	await recordEventWake(root, ["a"], "sent", NOW); // trips daily_cap at max=1
	await seedAudit(root, 99); // trips usd_cap at budget=1

	assert.deepEqual(
		await shouldEventWake(root, tasks({ eventWakeEnabled: false, eventWakeDailyMax: 1, budgetDailyCap: 1 }), NOW),
		{ ok: false, reason: "disabled" },
	);
	assert.deepEqual(
		await shouldEventWake(root, tasks({ eventWakeEnabled: true, eventWakeDailyMax: 1, budgetDailyCap: 1 }), NOW),
		{ ok: false, reason: "daily_cap" },
	);
	assert.deepEqual(
		await shouldEventWake(root, tasks({ eventWakeEnabled: true, eventWakeDailyMax: 6, budgetDailyCap: 1 }), NOW),
		{ ok: false, reason: "usd_cap" },
	);
});
