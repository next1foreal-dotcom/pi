/**
 * G-368 — one-shot self-alarm rows under `.her/wakeups/`, fired into the owner inbox.
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/self-wakeup.test.ts
 */

import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { runHerCli } from "../src/cli.ts";
import { drainInbox } from "../src/her-core/messages.ts";
import {
	cancelWakeup,
	fireDueWakeups,
	listWakeups,
	type SelfStartSpawnFn,
	scheduleWakeup,
} from "../src/her-core/self-wakeup.ts";
import { redactSecrets } from "../src/her-core/store.ts";

const OWNER = "owner-session-1";
const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

async function rootStore(): Promise<string> {
	return mkdtemp(join(tmpdir(), "her-g368-wakeup-"));
}

function isoOffset(ms: number, now = Date.now()): string {
	return new Date(now + ms).toISOString();
}

test("scheduleWakeup accepts a future at and returns {id, at}", async () => {
	const root = await rootStore();
	const at = isoOffset(60_000);
	const result = await scheduleWakeup(root, { at, note: "drink water", ownerSessionId: OWNER });
	assert.ok(result.id);
	assert.match(result.id, /^[A-Za-z0-9._-]+$/);
	assert.equal(result.at, at);
	const listed = await listWakeups(root);
	assert.equal(listed.length, 1);
	assert.equal(listed[0]?.id, result.id);
	assert.equal(listed[0]?.note, "drink water");
	assert.equal(listed[0]?.ownerSessionId, OWNER);
	assert.ok(Number.isFinite(Date.parse(listed[0]?.created ?? "")));
});

test("scheduleWakeup accepts inMinutes and rejects missing at/inMinutes, both, past, and >7 days", async () => {
	const root = await rootStore();
	const set = await scheduleWakeup(root, { inMinutes: 5, note: "later", ownerSessionId: OWNER });
	assert.ok(Date.parse(set.at) > Date.now());
	assert.ok(Date.parse(set.at) <= Date.now() + 6 * 60_000);

	await assert.rejects(() => scheduleWakeup(root, { note: "x", ownerSessionId: OWNER }), /at|inMinutes/);
	await assert.rejects(
		() =>
			scheduleWakeup(root, {
				at: isoOffset(60_000),
				inMinutes: 5,
				note: "x",
				ownerSessionId: OWNER,
			}),
		/at|inMinutes/,
	);
	await assert.rejects(
		() => scheduleWakeup(root, { at: isoOffset(-60_000), note: "x", ownerSessionId: OWNER }),
		/future/i,
	);
	await assert.rejects(
		() => scheduleWakeup(root, { at: isoOffset(8 * 24 * 60 * 60 * 1000), note: "x", ownerSessionId: OWNER }),
		/7 days/,
	);
	await assert.rejects(
		() => scheduleWakeup(root, { at: "not-a-date", note: "x", ownerSessionId: OWNER }),
		/ISO|invalid|parse/i,
	);
});

test("scheduleWakeup requires a note of at most 500 characters and redacts secrets", async () => {
	const root = await rootStore();
	await assert.rejects(() => scheduleWakeup(root, { inMinutes: 1, note: "  ", ownerSessionId: OWNER }), /note/i);
	await assert.rejects(
		() => scheduleWakeup(root, { inMinutes: 1, note: "n".repeat(501), ownerSessionId: OWNER }),
		/500/,
	);
	const at = isoOffset(60_000);
	const result = await scheduleWakeup(root, {
		at,
		note: `remind ${SECRET}`,
		ownerSessionId: OWNER,
	});
	const listed = await listWakeups(root);
	const row = listed.find((item) => item.id === result.id);
	assert.ok(row);
	assert.equal(row.note.includes(SECRET), false);
	assert.equal(row.note, redactSecrets(`remind ${SECRET}`));
});

test("listWakeups returns rows in ascending at order", async () => {
	const root = await rootStore();
	const later = await scheduleWakeup(root, { at: isoOffset(120_000), note: "later", ownerSessionId: OWNER });
	const sooner = await scheduleWakeup(root, { at: isoOffset(30_000), note: "sooner", ownerSessionId: OWNER });
	const listed = await listWakeups(root);
	assert.deepEqual(
		listed.map((row) => row.id),
		[sooner.id, later.id],
	);
});

test("cancelWakeup is idempotent and does not throw when missing", async () => {
	const root = await rootStore();
	assert.deepEqual(await cancelWakeup(root, "missing-id"), { cancelled: false });
	const created = await scheduleWakeup(root, { inMinutes: 3, note: "cancel me", ownerSessionId: OWNER });
	assert.deepEqual(await cancelWakeup(root, created.id), { cancelled: true });
	assert.deepEqual(await cancelWakeup(root, created.id), { cancelled: false });
	assert.equal((await listWakeups(root)).length, 0);
});

test("fireDueWakeups writes an urgent [闹钟] inbox message then deletes the due row", async () => {
	const root = await rootStore();
	const due = await scheduleWakeup(root, { inMinutes: 2, note: "stand up", ownerSessionId: OWNER });
	const pending = await scheduleWakeup(root, { inMinutes: 20, note: "not yet", ownerSessionId: OWNER });
	const now = new Date(Date.parse(due.at) + 1000);
	const result = await fireDueWakeups(root, now);
	assert.deepEqual(result.fired, [due.id]);
	const inbox = await drainInbox(root, OWNER);
	assert.equal(inbox.length, 1);
	assert.equal(inbox[0]?.from, "self-wakeup");
	assert.equal(inbox[0]?.to, OWNER);
	assert.equal(inbox[0]?.urgent, true);
	assert.equal(inbox[0]?.origin, `wakeup-${due.id}`);
	assert.equal(inbox[0]?.body, "[闹钟] stand up");
	assert.equal(inbox[0]?.at, now.toISOString());
	const remaining = await listWakeups(root);
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0]?.id, pending.id);
});

test("fireDueWakeups leaves a not-due row untouched", async () => {
	const root = await rootStore();
	const pending = await scheduleWakeup(root, { inMinutes: 5, note: "soon", ownerSessionId: OWNER });
	assert.deepEqual(await fireDueWakeups(root, new Date()), { fired: [] });
	assert.equal((await listWakeups(root)).length, 1);
	assert.equal((await listWakeups(root))[0]?.id, pending.id);
	assert.deepEqual(await drainInbox(root, OWNER), []);
});

test("fireDueWakeups keeps the row when writeMessage fails", async () => {
	const root = await rootStore();
	const dir = join(root, ".her", "wakeups");
	await mkdir(dir, { recursive: true });
	const id = "w-keep-on-fail";
	const row = {
		id,
		at: "2026-08-31T11:00:00.000Z",
		note: "cannot deliver",
		ownerSessionId: "bad:owner",
		created: "2026-08-31T10:00:00.000Z",
	};
	await writeFile(join(dir, `${id}.json`), `${JSON.stringify(row, null, 2)}\n`, "utf8");
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	};
	try {
		const result = await fireDueWakeups(root, new Date("2026-08-31T12:00:00.000Z"));
		assert.deepEqual(result.fired, []);
	} finally {
		console.warn = originalWarn;
	}
	assert.ok(warnings.some((line) => line.includes(id)));
	const remaining = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as { id: string };
	assert.equal(remaining.id, id);
	assert.equal((await readdir(join(root, "messages")).catch(() => [])).length, 0);
});

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
	const chunks: Buffer[] = [];
	const stream = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			cb();
		},
	});
	return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

test("task-reconcile --json fires due wakeups and reports wakeupsFired", async () => {
	const root = await rootStore();
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(
		join(root, ".her", "config.yaml"),
		["tasks:", "  max_concurrent: 5", "  max_retries: 0", "  alarm_self_start_daily_max: 0", ""].join("\n"),
		"utf8",
	);
	const dir = join(root, ".her", "wakeups");
	await mkdir(dir, { recursive: true });
	const id = "w-cli-due";
	await writeFile(
		join(dir, `${id}.json`),
		`${JSON.stringify(
			{
				id,
				at: "2020-01-01T00:00:00.000Z",
				note: "cli tick",
				ownerSessionId: OWNER,
				created: "2020-01-01T00:00:00.000Z",
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	const stdout = capture();
	const stderr = capture();
	const code = await runHerCli(["task-reconcile", "--json"], { ...process.env, HER_MEMORY_DIR: root }, root, {
		stdout: stdout.stream,
		stderr: stderr.stream,
	});
	assert.equal(code, 0, `expected exit 0, got ${code}; stderr: ${stderr.text()}`);
	const parsed = JSON.parse(stdout.text().trim()) as { events: unknown[]; wakeupsFired: string[] };
	assert.deepEqual(parsed.wakeupsFired, [id]);
	assert.ok(Array.isArray(parsed.events));
	const inbox = await drainInbox(root, OWNER);
	assert.equal(inbox.length, 1);
	assert.equal(inbox[0]?.body, "[闹钟] cli tick");
	assert.equal(inbox[0]?.urgent, true);
	assert.equal((await listWakeups(root)).length, 0);
});

test("Cedar: her_schedule_wakeup is allowed by its named permit and stays denied on heartbeat", async () => {
	const { evaluate, policyEnvelope } = await import("../src/lib/cedar.ts");
	const { governedTools } = await import("../src/extension.ts");
	type AuthorizationCall = Parameters<typeof evaluate>[0];
	assert.equal(governedTools.her_schedule_wakeup?.destructive, true, "wakeup must stay destructive");
	const call = (profile: "default" | "heartbeat"): AuthorizationCall => ({
		principal: { type: "Agent", id: "samantha" },
		action: { type: "Action", id: "CallTool" },
		resource: { type: "Tool", id: "her_schedule_wakeup" },
		context: {},
		entities: [
			{ uid: { type: "Agent", id: "samantha" }, attrs: {}, parents: [] },
			{
				uid: { type: "Tool", id: "her_schedule_wakeup" },
				attrs: { name: "her_schedule_wakeup", destructive: true },
				parents: [],
			},
		],
		...policyEnvelope(profile),
	});
	const attended = evaluate(call("default"));
	assert.equal(attended.decision, "allow");
	assert.deepEqual(attended.matched, ["permit_her_schedule_wakeup"]);
	const unattended = evaluate(call("heartbeat"));
	assert.equal(unattended.decision, "deny");
	assert.deepEqual(unattended.matched, ["heartbeat_forbid_destructive_tools"]);
});

const SELF_START_PROMPT = "闹钟自启回合:读你的收件箱与唤醒信息,按技能行事;本回合不 spawn 新后台任务的规矩照旧。";
const NOW = new Date("2026-08-31T15:00:00.000Z");
const CODE_ROOT = join(tmpdir(), "her-g374-code-root");

type SelfStartRow = {
	at: string;
	wakeupIds: string[];
	sessionId: string;
	pid: number | null;
	status: "launched" | "skipped";
	reason?: string;
};

type SelfStartSpawnCall = {
	command: string;
	args: string[];
	opts: SpawnOptions;
	unrefed: boolean;
};

function firedRow(
	overrides: Partial<{
		id: string;
		at: string;
		note: string;
		ownerSessionId: string;
		created: string;
		sessionDir: string;
	}> = {},
) {
	return {
		id: "w-g374-1",
		at: "2026-08-31T14:00:00.000Z",
		note: "stand up",
		ownerSessionId: OWNER,
		created: "2026-08-31T13:00:00.000Z",
		...overrides,
	};
}

async function loadSelfStart() {
	return import("../src/her-core/self-wakeup.ts");
}

async function loadTasksConfig() {
	return import("../src/her-core/bg-task-config.ts");
}

function stubSpawn(calls: SelfStartSpawnCall[], pid = 4242): SelfStartSpawnFn {
	return (command, args, opts) => {
		const call: SelfStartSpawnCall = { command, args: [...args], opts, unrefed: false };
		calls.push(call);
		return {
			pid,
			unref() {
				call.unrefed = true;
			},
		};
	};
}

async function readLedger(root: string): Promise<SelfStartRow[]> {
	const text = await readFile(join(root, ".her", "wakeups", "self-start-ledger.jsonl"), "utf8").catch(() => "");
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as SelfStartRow);
}

async function seedLedger(root: string, rows: SelfStartRow[]): Promise<void> {
	const dir = join(root, ".her", "wakeups");
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "self-start-ledger.jsonl"),
		rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
		"utf8",
	);
}

test("G-374: alarm_self_start_daily_max defaults to 6 and 0 disables; G-373 knobs stay", async () => {
	const { DEFAULT_TASKS_CONFIG, loadRuntimeConfig } = await loadTasksConfig();
	assert.equal(DEFAULT_TASKS_CONFIG.alarmSelfStartDailyMax, 6);
	assert.equal(DEFAULT_TASKS_CONFIG.messageWakeMinBatch, 3);
	assert.equal(DEFAULT_TASKS_CONFIG.messageWakeMaxAgeMinutes, 30);

	const setRoot = await rootStore();
	await mkdir(join(setRoot, ".her"), { recursive: true });
	await writeFile(
		join(setRoot, ".her", "config.yaml"),
		[
			"tasks:",
			"  alarm_self_start_daily_max: 0",
			"  message_wake_min_batch: 1",
			"  message_wake_max_age_minutes: 5",
			"",
		].join("\n"),
		"utf8",
	);
	const set = loadRuntimeConfig(setRoot);
	assert.equal(set.tasks.alarmSelfStartDailyMax, 0);
	assert.equal(set.tasks.messageWakeMinBatch, 1);
	assert.equal(set.tasks.messageWakeMaxAgeMinutes, 5);
});

test("G-374: scheduleWakeup stores optional sessionDir", async () => {
	const root = await rootStore();
	const at = isoOffset(60_000);
	const sessionDir = join(root, "sessions");
	const result = await scheduleWakeup(root, {
		at,
		note: "with dir",
		ownerSessionId: OWNER,
		sessionDir,
	});
	const listed = await listWakeups(root);
	const row = listed.find((item) => item.id === result.id);
	assert.ok(row);
	assert.equal(row.sessionDir, sessionDir);
});

test("G-374: 7th launch in UTC day is skipped:daily_cap and does not spawn", async () => {
	const { selfStartForFiredWakeups } = await loadSelfStart();
	const { DEFAULT_TASKS_CONFIG } = await loadTasksConfig();
	const root = await rootStore();
	const today = NOW.toISOString();
	await seedLedger(
		root,
		Array.from({ length: 6 }, (_, i) => ({
			at: `2026-08-31T1${i}:00:00.000Z`,
			wakeupIds: [`w-prior-${i}`],
			sessionId: OWNER,
			pid: 1000 + i,
			status: "launched" as const,
		})),
	);
	const calls: SelfStartSpawnCall[] = [];
	const result = await selfStartForFiredWakeups(
		root,
		[firedRow()],
		{ ...DEFAULT_TASKS_CONFIG, alarmSelfStartDailyMax: 6 },
		{
			now: NOW,
			spawn: stubSpawn(calls),
			pidAlive: () => false,
			codeRoot: CODE_ROOT,
		},
	);
	assert.equal(result.status, "skipped");
	assert.equal(result.reason, "daily_cap");
	assert.equal(result.pid, null);
	assert.deepEqual(result.wakeupIds, ["w-g374-1"]);
	assert.equal(result.sessionId, OWNER);
	assert.equal(result.at, today);
	assert.equal(calls.length, 0);
	const ledger = await readLedger(root);
	assert.equal(ledger.length, 7);
	const last = ledger[6];
	assert.equal(last?.status, "skipped");
	assert.equal(last?.reason, "daily_cap");
	assert.deepEqual(last?.wakeupIds, ["w-g374-1"]);
	assert.equal(last?.sessionId, OWNER);
	assert.equal(last?.pid, null);
	assert.equal(last?.at, today);
});

test("G-374: in-flight live pid skips with in_flight and does not spawn", async () => {
	const { selfStartForFiredWakeups } = await loadSelfStart();
	const { DEFAULT_TASKS_CONFIG } = await loadTasksConfig();
	const root = await rootStore();
	await seedLedger(root, [
		{
			at: "2026-08-31T14:00:00.000Z",
			wakeupIds: ["w-live"],
			sessionId: OWNER,
			pid: 99999,
			status: "launched",
		},
	]);
	const calls: SelfStartSpawnCall[] = [];
	const result = await selfStartForFiredWakeups(
		root,
		[firedRow()],
		{ ...DEFAULT_TASKS_CONFIG, alarmSelfStartDailyMax: 6 },
		{
			now: NOW,
			spawn: stubSpawn(calls),
			pidAlive: (pid) => pid === 99999,
			codeRoot: CODE_ROOT,
		},
	);
	assert.equal(result.status, "skipped");
	assert.equal(result.reason, "in_flight");
	assert.equal(result.pid, null);
	assert.equal(calls.length, 0);
	const ledger = await readLedger(root);
	assert.equal(ledger.at(-1)?.status, "skipped");
	assert.equal(ledger.at(-1)?.reason, "in_flight");
	assert.equal(ledger.at(-1)?.pid, null);
});

test("G-374: ledger row shape and spawn argv pin session-id + deepseek", async () => {
	const { selfStartForFiredWakeups } = await loadSelfStart();
	const { DEFAULT_TASKS_CONFIG } = await loadTasksConfig();
	const root = await rootStore();
	const sessionDir = join(root, "owner-sessions");
	const calls: SelfStartSpawnCall[] = [];
	const result = await selfStartForFiredWakeups(
		root,
		[firedRow({ sessionDir }), firedRow({ id: "w-g374-2" })],
		{ ...DEFAULT_TASKS_CONFIG, alarmSelfStartDailyMax: 6 },
		{
			now: NOW,
			spawn: stubSpawn(calls, 4242),
			pidAlive: () => false,
			codeRoot: CODE_ROOT,
		},
	);
	assert.equal(result.status, "launched");
	assert.equal(result.pid, 4242);
	assert.equal(result.sessionId, OWNER);
	assert.deepEqual(result.wakeupIds, ["w-g374-1", "w-g374-2"]);
	assert.equal(result.at, NOW.toISOString());
	assert.equal(result.reason, undefined);
	assert.equal(calls.length, 1);
	const call = calls[0];
	assert.ok(call);
	assert.equal(call.command, process.execPath);
	assert.equal(call.args[0], join(CODE_ROOT, "packages", "coding-agent", "dist", "cli.js"));
	assert.equal(call.args[1], "-p");
	assert.equal(call.args[2], "--mode");
	assert.equal(call.args[3], "text");
	assert.equal(call.args[4], "--session-id");
	assert.equal(call.args[5], OWNER);
	assert.equal(call.args[6], "--session-dir");
	assert.equal(call.args[7], sessionDir);
	assert.equal(call.args[8], "--provider");
	assert.equal(call.args[9], "deepseek");
	assert.equal(call.args[10], "--model");
	assert.equal(call.args[11], "deepseek-v4-flash");
	assert.equal(call.args[12], SELF_START_PROMPT);
	assert.equal(call.opts.cwd, CODE_ROOT);
	assert.equal(call.opts.detached, true);
	assert.equal(call.unrefed, true);
	const ledger = await readLedger(root);
	assert.equal(ledger.length, 1);
	assert.deepEqual(ledger[0], {
		at: NOW.toISOString(),
		wakeupIds: ["w-g374-1", "w-g374-2"],
		sessionId: OWNER,
		pid: 4242,
		status: "launched",
	});
	const logName = `${NOW.toISOString().replace(/[:.]/g, "-")}.selfstart.log`;
	const logText = await readFile(join(root, ".her", "wakeups", logName), "utf8").catch(() => null);
	assert.equal(typeof logText, "string");
});

test("G-374: alarmSelfStartDailyMax 0 skips as disabled and does not spawn", async () => {
	const { selfStartForFiredWakeups } = await loadSelfStart();
	const { DEFAULT_TASKS_CONFIG } = await loadTasksConfig();
	const root = await rootStore();
	const calls: SelfStartSpawnCall[] = [];
	const result = await selfStartForFiredWakeups(
		root,
		[firedRow()],
		{ ...DEFAULT_TASKS_CONFIG, alarmSelfStartDailyMax: 0 },
		{
			now: NOW,
			spawn: stubSpawn(calls),
			pidAlive: () => false,
			codeRoot: CODE_ROOT,
		},
	);
	assert.equal(result.status, "skipped");
	assert.equal(result.reason, "disabled");
	assert.equal(result.pid, null);
	assert.equal(calls.length, 0);
	const ledger = await readLedger(root);
	assert.equal(ledger.length, 1);
	assert.equal(ledger[0]?.status, "skipped");
	assert.equal(ledger[0]?.reason, "disabled");
});

test("G-374: task-reconcile --json includes selfStart when a due wakeup fires", async () => {
	const root = await rootStore();
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(
		join(root, ".her", "config.yaml"),
		["tasks:", "  max_concurrent: 5", "  max_retries: 0", "  alarm_self_start_daily_max: 0", ""].join("\n"),
		"utf8",
	);
	const dir = join(root, ".her", "wakeups");
	await mkdir(dir, { recursive: true });
	const id = "w-cli-selfstart";
	await writeFile(
		join(dir, `${id}.json`),
		`${JSON.stringify(
			{
				id,
				at: "2020-01-01T00:00:00.000Z",
				note: "cli self-start",
				ownerSessionId: OWNER,
				created: "2020-01-01T00:00:00.000Z",
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	const stdout = capture();
	const stderr = capture();
	const code = await runHerCli(["task-reconcile", "--json"], { ...process.env, HER_MEMORY_DIR: root }, root, {
		stdout: stdout.stream,
		stderr: stderr.stream,
	});
	assert.equal(code, 0, `expected exit 0, got ${code}; stderr: ${stderr.text()}`);
	const parsed = JSON.parse(stdout.text().trim()) as {
		wakeupsFired: string[];
		selfStart?: SelfStartRow;
	};
	assert.deepEqual(parsed.wakeupsFired, [id]);
	assert.equal(parsed.selfStart?.status, "skipped");
	assert.equal(parsed.selfStart?.reason, "disabled");
	assert.deepEqual(parsed.selfStart?.wakeupIds, [id]);
	assert.equal(parsed.selfStart?.sessionId, OWNER);
	assert.equal(parsed.selfStart?.pid, null);
});
