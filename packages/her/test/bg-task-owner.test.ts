import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
	classifyOwnerWake,
	formatOwnerTakeoverNote,
	isOwnerTakeover,
	OWNER_WAKE_GRACE_MS,
	shouldDeferToOwner,
} from "../src/her-core/bg-task-owner.ts";
import { reconcileBgTasks } from "../src/her-core/bg-task-reconcile.ts";
import { type BgTaskRecord, loadBgTask, saveBgTask, taskMdPath, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask, stopBgTask } from "../src/her-core/bg-task-spawn.ts";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const LATER = new Date(NOW_MS + OWNER_WAKE_GRACE_MS + 60_000); // past the grace window
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

	// owner 是我 → 我认领
	assert.equal(classifyOwnerWake(mine, "session-A", NOW_MS), "own");
	assert.equal(shouldDeferToOwner(mine, "session-A", NOW_MS), false);
	// owner 不是我 → 留给 owner
	assert.equal(classifyOwnerWake(theirs, "session-A", NOW_MS), "defer");
	assert.equal(shouldDeferToOwner(theirs, "session-A", NOW_MS), true);
	// ownerless(旧记录) → 现行为不变: 先到先得
	assert.equal(classifyOwnerWake(ownerless, "session-A", NOW_MS), "own");
	assert.equal(shouldDeferToOwner(ownerless, "session-A", NOW_MS), false);
	// 终态超过宽限 → 任何会话可代送
	assert.equal(classifyOwnerWake(stale, "session-A", NOW_MS), "takeover");
	assert.equal(shouldDeferToOwner(stale, "session-A", NOW_MS), false);
	assert.equal(isOwnerTakeover(stale, "session-A", NOW_MS), true);
});

// S1-2 宽限边界 — exactly at OWNER_WAKE_GRACE_MS the takeover opens (>=, not >).
test("S1-2 grace boundary flips defer → takeover at OWNER_WAKE_GRACE_MS", () => {
	const endedAt = new Date(NOW_MS - OWNER_WAKE_GRACE_MS).toISOString();
	const record = baseRecord({ id: "t-edge", status: "completed", endedAt, ownerSessionId: "session-B" });
	assert.equal(classifyOwnerWake(record, "session-A", NOW_MS), "takeover");
	// one ms earlier is still the owner's
	assert.equal(classifyOwnerWake(record, "session-A", NOW_MS - 1), "defer");
});

// S1-3 无会话身份的调用方(无头 reconcile)不许抢 — it may claim ownerless work at once,
// owned work only after the owner's grace window lapsed.
test("S1-3 headless caller defers to a named owner until grace lapses", () => {
	const owned = baseRecord({ id: "t-anon", status: "completed", endedAt: FRESH, ownerSessionId: "session-B" });
	const ownerless = baseRecord({ id: "t-anon2", status: "completed", endedAt: FRESH });
	assert.equal(classifyOwnerWake(owned, undefined, NOW_MS), "defer");
	assert.equal(classifyOwnerWake(ownerless, undefined, NOW_MS), "own");
	assert.equal(classifyOwnerWake(owned, undefined, NOW_MS + OWNER_WAKE_GRACE_MS), "takeover");
});

test("S1-4 formatOwnerTakeoverNote is empty without takeovers and names ids with them", () => {
	assert.equal(formatOwnerTakeoverNote([]), "");
	const note = formatOwnerTakeoverNote(["t-a", "t-b"]);
	assert.match(note, /代送/);
	assert.match(note, /t-a, t-b/);
});

// S1b-1 无损三部曲 — the whole point of moving the stamp to the claim point.
// ① 非 owner 会话 B 先 reconcile: 状态照常推进到 completed, 但 notifiedAt 不盖、事件不返回;
// ② owner 会话 A 后 reconcile: 事件返回并盖章;
// ③ 会话 B 再 reconcile: notifiedAt 已在 → 短路, 不重发。
test("S1b-1 无损三部曲: B 让路不消费 → A 认领拿到事件 → B 再扫不重发", async () => {
	const root = await memoryRoot();
	const id = "t-20260802-relay";
	await saveBgTask(root, baseRecord({ id, ownerSessionId: "session-A" }), "# owned\n");
	await writeFile(join(tasksDir(root), `${id}.done`), '{"exitCode":0}\n', "utf8");

	// ① B 先到: 让路
	const fromB = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW, sessionId: "session-B" });
	assert.deepEqual(fromB, [], "非 owner 会话不得产出事件");
	const afterB = await loadBgTask(root, id);
	assert.equal(afterB?.record.status, "completed", "状态转移照做");
	assert.equal(afterB?.record.notifiedAt, undefined, "notifiedAt 不许被让路的会话盖掉");
	assert.equal(afterB?.record.lockedBy, undefined, "不留租约脏数据");

	// ② A 后到: 认领
	const fromA = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW, sessionId: "session-A" });
	assert.equal(fromA.length, 1, "owner 会话必须拿到事件");
	assert.equal(fromA[0]?.taskId, id);
	assert.equal(fromA[0]?.status, "completed");
	assert.equal(fromA[0]?.takenOver, undefined, "owner 自己领的不算代送");
	assert.ok((await loadBgTask(root, id))?.record.notifiedAt, "认领时才盖章");

	// ③ B 再扫: 已盖章 → 不重发(GWT-2 不变式仍在, 只是多了归属维度)
	const againB = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW, sessionId: "session-B" });
	assert.deepEqual(againB, []);
	const againA = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW, sessionId: "session-A" });
	assert.deepEqual(againA, [], "owner 自己也不重发");
});

// S1b-2 takeover 串行 — owner 一直没回来, 宽限过后 B 认领并标注; A 迟到读到已盖章, 不重发。
test("S1b-2 超宽限 B 代送盖章, A 迟到不重发", async () => {
	const root = await memoryRoot();
	const id = "t-20260802-gone";
	await saveBgTask(root, baseRecord({ id, ownerSessionId: "session-A" }), "# owner gone\n");
	await writeFile(join(tasksDir(root), `${id}.done`), '{"exitCode":0}\n', "utf8");

	// 终态发生在 NOW, owner 从没露面
	assert.deepEqual(await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW, sessionId: "session-B" }), []);

	// 宽限之后 B 有资格代送
	const takeover = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: LATER, sessionId: "session-B" });
	assert.equal(takeover.length, 1);
	assert.equal(takeover[0]?.takenOver, true, "代送必须打标, 唤醒消息要说明");
	assert.match(formatOwnerTakeoverNote(takeover.map((e) => e.taskId)), /t-20260802-gone/);

	// A 迟到: 已盖章 → 不重发
	const late = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: LATER, sessionId: "session-A" });
	assert.deepEqual(late, [], "认领后 owner 迟到也不重发");
});

// S1b-3 ownerless 零变化 — 旧记录(无 ownerSessionId)仍是先到先得, GWT-2 原样成立。
test("S1b-3 ownerless task is still claimed by whoever reconciles first", async () => {
	const root = await memoryRoot();
	const id = "t-20260802-legacy";
	await saveBgTask(root, baseRecord({ id }), "# legacy\n");
	await writeFile(join(tasksDir(root), `${id}.done`), '{"exitCode":0}\n', "utf8");

	const first = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW, sessionId: "session-B" });
	assert.equal(first.length, 1);
	assert.equal(first[0]?.takenOver, undefined, "无主任务不是代送");
	assert.ok((await loadBgTask(root, id))?.record.notifiedAt);
	assert.deepEqual(await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW, sessionId: "session-A" }), []);
});

// S1b-4 让路不误伤重试/结算 — 让路的那趟不许触发自动重试(它跟认领绑在一起);
// owner 认领那趟才重试, 且子任务继承 ownerSessionId(欠账②)。
test("S1b-4 自动重试等到认领那趟, 子任务继承 owner", async () => {
	const root = await memoryRoot();
	const id = "t-20260802-retry";
	await saveBgTask(
		root,
		baseRecord({ id, status: "pending", created: "2020-01-01T00:00:00.000Z", ownerSessionId: "session-A" }),
		"# never started\n",
	);

	// B 让路: 不产事件, 也不许替 owner 派重试
	const fromB = await reconcileBgTasks(root, {
		hostname: "THIS-BOX",
		now: NOW,
		sessionId: "session-B",
		launchGraceSeconds: 1,
	});
	assert.deepEqual(fromB, []);
	const afterB = await loadBgTask(root, id);
	assert.equal(afterB?.record.status, "failed");
	assert.equal(afterB?.record.failureReason, "never_started");
	assert.equal(afterB?.record.retryTaskId, undefined, "让路的会话不许替 owner 派重试");

	// A 认领: 事件 + 重试子任务, 且子任务归 A
	const fromA = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW, sessionId: "session-A" });
	assert.equal(fromA.length, 1);
	const childId = fromA[0]?.retryTaskId;
	assert.ok(childId, "owner 认领那趟应触发重试");
	const child = await loadBgTask(root, childId as string);
	assert.equal(child?.record.parentTask, id);
	assert.equal(child?.record.ownerSessionId, "session-A", "重试子任务必须继承父任务归属");
	await stopBgTask(root, childId as string);
	await sleep(50);
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
