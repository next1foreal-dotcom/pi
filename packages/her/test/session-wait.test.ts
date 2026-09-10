import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type BgTaskRecord, saveBgTask } from "../src/her-core/bg-task-record.ts";
import { writeMessage } from "../src/her-core/messages.ts";
import { SESSION_WAIT_REFUSAL, sessionWait, sessionWaitBlocked } from "../src/her-core/session-wait.ts";

const SELF = "pi-self-0001";
const PEER = "pi-peer-0001";
const LEAK = "UNIQUE-LEAK-STRING-G448-BODY";
const NOW = "2026-09-10T12:00:00.000Z";

async function rootStore(): Promise<string> {
	return mkdtemp(join(tmpdir(), "her-g448-session-wait-"));
}

function taskRecord(over: Partial<BgTaskRecord> & { id: string }): BgTaskRecord {
	const { id, ...rest } = over;
	return {
		status: "pending",
		objective: id,
		worker: "node",
		command: ["node", "-e", "0"],
		created: NOW,
		updated: NOW,
		retries: 0,
		host: "test",
		...rest,
		id,
	};
}

function fakeClock(start = 0): { now: () => number; sleep: (ms: number) => Promise<void>; elapsed: () => number } {
	let t = start;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		elapsed: () => t - start,
	};
}

test("session wait returns the session target as kind=message when a new inbox file arrives", async () => {
	const root = await rootStore();
	const clock = fakeClock();
	const result = await sessionWait({
		root,
		selfId: SELF,
		targets: [{ kind: "session", id: PEER }],
		timeoutMs: 5_000,
		now: clock.now,
		sleep: async (ms) => {
			await writeMessage(root, {
				from: PEER,
				to: SELF,
				at: NOW,
				urgent: false,
				origin: "g448",
				hop: 0,
				body: "hello from peer",
			});
			clock.sleep(ms);
		},
	});
	assert.equal(result.status, "ready");
	if (result.status !== "ready") return;
	assert.equal(result.kind, "message");
	assert.equal(result.target.kind, "session");
	assert.equal(result.target.id, PEER);
});

test("session wait returns the task target as kind=task when it becomes terminal", async () => {
	const root = await rootStore();
	const id = "t-g448-wait";
	await saveBgTask(root, taskRecord({ id, status: "running" }), "# running\n");
	const clock = fakeClock();
	const result = await sessionWait({
		root,
		selfId: SELF,
		targets: [{ kind: "task", id }],
		timeoutMs: 5_000,
		now: clock.now,
		sleep: async (ms) => {
			await saveBgTask(root, taskRecord({ id, status: "completed" }), "# done\n");
			clock.sleep(ms);
		},
	});
	assert.equal(result.status, "ready");
	if (result.status !== "ready") return;
	assert.equal(result.kind, "task");
	assert.equal(result.target.kind, "task");
	assert.equal(result.target.id, id);
});

test("timeout_ms:0 with no activity returns timeout and does not block", async () => {
	const root = await rootStore();
	const wall0 = Date.now();
	const result = await sessionWait({
		root,
		selfId: SELF,
		targets: [{ kind: "session", id: PEER }],
		timeoutMs: 0,
	});
	const wall = Date.now() - wall0;
	assert.equal(result.status, "timeout");
	if (result.status !== "timeout") return;
	assert.ok(Array.isArray(result.targets));
	assert.equal(result.targets.length, 1);
	assert.ok(wall < 500, `timeout_ms:0 blocked for ${wall}ms`);
});

test("timeout with no activity stays near the timeout threshold", async () => {
	const root = await rootStore();
	const timeoutMs = 80;
	const clock = fakeClock();
	const result = await sessionWait({
		root,
		selfId: SELF,
		targets: [{ kind: "session", id: PEER }],
		timeoutMs,
		now: clock.now,
		sleep: clock.sleep,
	});
	assert.equal(result.status, "timeout");
	if (result.status !== "timeout") return;
	assert.ok(result.elapsedMs >= timeoutMs, `elapsed ${result.elapsedMs} < timeout ${timeoutMs}`);
	assert.ok(result.elapsedMs < timeoutMs * 2, `elapsed ${result.elapsedMs} >= timeout*2 ${timeoutMs * 2}`);
});

test("wait result never includes the inbox message body", async () => {
	const root = await rootStore();
	const clock = fakeClock();
	const result = await sessionWait({
		root,
		selfId: SELF,
		targets: [{ kind: "session", id: PEER }],
		timeoutMs: 5_000,
		now: clock.now,
		sleep: async (ms) => {
			await writeMessage(root, {
				from: PEER,
				to: SELF,
				at: NOW,
				urgent: false,
				origin: "g448-leak",
				hop: 0,
				body: LEAK,
			});
			clock.sleep(ms);
		},
	});
	assert.equal(result.status, "ready");
	const dumped = JSON.stringify(result);
	assert.equal(dumped.includes(LEAK), false, dumped);
});

test("wake turn refuses session wait; a normal turn does not", async () => {
	const root = await rootStore();
	const refused = await sessionWait({
		root,
		selfId: SELF,
		targets: [{ kind: "session", id: PEER }],
		timeoutMs: 0,
		wakeTurnActive: true,
	});
	assert.equal(refused.status, "refused");
	if (refused.status !== "refused") return;
	assert.equal(refused.reason, SESSION_WAIT_REFUSAL);

	const normal = await sessionWait({
		root,
		selfId: SELF,
		targets: [{ kind: "session", id: PEER }],
		timeoutMs: 0,
		wakeTurnActive: false,
	});
	assert.notEqual(normal.status, "refused");
	assert.equal(sessionWaitBlocked(true, false), true);
	assert.equal(sessionWaitBlocked(false, true), true);
	assert.equal(sessionWaitBlocked(false, false), false);

	const heartbeat = await sessionWait({
		root,
		selfId: SELF,
		targets: [{ kind: "session", id: PEER }],
		timeoutMs: 0,
		heartbeat: true,
	});
	assert.equal(heartbeat.status, "refused");
});

test("targets of 0 or 9 are rejected", async () => {
	const root = await rootStore();
	await assert.rejects(
		() =>
			sessionWait({
				root,
				selfId: SELF,
				targets: [],
				timeoutMs: 0,
			}),
		/1 to 8|targets/i,
	);
	const nine = Array.from({ length: 9 }, (_, i) => ({ kind: "session" as const, id: `s${i}` }));
	await assert.rejects(
		() =>
			sessionWait({
				root,
				selfId: SELF,
				targets: nine,
				timeoutMs: 0,
			}),
		/1 to 8|targets/i,
	);
});
