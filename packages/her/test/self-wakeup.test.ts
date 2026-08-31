/**
 * G-368 — one-shot self-alarm rows under `.her/wakeups/`, fired into the owner inbox.
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/self-wakeup.test.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { runHerCli } from "../src/cli.ts";
import { drainInbox } from "../src/her-core/messages.ts";
import { cancelWakeup, fireDueWakeups, listWakeups, scheduleWakeup } from "../src/her-core/self-wakeup.ts";
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
		["tasks:", "  max_concurrent: 5", "  max_retries: 0", ""].join("\n"),
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
