import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type BgTaskRecord, saveBgTask } from "../src/her-core/bg-task-record.ts";
import {
	captureSubscribedTask,
	claimTaskSubscription,
	completeTaskSubscription,
	createTaskSubscription,
	listTaskSubscriptions,
	releaseTaskSubscription,
	scanTaskSubscriptions,
	updateTaskSubscription,
} from "../src/task-subscriptions/store.ts";

const NOW = new Date("2026-10-05T08:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const root = await mkdtemp(join(tmpdir(), "her-task-subscriptions-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const task: BgTaskRecord = {
		id: "t-watch",
		status: "running",
		objective: "example",
		worker: "test",
		command: [process.execPath, "-e", "0"],
		host: "test",
		created: NOW.toISOString(),
		updated: NOW.toISOString(),
		retries: 0,
		ownerSessionId: "owner",
	};
	await saveBgTask(root, task);
	const create = (instruction = "失败时分析原因，完成后告诉我。\n保留原文。") =>
		createTaskSubscription(root, { taskId: task.id, ownerSessionId: "owner", instruction }, NOW);
	const terminal = {
		...task,
		status: "completed" as const,
		endedAt: later(1).toISOString(),
		updated: later(1).toISOString(),
		exitCode: 0,
	};
	return { root, task, create, terminal };
}

test("subscription persists exact instructions and repeated creation is idempotent", async (t) => {
	const f = await fixture(t);
	const a = await f.create();
	const b = await f.create();
	assert.equal(a.id, b.id);
	const rows = await listTaskSubscriptions(f.root, "owner");
	assert.equal(rows.length, 1);
	assert.equal(rows[0].instruction, a.instruction);
	const files = await readdir(join(f.root, "subscriptions", "tasks"));
	assert.equal(files.length, 1);
	assert.ok(files[0].endsWith(".md"));
	assert.match(await readFile(join(f.root, "subscriptions", "tasks", files[0]), "utf8"), /失败时分析原因/);
	await assert.rejects(f.create("different request"), /already/);
});

test("rejects unsafe task paths, missing tasks and another task owner's subscription", async (t) => {
	const f = await fixture(t);
	for (const taskId of ["../escape", "missing"])
		await assert.rejects(
			createTaskSubscription(f.root, { taskId, ownerSessionId: "owner", instruction: "watch" }, NOW),
		);
	await assert.rejects(
		createTaskSubscription(f.root, { taskId: f.task.id, ownerSessionId: "other", instruction: "watch" }, NOW),
		/owner/,
	);
	await assert.rejects(
		createTaskSubscription(
			f.root,
			{ taskId: f.task.id, ownerSessionId: "owner", instruction: "", expiresAt: NOW.toISOString() },
			NOW,
		),
	);
});

test("terminal event survives restart and metadata changes do not duplicate it", async (t) => {
	const f = await fixture(t);
	await f.create();
	assert.equal(await captureSubscribedTask(f.root, f.terminal), true);
	const first = (await listTaskSubscriptions(f.root, "owner"))[0];
	await captureSubscribedTask(f.root, {
		...f.terminal,
		updated: later(3000).toISOString(),
		notifiedAt: later(3000).toISOString(),
	});
	const second = (await listTaskSubscriptions(f.root, "owner"))[0];
	assert.equal(first.event?.id, second.event?.id);
	assert.equal(second.delivery.state, "pending");
	assert.equal(await claimTaskSubscription(f.root, "other", later(2)), null);
	assert.ok(await claimTaskSubscription(f.root, "owner", later(2)));
});

test("concurrent claimants yield one fenced lease", async (t) => {
	const f = await fixture(t);
	await f.create();
	await captureSubscribedTask(f.root, f.terminal);
	const claims = await Promise.all(Array.from({ length: 5 }, () => claimTaskSubscription(f.root, "owner", later(2))));
	assert.equal(claims.filter(Boolean).length, 1);
});

test("expired lease can recover and rejects the old worker's receipt", async (t) => {
	const f = await fixture(t);
	await f.create();
	await captureSubscribedTask(f.root, f.terminal);
	const old = await claimTaskSubscription(f.root, "owner", later(2), 1000);
	assert.ok(old);
	const fresh = await claimTaskSubscription(f.root, "owner", later(1003), 1000);
	assert.ok(fresh);
	assert.notEqual(old.delivery.token, fresh.delivery.token);
	await assert.rejects(
		completeTaskSubscription(f.root, old.id, "owner", old.delivery.token!, "stale", ["record"], later(1004)),
		/lease/,
	);
	await completeTaskSubscription(
		f.root,
		fresh.id,
		"owner",
		fresh.delivery.token!,
		"verified outcome",
		["record"],
		later(1004),
	);
	assert.equal(await claimTaskSubscription(f.root, "owner", later(1005)), null);
	const done = (await listTaskSubscriptions(f.root, "owner"))[0];
	assert.equal(done.state, "completed");
	assert.equal(done.delivery.result?.summary, "verified outcome");
});

test("pause catches terminal event but prevents execution until resumed", async (t) => {
	const f = await fixture(t);
	const s = await f.create();
	await updateTaskSubscription(f.root, s.id, "owner", "pause", NOW);
	await captureSubscribedTask(f.root, f.terminal);
	assert.equal(await claimTaskSubscription(f.root, "owner", later(2)), null);
	await updateTaskSubscription(f.root, s.id, "owner", "resume", later(3));
	assert.ok(await claimTaskSubscription(f.root, "owner", later(4)));
});

test("cancellation invalidates in-flight receipt and suppresses later delivery", async (t) => {
	const f = await fixture(t);
	const s = await f.create();
	await captureSubscribedTask(f.root, f.terminal);
	const claimed = await claimTaskSubscription(f.root, "owner", later(2));
	assert.ok(claimed);
	await updateTaskSubscription(f.root, s.id, "owner", "cancel", later(3));
	await assert.rejects(
		completeTaskSubscription(f.root, s.id, "owner", claimed.delivery.token!, "late", ["record"], later(4)),
		/active|lease/,
	);
	assert.equal(await captureSubscribedTask(f.root, f.terminal), true);
	assert.equal(await claimTaskSubscription(f.root, "owner", later(5)), null);
	await assert.rejects(updateTaskSubscription(f.root, s.id, "owner", "resume", later(6)), /cancelled/);
});

test("expiry stops pending execution and mutators enforce owner", async (t) => {
	const f = await fixture(t);
	const s = await createTaskSubscription(
		f.root,
		{ taskId: f.task.id, ownerSessionId: "owner", instruction: "watch", expiresAt: later(1000).toISOString() },
		NOW,
	);
	await captureSubscribedTask(f.root, f.terminal);
	await assert.rejects(updateTaskSubscription(f.root, s.id, "other", "cancel", NOW), /owner/);
	assert.equal(await claimTaskSubscription(f.root, "owner", later(1001)), null);
});

test("scan recovers terminal transitions even when legacy notifiedAt is set", async (t) => {
	const f = await fixture(t);
	await f.create();
	await saveBgTask(f.root, { ...f.terminal, notifiedAt: later(2).toISOString() });
	await scanTaskSubscriptions(f.root);
	assert.ok(await claimTaskSubscription(f.root, "owner", later(3)));
});

test("repeated failed handling stops at a bounded attempt count", async (t) => {
	const f = await fixture(t);
	await f.create();
	await captureSubscribedTask(f.root, f.terminal);
	for (let i = 0; i < 3; i++) {
		const c = await claimTaskSubscription(f.root, "owner", later(i * 10 + 2));
		assert.ok(c);
		await releaseTaskSubscription(f.root, c.id, "owner", c.delivery.token!, "no receipt", later(i * 10 + 3));
	}
	assert.equal(await claimTaskSubscription(f.root, "owner", later(100)), null);
	assert.equal((await listTaskSubscriptions(f.root, "owner"))[0].delivery.state, "blocked");
});

test("unwatched task retains legacy delivery and running states emit nothing", async (t) => {
	const f = await fixture(t);
	assert.equal(await captureSubscribedTask(f.root, f.terminal), false);
	await f.create();
	assert.equal(await captureSubscribedTask(f.root, f.task), false);
	assert.equal((await listTaskSubscriptions(f.root, "owner"))[0].event, undefined);
});
