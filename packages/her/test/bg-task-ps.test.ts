/**
 * G-369 — read-only background-task roster with heartbeat freshness.
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/bg-task-ps.test.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_TASKS_CONFIG } from "../src/her-core/bg-task-config.ts";
import { listBgTaskPs, renderBgTaskPs } from "../src/her-core/bg-task-ps.ts";
import { BG_TASK_STATUSES, type BgTaskRecord, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";

const STALE_LIMIT_MS = DEFAULT_TASKS_CONFIG.heartbeatSeconds * DEFAULT_TASKS_CONFIG.staleMultiplier * 1000;

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g369-ps-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	return root;
}

function record(over: Partial<BgTaskRecord> & { id: string }): BgTaskRecord {
	const { id, ...rest } = over;
	return {
		status: "running",
		objective: "demo",
		worker: "cheap_worker",
		command: ["node"],
		mode: "command",
		created: "2026-08-31T10:00:00.000Z",
		updated: "2026-08-31T10:00:00.000Z",
		retries: 0,
		host: "THIS-BOX",
		...rest,
		id,
	};
}

async function seedRoster(root: string): Promise<{
	fresh: string;
	stale: string;
	pending: string;
	done: string;
}> {
	const dir = tasksDir(root);
	const fresh = "t-20260831-fresh";
	const stale = "t-20260831-stale";
	const pending = "t-20260831-pend";
	const done = "t-20260831-done";
	const longObjective = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-OVERFLOW";

	await saveBgTask(
		root,
		record({
			id: fresh,
			status: "running",
			objective: longObjective,
			worker: "grok",
			mode: "worker",
			created: "2026-08-31T09:00:00.000Z",
			updated: "2026-08-31T12:00:00.000Z",
			worktree: "D:/wt/fresh",
			parentTask: "t-20260831-parent",
			retryTaskId: "t-20260831-retry",
		}),
	);
	await writeFile(join(dir, `${fresh}.heartbeat`), new Date().toISOString(), "utf8");

	await saveBgTask(
		root,
		record({
			id: stale,
			status: "running",
			objective: "stale runner",
			worker: "codex",
			updated: "2026-08-31T11:00:00.000Z",
		}),
	);
	const staleHb = join(dir, `${stale}.heartbeat`);
	await writeFile(staleHb, "2026-08-01T00:00:00.000Z", "utf8");
	const old = new Date(Date.now() - STALE_LIMIT_MS - 5_000);
	await utimes(staleHb, old, old);

	await saveBgTask(
		root,
		record({
			id: pending,
			status: "pending",
			objective: "queued, no beat",
			worker: "kimi",
			updated: "2026-08-31T10:30:00.000Z",
		}),
	);

	await saveBgTask(
		root,
		record({
			id: done,
			status: "completed",
			objective: "already finished",
			worker: "grok",
			updated: "2026-08-31T09:00:00.000Z",
		}),
	);
	const doneHb = join(dir, `${done}.heartbeat`);
	await writeFile(doneHb, "2026-08-01T00:00:00.000Z", "utf8");
	await utimes(doneHb, old, old);

	await writeFile(
		join(dir, "t-20260831-badrec.md"),
		["---", "id: t-20260831-badrec", "status: running", "objective: broken", "---", ""].join("\n"),
		"utf8",
	);
	await writeFile(join(dir, `${fresh}.result.md`), "# sidecar, not a record\n", "utf8");

	return { fresh, stale, pending, done };
}

test("listBgTaskPs: heartbeat freshness, skip bad records, terminal dash", async () => {
	const root = await memoryRoot();
	const ids = await seedRoster(root);
	const { rows, skipped } = await listBgTaskPs(root);

	assert.equal(skipped, 1);
	assert.equal(rows.length, 4);

	const byId = new Map(rows.map((row) => [row.id, row]));
	const fresh = byId.get(ids.fresh);
	const stale = byId.get(ids.stale);
	const pending = byId.get(ids.pending);
	const done = byId.get(ids.done);

	assert.ok(fresh);
	assert.equal(fresh.status, "running");
	assert.equal(fresh.heartbeat, "fresh");
	assert.equal(fresh.worker, "grok");
	assert.equal(fresh.mode, "worker");
	assert.equal(fresh.objective.length, 60);
	assert.equal(fresh.worktree, "D:/wt/fresh");
	assert.equal(fresh.parentTask, "t-20260831-parent");
	assert.equal(fresh.retryTaskId, "t-20260831-retry");
	assert.equal(typeof fresh.ageMinutes, "number");
	assert.ok(fresh.ageMinutes >= 0);

	assert.ok(stale);
	assert.equal(stale.status, "running");
	assert.equal(stale.heartbeat, "stale");

	assert.ok(pending);
	assert.equal(pending.status, "pending");
	assert.equal(pending.heartbeat, "none");

	assert.ok(done);
	assert.equal(done.status, "completed");
	assert.equal(done.heartbeat, "—");
});

test("listBgTaskPs: status filter", async () => {
	const root = await memoryRoot();
	await seedRoster(root);
	const { rows, skipped } = await listBgTaskPs(root, { status: "running" });
	assert.equal(skipped, 1);
	assert.deepEqual(rows.map((row) => row.id).sort(), ["t-20260831-fresh", "t-20260831-stale"]);
	assert.ok(rows.every((row) => row.status === "running"));
});

test("listBgTaskPs: illegal status throws with legal enum", async () => {
	const root = await memoryRoot();
	await assert.rejects(
		() => listBgTaskPs(root, { status: "nope" }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			for (const status of BG_TASK_STATUSES) {
				assert.ok(error.message.includes(status), `missing ${status} in: ${error.message}`);
			}
			return true;
		},
	);
});

test("listBgTaskPs: sort by updated desc and honor limit", async () => {
	const root = await memoryRoot();
	const ids = await seedRoster(root);
	const all = await listBgTaskPs(root);
	assert.deepEqual(
		all.rows.map((row) => row.id),
		[ids.fresh, ids.stale, ids.pending, ids.done],
	);

	const limited = await listBgTaskPs(root, { limit: 2 });
	assert.equal(limited.rows.length, 2);
	assert.deepEqual(
		limited.rows.map((row) => row.id),
		[ids.fresh, ids.stale],
	);
	assert.equal(limited.skipped, 1);
});

test("listBgTaskPs: default limit 20", async () => {
	const root = await memoryRoot();
	for (let i = 0; i < 21; i++) {
		const n = String(i).padStart(2, "0");
		await saveBgTask(
			root,
			record({
				id: `t-20260831-lim${n}`,
				status: "completed",
				updated: `2026-08-31T12:${n}:00.000Z`,
			}),
		);
	}
	const { rows } = await listBgTaskPs(root);
	assert.equal(rows.length, 20);
	assert.equal(rows[0]?.id, "t-20260831-lim20");
	assert.ok(!rows.some((row) => row.id === "t-20260831-lim00"));
});

test("renderBgTaskPs includes id and heartbeat states", async () => {
	const root = await memoryRoot();
	const ids = await seedRoster(root);
	const { rows } = await listBgTaskPs(root);
	const text = renderBgTaskPs(rows);
	assert.ok(text.includes(ids.fresh));
	assert.ok(text.includes(ids.stale));
	assert.ok(text.includes(ids.pending));
	assert.ok(text.includes(ids.done));
	assert.match(text, /hb:fresh/);
	assert.match(text, /hb:stale/);
	assert.match(text, /hb:none/);
	assert.match(text, /hb:—/);
	assert.ok(text.includes(" · "));
});
