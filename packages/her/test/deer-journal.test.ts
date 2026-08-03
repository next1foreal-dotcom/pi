/**
 * G-193 — a deer task's Workflow journal.
 *
 * Fei's ruling: a new task must not replay an old task's answers. Only an
 * explicit re-run may, so the journal is keyed by `resumeFrom` when the brief
 * asks for one and by the task's own id otherwise — and a task's own id is
 * new, so its journal is empty.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { deerJournalDisabled, deerJournalPath } from "../src/her-core/deer-workflow-bridge.ts";

const ROOT = "D:/memory";
const JOURNALS = join(ROOT, ".her", "workflow-journals");

test("G-193-1 an ordinary task journals under its own id, so it replays nothing", () => {
	assert.equal(deerJournalPath(ROOT, "t-20260803-abc123", undefined), join(JOURNALS, "t-20260803-abc123.jsonl"));
});

test("G-193-2 an explicit re-run reads the task it names", () => {
	assert.equal(
		deerJournalPath(ROOT, "t-20260803-newone", "t-20260801-oldone"),
		join(JOURNALS, "t-20260801-oldone.jsonl"),
		"resumeFrom is the only way to reach another run's answers",
	);
});

test("G-193-3 a run with no task id of its own gets no journal", () => {
	assert.equal(
		deerJournalPath(ROOT, undefined, undefined),
		undefined,
		"borrowing a key would let one run replay another's answers",
	);
	assert.equal(deerJournalPath(ROOT, "   ", undefined), undefined);
});

test("G-193-4 the brief names a file, never a path", () => {
	// The brief is written by the model; a key that escapes the journal
	// directory would let it read or append anywhere on disk.
	for (const hostile of ["../../etc/passwd", "a/b", "a\\b", ".hidden", "x".repeat(65)]) {
		assert.equal(
			deerJournalPath(ROOT, "t-20260803-abc123", hostile),
			undefined,
			`refused: ${JSON.stringify(hostile)}`,
		);
	}

	// An empty resumeFrom is not a hostile key, it is no request at all: fall
	// back to this task's own journal rather than refusing to journal.
	assert.equal(deerJournalPath(ROOT, "t-20260803-abc123", ""), join(JOURNALS, "t-20260803-abc123.jsonl"));
});

test("G-193-5 journals never land beside task records", () => {
	const path = deerJournalPath(ROOT, "t-20260803-abc123", undefined);
	assert.ok(path);
	assert.doesNotMatch(
		path,
		/[\\/]\.her[\\/]tasks[\\/]/,
		"a sidecar in .her/tasks broke all three record scanners once already (G-188)",
	);
});

test("G-193-6 HER_DEER_JOURNAL is the explicit way back, and only when asked", () => {
	for (const off of ["0", "false", "off", "no", "OFF", " 0 "]) {
		assert.equal(deerJournalDisabled(off), true, `expected off: ${JSON.stringify(off)}`);
	}
	// Unset, empty, and anything else keep journaling on — a typo in this
	// variable must not quietly turn the feature off.
	for (const on of [undefined, "", "1", "true", "yes", "please"]) {
		assert.equal(deerJournalDisabled(on), false, `expected on: ${JSON.stringify(on)}`);
	}
});
