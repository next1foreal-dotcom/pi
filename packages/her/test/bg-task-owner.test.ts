import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
	formatOwnerTakeoverNote,
	isOwnerTakeover,
	OWNER_WAKE_GRACE_MS,
	shouldDeferToOwner,
	sortEventsByOwner,
} from "../src/her-core/bg-task-owner.ts";
import { reconcileBgTasks } from "../src/her-core/bg-task-reconcile.ts";
import { type BgTaskRecord, loadBgTask, saveBgTask, taskMdPath, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask, stopBgTask } from "../src/her-core/bg-task-spawn.ts";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const FRESH = "2026-08-02T11:58:00.000Z"; // 2 min ago — inside the grace window
const STALE = "2026-08-02T11:30:00.000Z"; // 30 min ago — past the grace window

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g185-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(join(root, ".her", "config.yaml"), "tasks:\n  budget_daily_cap: 999\n", "utf8");
	return root;
}

function baseRecord(over: Partial<BgTaskRecord> & { id: string }): BgTaskRecord {
	const { id, ...rest } = over;
	return {
		status: "running",
		objective: "demo",
		worker: "cheap_worker",
		command: [process.execPath, "-e", "console.log(1)"],
		created: FRESH,
		updated: FRESH,
		retries: 0,
		host: "THIS-BOX",
		...rest,
		id,
	};
}

// S1-1 四态 — the whole owner-first decision table on the pure predicate.
test("S1-1 shouldDeferToOwner: owner 是我 / 不是我 / ownerless / 超宽限接手", () => {
	const mine = baseRecord({ id: "t-mine", status: "completed", endedAt: FRESH, ownerSessionId: "session-A" });
	const theirs = baseRecord({ id: "t-theirs", status: "completed", endedAt: FRESH, ownerSessionId: "session-B" });
	const ownerless = baseRecord({ id: "t-none", status: "completed", endedAt: FRESH });
	const stale = baseRecord({ id: "t-stale", status: "completed", endedAt: STALE, ownerSessionId: "session-B" });

	// owner 是我 → 我送
	assert.equal(shouldDeferToOwner(mine, "session-A", NOW_MS), false);
	assert.equal(isOwnerTakeover(mine, "session-A", NOW_MS), false);
	// owner 不是我 → 留给 owner
	assert.equal(shouldDeferToOwner(theirs, "session-A", NOW_MS), true);
	assert.equal(isOwnerTakeover(theirs, "session-A", NOW_MS), false);
	// ownerless(旧记录) → 现行为不变: 先到先得
	assert.equal(shouldDeferToOwner(ownerless, "session-A", NOW_MS), false);
	assert.equal(isOwnerTakeover(ownerless, "session-A", NOW_MS), false);
	// 终态超过宽限 → 任何会话可代送
	assert.equal(shouldDeferToOwner(stale, "session-A", NOW_MS), false);
	assert.equal(isOwnerTakeover(stale, "session-A", NOW_MS), true);
});

// S1-2 宽限边界 — exactly at OWNER_WAKE_GRACE_MS the takeover opens (>=, not >).
test("S1-2 grace boundary flips defer → takeover at OWNER_WAKE_GRACE_MS", () => {
	const endedAt = new Date(NOW_MS - OWNER_WAKE_GRACE_MS).toISOString();
	const record = baseRecord({ id: "t-edge", status: "completed", endedAt, ownerSessionId: "session-B" });
	assert.equal(shouldDeferToOwner(record, "session-A", NOW_MS), false);
	assert.equal(isOwnerTakeover(record, "session-A", NOW_MS), true);
	// one ms earlier is still the owner's
	assert.equal(shouldDeferToOwner(record, "session-A", NOW_MS - 1), true);
});

// S1-3 未知会话 id 不许偷 — an owned task is never claimed by a session with no id.
test("S1-3 unknown session id defers to a named owner", () => {
	const record = baseRecord({ id: "t-anon", status: "completed", endedAt: FRESH, ownerSessionId: "session-B" });
	assert.equal(shouldDeferToOwner(record, undefined, NOW_MS), true);
});

test("S1-4 formatOwnerTakeoverNote is empty without takeovers and names ids with them", () => {
	assert.equal(formatOwnerTakeoverNote([]), "");
	const note = formatOwnerTakeoverNote(["t-a", "t-b"]);
	assert.match(note, /代送/);
	assert.match(note, /t-a, t-b/);
});

// S1-5 分拣 — the real thing: one reconcile batch, two sessions, opposite outcomes.
// Non-owner produces no wake; the owner produces one. Same events, same disk.
test("S1-5 非 owner 会话不产 wake, owner 会话产", async () => {
	const root = await memoryRoot();
	const id = "t-20260802-owned";
	await saveBgTask(root, baseRecord({ id, ownerSessionId: "session-A" }), "# owned\n");
	await writeFile(join(tasksDir(root), `${id}.done`), '{"exitCode":0}\n', "utf8");

	const events = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW });
	assert.equal(events.length, 1);
	assert.equal(events[0]?.status, "completed");

	const foreign = await sortEventsByOwner(root, events, "session-B", NOW);
	assert.deepEqual(foreign.deliver, []);
	assert.deepEqual(foreign.deferred, [id]);
	assert.deepEqual(foreign.takenOver, []);

	const owner = await sortEventsByOwner(root, events, "session-A", NOW);
	assert.equal(owner.deliver.length, 1);
	assert.equal(owner.deliver[0]?.taskId, id);
	assert.deepEqual(owner.deferred, []);
	assert.deepEqual(owner.takenOver, []);
});

// S1-6 代送 — a task whose owner never showed up is delivered by whoever is around,
// and lands in takenOver so the wake message can say so.
test("S1-6 owner 超宽限没接手 → 别的会话代送并标注", async () => {
	const root = await memoryRoot();
	const id = "t-20260802-stale";
	await saveBgTask(
		root,
		baseRecord({ id, status: "completed", endedAt: STALE, exitCode: 0, ownerSessionId: "session-A" }),
		"# stale\n",
	);

	const events = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW });
	assert.equal(events.length, 1);

	const sorted = await sortEventsByOwner(root, events, "session-B", NOW);
	assert.equal(sorted.deliver.length, 1);
	assert.deepEqual(sorted.deferred, []);
	assert.deepEqual(sorted.takenOver, [id]);
	assert.match(formatOwnerTakeoverNote(sorted.takenOver), /t-20260802-stale/);
});

// S1-7 fail toward delivery — an event whose record cannot be read is never silently
// swallowed; it is delivered as if ownerless.
test("S1-7 missing record is delivered, not deferred", async () => {
	const root = await memoryRoot();
	const sorted = await sortEventsByOwner(
		root,
		[{ taskId: "t-ghost", status: "completed", objective: "gone" }],
		"session-B",
		NOW,
	);
	assert.equal(sorted.deliver.length, 1);
	assert.deepEqual(sorted.deferred, []);
});

// S1-8 落盘 — the spawn path really writes ownerSessionId into the task frontmatter,
// and a spawn without an owner keeps the legacy shape (no field at all).
test("S1-8 spawnBgTask persists ownerSessionId; ownerless spawn is unchanged", async () => {
	const root = await memoryRoot();
	const owned = await spawnBgTask(root, {
		objective: "owner plumbing",
		command: [process.execPath, "-e", "setTimeout(()=>{},20000)"],
		ownerSessionId: "session-owner-1",
		skipGates: true,
		heartbeatMs: 2000,
	});
	assert.equal(owned.status, "running");
	if (owned.status !== "running") return;
	const ownedText = await readFile(taskMdPath(root, owned.id), "utf8");
	assert.match(ownedText, /^ownerSessionId: session-owner-1$/m);
	assert.equal((await loadBgTask(root, owned.id))?.record.ownerSessionId, "session-owner-1");

	const anon = await spawnBgTask(root, {
		objective: "no owner",
		command: [process.execPath, "-e", "setTimeout(()=>{},20000)"],
		skipGates: true,
		heartbeatMs: 2000,
	});
	assert.equal(anon.status, "running");
	if (anon.status !== "running") return;
	assert.doesNotMatch(await readFile(taskMdPath(root, anon.id), "utf8"), /ownerSessionId/);

	await stopBgTask(root, owned.id);
	await stopBgTask(root, anon.id);
	await sleep(50);
});
