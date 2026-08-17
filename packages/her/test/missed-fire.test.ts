import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { promisify } from "node:util";
import { readEventHistory } from "../src/her-core/event-history.ts";
import { FakeModel, initStore, Memory, readJson, readText, writeJson, writeText } from "../src/her-core/index.ts";
import {
	computeMissedFire,
	MISSED_FIRE_GRACE_MS,
	MISSED_FIRE_MAX_CATCHUP,
	type MissedFirePolicy,
	parseCadenceTimestamp,
} from "../src/her-core/missed-fire.ts";

const execFileAsync = promisify(execFile);
const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const POLICIES: MissedFirePolicy[] = ["skip", "once", "all"];

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g269-"));
	await initStore(root);
	return root;
}

async function gitInit(store: string): Promise<void> {
	await execFileAsync("git", ["init"], { cwd: store });
	await execFileAsync("git", ["config", "user.name", "Her G269 Test"], { cwd: store });
	await execFileAsync("git", ["config", "user.email", "her-g269-test@example.com"], { cwd: store });
	await execFileAsync("git", ["add", "-A"], { cwd: store });
	await execFileAsync("git", ["commit", "-m", "memory: init"], { cwd: store });
}

function fire(
	policy: MissedFirePolicy,
	lastRunMs: number,
	lastDueCheckMs: number | undefined,
	nowMs = NOW,
	intervalDays = 1,
) {
	return computeMissedFire({ lastRunMs, lastDueCheckMs, nowMs, intervalDays, policy });
}

function warnTexts(warnings: ReturnType<typeof mock.method>): string[] {
	return warnings.mock.calls.map((call) => String(call.arguments[0] ?? ""));
}

test("G=0: any policy is not due", () => {
	const lastRunMs = NOW - 10 * 60_000;
	for (const policy of POLICIES) {
		const result = fire(policy, lastRunMs, NOW - 40 * 60_000);
		assert.equal(result.due, false, policy);
		assert.equal(result.owed, 0, policy);
		assert.equal(result.missed, 0, policy);
		assert.equal(result.advanceAnchorTo, undefined, policy);
	}
});

test("downtime 2.5 intervals: once=1, skip voids, all spreads across ticks, missed=2", () => {
	const lastRunMs = NOW - 2.5 * DAY_MS;
	const lastDueCheckMs = lastRunMs;
	const once = fire("once", lastRunMs, lastDueCheckMs);
	assert.equal(once.due, true);
	assert.equal(once.owed, 1);
	assert.equal(once.missed, 2);

	const skip = fire("skip", lastRunMs, lastDueCheckMs);
	assert.equal(skip.due, false);
	assert.equal(skip.owed, 0);
	assert.equal(skip.missed, 2);
	assert.equal(skip.advanceAnchorTo, new Date(lastRunMs + 2 * DAY_MS).toISOString());

	const allFirst = fire("all", lastRunMs, lastDueCheckMs);
	assert.equal(allFirst.due, true);
	assert.equal(allFirst.owed, 1);
	assert.equal(allFirst.missed, 2);

	const allSecond = fire("all", lastRunMs + DAY_MS, NOW);
	assert.equal(allSecond.due, true);
	assert.equal(allSecond.owed, 1);

	const allCleared = fire("all", lastRunMs + 2 * DAY_MS, NOW);
	assert.equal(allCleared.due, false);
	assert.equal(allCleared.owed, 0);
});

test("GRACE protects a live shift 10 minutes past the grid for every policy", () => {
	const lastRunMs = NOW - DAY_MS - 10 * 60_000;
	const lastDueCheckMs = NOW - 40 * 60_000;
	for (const policy of POLICIES) {
		const result = fire(policy, lastRunMs, lastDueCheckMs);
		assert.equal(result.due, true, policy);
		assert.equal(result.owed, 1, policy);
		assert.equal(result.missed, 0, policy);
		assert.equal(result.advanceAnchorTo, undefined, policy);
	}
});

test("policy=all with G=8: owed=1, missed=8, cap log at 5", () => {
	const lastRunMs = NOW - 8 * DAY_MS - 3 * 60 * 60 * 1000;
	const warnings = mock.method(console, "warn");
	try {
		const result = fire("all", lastRunMs, lastRunMs);
		assert.equal(result.due, true);
		assert.equal(result.owed, 1);
		assert.equal(result.missed, 8);
		assert.ok(
			warnTexts(warnings).some((text) => text.includes(String(MISSED_FIRE_MAX_CATCHUP)) && text.includes("8")),
		);
	} finally {
		warnings.mock.restore();
	}
});

test("date-only lastRun parses as 00:00 UTC; missing lastDueCheck does not crash", () => {
	assert.equal(parseCadenceTimestamp("2026-08-09"), Date.parse("2026-08-09T00:00:00.000Z"));
	const lastRunMs = parseCadenceTimestamp("2026-08-01");
	assert.ok(lastRunMs !== undefined);
	const result = computeMissedFire({
		lastRunMs,
		lastDueCheckMs: undefined,
		nowMs: NOW,
		intervalDays: 1,
		policy: "once",
	});
	assert.equal(result.due, true);
	assert.equal(result.owed, 1);
	assert.equal(result.missed, Math.max(result.missed, 0));
	assert.ok(result.missed >= 0);
});

test("skip void then immediate recheck is not due; next grid is due", () => {
	const lastRunMs = NOW - 2.5 * DAY_MS;
	const skip = fire("skip", lastRunMs, lastRunMs);
	assert.ok(skip.advanceAnchorTo);
	const advancedMs = Date.parse(skip.advanceAnchorTo ?? "");
	const immediate = fire("skip", advancedMs, NOW);
	assert.equal(immediate.due, false);
	const laterNow = advancedMs + DAY_MS + 10 * 60_000;
	const later = fire("skip", advancedMs, NOW, laterNow);
	assert.equal(later.due, true);
	assert.equal(later.owed, 1);
});

test("now < lastRun clamps G=0, warns, and leaks no negative owed", () => {
	const warnings = mock.method(console, "warn");
	try {
		const result = fire("all", NOW + DAY_MS, NOW - DAY_MS);
		assert.equal(result.due, false);
		assert.equal(result.owed, 0);
		assert.equal(result.missed, 0);
		assert.ok(result.owed >= 0 && result.missed >= 0);
		assert.ok(warnTexts(warnings).some((text) => /clock|back/i.test(text)));
	} finally {
		warnings.mock.restore();
	}
});

test("G=0 persist last_due_check after the decision", async () => {
	const store = await tempStore();
	const last = new Date(Date.now() - 10 * 60_000).toISOString();
	await writeJson(join(store, ".her", "state.json"), {
		last_synthesize: last,
		last_reflect: last,
	});
	const due = await new Memory(store).synthesizeDue();
	assert.equal(due.due, false);
	assert.equal(due.owed, 0);
	const state = await readJson<{ last_due_check_synthesize?: string }>(join(store, ".her", "state.json"), {});
	assert.ok(state.last_due_check_synthesize);
	assert.ok(!Number.isNaN(Date.parse(state.last_due_check_synthesize)));
});

test("stale 2.5 intervals through Memory: once/skip/all plus skip ledger", async () => {
	const store = await tempStore();
	await gitInit(store);
	const lastRun = new Date(Date.now() - 2.5 * DAY_MS).toISOString();
	await writeText(
		join(store, ".her", "config.yaml"),
		["cadence:", "  synthesize_stale_after_days: 1", "  missed_fire_synthesize: once", ""].join("\n"),
	);
	await writeJson(join(store, ".her", "state.json"), {
		last_synthesize: lastRun,
		last_due_check_synthesize: lastRun,
	});
	const once = await new Memory(store).synthesizeDue();
	assert.equal(once.due, true);
	assert.equal(once.reason, "stale");
	assert.equal(once.owed, 1);
	assert.equal(once.missed, 2);
	assert.equal(once.policy, "once");
	await new Memory(store, new FakeModel("# CONTEXT\n\nCaught up once.\n")).synthesize();
	const onceAgain = await new Memory(store).synthesizeDue();
	assert.equal(onceAgain.due, false);

	await writeText(
		join(store, ".her", "config.yaml"),
		["cadence:", "  synthesize_stale_after_days: 1", "  missed_fire_synthesize: skip", ""].join("\n"),
	);
	await writeJson(join(store, ".her", "state.json"), {
		last_synthesize: lastRun,
		last_due_check_synthesize: lastRun,
	});
	const skip = await new Memory(store).synthesizeDue();
	assert.equal(skip.due, false);
	assert.equal(skip.owed, 0);
	assert.equal(skip.missed, 2);
	const skipLedger = (await readText(join(store, "audit", "organ-skips.jsonl"))) ?? "";
	assert.match(skipLedger, /missed-fire-skip/);
	assert.match(skipLedger, /"voided":2/);
	const skipped = await readJson<{ last_synthesize?: string }>(join(store, ".her", "state.json"), {});
	assert.ok(skipped.last_synthesize);
	assert.notEqual(skipped.last_synthesize, lastRun);
	const skipAgain = await new Memory(store).synthesizeDue();
	assert.equal(skipAgain.due, false);

	await writeText(
		join(store, ".her", "config.yaml"),
		["cadence:", "  synthesize_stale_after_days: 1", "  missed_fire_synthesize: all", ""].join("\n"),
	);
	await writeJson(join(store, ".her", "state.json"), {
		last_synthesize: lastRun,
		last_due_check_synthesize: lastRun,
	});
	const allFirst = await new Memory(store).synthesizeDue();
	assert.equal(allFirst.due, true);
	assert.equal(allFirst.owed, 1);
	assert.equal(allFirst.missed, 2);
	await new Memory(store, new FakeModel("# CONTEXT\n\nCatch up tick one.\n")).synthesize();
	const allSecond = await new Memory(store).synthesizeDue();
	assert.equal(allSecond.due, true);
	assert.equal(allSecond.owed, 1);
	await new Memory(store, new FakeModel("# CONTEXT\n\nCatch up tick two.\n")).synthesize();
	const allDone = await new Memory(store).synthesizeDue();
	assert.equal(allDone.due, false);
});

test("invalid missed_fire_reflect warns and falls back to once", async () => {
	const store = await tempStore();
	const lastRun = new Date(Date.now() - 2.5 * DAY_MS).toISOString();
	await writeText(join(store, ".her", "config.yaml"), "cadence:\n  missed_fire_reflect: banana\n");
	await writeJson(join(store, ".her", "state.json"), {
		last_reflect: lastRun,
		last_due_check_reflect: lastRun,
	});
	const warnings = mock.method(console, "warn");
	try {
		const result = await new Memory(store, new FakeModel("NONE")).reflect({ ifDue: true });
		assert.equal(result.ran, true);
		assert.equal(result.due, true);
		assert.equal(result.policy, "once");
		assert.ok(warnTexts(warnings).some((text) => /banana/.test(text) && /once/.test(text)));
	} finally {
		warnings.mock.restore();
	}
});

test("legacy date-only last_synthesize still stale-due under once", async () => {
	const store = await tempStore();
	await writeText(join(store, ".her", "config.yaml"), ["cadence:", "  synthesize_stale_after_days: 1", ""].join("\n"));
	await writeJson(join(store, ".her", "state.json"), { last_synthesize: "2000-01-01" });
	const due = await new Memory(store).synthesizeDue();
	assert.equal(due.due, true);
	assert.equal(due.reason, "stale");
	assert.equal(due.policy, "once");
	assert.equal(due.owed, 1);
});

test("synthesizeDue conflict and new_notes ignore missed-fire skip", async () => {
	const store = await tempStore();
	const recent = new Date(Date.now() - 60_000).toISOString();
	await writeText(
		join(store, ".her", "config.yaml"),
		["cadence:", "  synthesize_after_new_notes: 1", "  missed_fire_synthesize: skip", ""].join("\n"),
	);
	await writeJson(join(store, ".her", "state.json"), {
		last_synthesize: recent,
		last_due_check_synthesize: recent,
	});
	await writeText(
		join(store, "semantic", "challenge.md"),
		'---\nupdated: 2099-01-01\nrelations:\n  - {"to":"old-belief","rel":"challenges"}\n---\n# Challenge\n\nConflict note.\n',
	);
	const conflict = await new Memory(store).synthesizeDue();
	assert.equal(conflict.due, true);
	assert.equal(conflict.reason, "conflict");
	assert.equal(conflict.owed, undefined);
	assert.equal(conflict.missed, undefined);

	const notesStore = await tempStore();
	const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS).toISOString().slice(0, 10);
	const oneDayAgo = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
	await writeText(
		join(notesStore, ".her", "config.yaml"),
		["cadence:", "  synthesize_after_new_notes: 1", "  missed_fire_synthesize: skip", ""].join("\n"),
	);
	await writeJson(join(notesStore, ".her", "state.json"), { last_synthesize: twoDaysAgo });
	await writeText(
		join(notesStore, "semantic", "one.md"),
		`---\nupdated: ${oneDayAgo}\n---\n# One\n\nNew semantic note.\n`,
	);
	const notes = await new Memory(notesStore).synthesizeDue();
	assert.equal(notes.due, true);
	assert.equal(notes.reason, "new_notes");
	assert.equal(notes.owed, undefined);
});

test("missed>0 appends organ.cadence.missed; skip void also appends organ.cadence.voided", async () => {
	const store = await tempStore();
	const lastRun = new Date(Date.now() - 2.5 * DAY_MS).toISOString();
	await writeText(
		join(store, ".her", "config.yaml"),
		["cadence:", "  synthesize_stale_after_days: 1", "  missed_fire_synthesize: skip", ""].join("\n"),
	);
	await writeJson(join(store, ".her", "state.json"), {
		last_synthesize: lastRun,
		last_due_check_synthesize: lastRun,
	});
	await new Memory(store).synthesizeDue();
	const { events } = await readEventHistory(store);
	const missed = events.filter((event) => event.kind === "organ.cadence.missed");
	const voided = events.filter((event) => event.kind === "organ.cadence.voided");
	assert.equal(missed.length, 1);
	assert.equal(missed[0]?.actor, "synthesize");
	assert.equal((missed[0]?.data as { missed?: number }).missed, 2);
	assert.equal((missed[0]?.data as { policy?: string }).policy, "skip");
	assert.equal(voided.length, 1);
	assert.equal(voided[0]?.actor, "synthesize");
});

test("GRACE constant is 2 hours", () => {
	assert.equal(MISSED_FIRE_GRACE_MS, 2 * 60 * 60 * 1000);
});
