import assert from "node:assert/strict";
import { test } from "node:test";

import { readChildOutputs } from "./read-results.mjs";
import { groupByRun, quantile, runShape } from "./run-shape.mjs";

test("quantiles say N and refuse the ones N cannot support", () => {
	const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	assert.equal(quantile(ten, 0.5), 5);
	assert.equal(quantile(ten, 1), 10);
	assert.equal(quantile([], 0.5), null);
});

test("peak overlap of a genuinely serial run is 1", () => {
	const kids = [
		{ timestamp: 1_000, durationMs: 1_000 },
		{ timestamp: 2_000, durationMs: 1_000 },
		{ timestamp: 3_000, durationMs: 1_000 },
	];
	const shape = runShape(kids);
	assert.equal(shape.peakOverlap, 1);
	assert.equal(shape.ambiguous, false);
	assert.equal(shape.speedup, 1);
});

test("peak overlap of a fully parallel run is n", () => {
	const kids = [
		{ timestamp: 10_000, durationMs: 9_000 },
		{ timestamp: 10_500, durationMs: 9_500 },
		{ timestamp: 11_000, durationMs: 10_000 },
	];
	const shape = runShape(kids);
	assert.equal(shape.peakOverlap, 3);
	assert.ok(shape.speedup > 2.5, `expected a real speedup, got ${shape.speedup}`);
});

test("when the two readings of `timestamp` disagree, it says ambiguous instead of picking one", () => {
	// pi's meta record does not document whether `timestamp` is the child's start
	// or its finish. Where both readings give the same overlap the number stands;
	// where they diverge, reporting either one is inventing a fact.
	const kids = [
		{ timestamp: 1_000, durationMs: 900 },
		{ timestamp: 1_500, durationMs: 900 },
	];
	const shape = runShape(kids);
	// as-end: [100,1000] and [600,1500] overlap → 2. as-start: [1000,1900] and
	// [1500,2400] overlap → 2. Same; not ambiguous.
	assert.equal(shape.peakOverlap, 2);

	const split = runShape([
		{ timestamp: 1_000, durationMs: 100 },
		{ timestamp: 1_150, durationMs: 400 },
	]);
	// as-end: [900,1000] and [750,1150] overlap → 2. as-start: [1000,1100] and
	// [1150,1550] do not → 1.
	assert.equal(split.ambiguous, true);
	assert.equal(split.peakOverlap, null);
	assert.deepEqual(split.peakOverlapRange, [1, 2]);
});

test("a run with one child is shaped, not divided by zero", () => {
	const shape = runShape([{ timestamp: 5_000, durationMs: 1_000 }]);
	assert.equal(shape.n, 1);
	assert.equal(shape.peakOverlap, 1);
	assert.equal(shape.speedup, 1);
	assert.equal(shape.p95, shape.max, "with N=1 every quantile is the same sample");
});

test("no children is a stated empty, not NaN", () => {
	const shape = runShape([]);
	assert.equal(shape.n, 0);
	assert.equal(shape.peakOverlap, 0);
	assert.equal(shape.speedup, null);
	assert.equal(shape.p50, null);
});

test("the real fan-outs on disk show true 12-way concurrency", () => {
	const all = readChildOutputs(String.raw`D:\@Her\Her-repo\samantha`);
	if (!all.available) {
		console.log(`artifacts dir unavailable (${all.reason}) — shape unverified against real runs`);
		return;
	}
	const runs = groupByRun(all.children);
	const twelves = [...runs.values()].filter((kids) => kids.length === 12);
	if (twelves.length === 0) {
		console.log("no 12-child run on disk here — concurrency claim unverified");
		return;
	}
	for (const kids of twelves) {
		const shape = runShape(kids);
		assert.equal(shape.n, 12);
		assert.equal(shape.ambiguous, false, "both readings of timestamp agree on these runs");
		assert.equal(shape.peakOverlap, 12, "all twelve children overlapped");
		// A 12-way fan-out that actually ran 4 at a time would land near 4.
		assert.ok(shape.speedup > 8, `expected a real fan-out, got ${shape.speedup}x`);
		console.log(
			`run ${shape.runId ?? "?"}: n=${shape.n} peak=${shape.peakOverlap} wall=${(shape.wallMs / 1000).toFixed(1)}s ` +
				`serial=${(shape.serialMs / 1000).toFixed(1)}s speedup=${shape.speedup}x p50=${shape.p50}ms max=${shape.max}ms`,
		);
	}
});
