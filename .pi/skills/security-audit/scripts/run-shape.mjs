/**
 * What a fan-out actually did, as opposed to what it was asked to do.
 *
 * The run report has to state ACTUAL concurrency. Requesting `concurrency: 12`
 * and getting 4 is the default failure here — the extension falls back to 4 when
 * the call omits the field — and the only difference visible from the parent's
 * side is that the turn took longer. Nobody notices a slow turn.
 *
 * Peak overlap is computed from the children's own meta records. pi does not
 * document whether `timestamp` is a child's start or its finish, so both
 * readings are computed: where they agree the number stands, where they diverge
 * the result says `ambiguous` and carries the range instead of picking one.
 *
 * Durations get p50/p95/max with N stated, never a bare mean — a mean hides the
 * one child that took four times as long as the rest, and that child is the one
 * that set the wall clock.
 *
 * Upstream protocol: Cloudflare security-audit skill (MIT) — see ../LICENSE.
 */

/** Group child records by the fan-out they belong to. */
export function groupByRun(children) {
	const runs = new Map();
	for (const child of children) {
		const list = runs.get(child.runId);
		if (list) list.push(child);
		else runs.set(child.runId, [child]);
	}
	return runs;
}

/** Nearest-rank quantile. Returns null for an empty sample rather than NaN. */
export function quantile(values, q) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil(q * sorted.length));
	return sorted[rank - 1];
}

function peakOverlap(intervals) {
	const events = [];
	for (const [start, end] of intervals) {
		events.push([start, 1]);
		events.push([end, -1]);
	}
	// Ends before starts at the same instant: two children that merely touch are
	// not concurrent.
	events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let current = 0;
	let max = 0;
	for (const [, delta] of events) {
		current += delta;
		if (current > max) max = current;
	}
	return max;
}

export function runShape(children) {
	const n = children.length;
	if (n === 0) {
		return {
			n: 0,
			peakOverlap: 0,
			ambiguous: false,
			wallMs: 0,
			serialMs: 0,
			speedup: null,
			p50: null,
			p95: null,
			max: null,
		};
	}

	const durations = children.map((c) => c.durationMs ?? 0);
	const asEnd = children.map((c) => [(c.timestamp ?? 0) - (c.durationMs ?? 0), c.timestamp ?? 0]);
	const asStart = children.map((c) => [c.timestamp ?? 0, (c.timestamp ?? 0) + (c.durationMs ?? 0)]);

	const overlapEnd = peakOverlap(asEnd);
	const overlapStart = peakOverlap(asStart);
	const ambiguous = overlapEnd !== overlapStart;

	// The wall clock is read off the same intervals; with `timestamp` as finish
	// this is the span from the first child starting to the last one finishing.
	const wallMs = Math.max(...asEnd.map((i) => i[1])) - Math.min(...asEnd.map((i) => i[0]));
	const serialMs = durations.reduce((a, b) => a + b, 0);

	return {
		runId: children[0]?.runId,
		n,
		peakOverlap: ambiguous ? null : overlapEnd,
		peakOverlapRange: [Math.min(overlapEnd, overlapStart), Math.max(overlapEnd, overlapStart)],
		ambiguous,
		wallMs,
		serialMs,
		speedup: wallMs > 0 ? Number((serialMs / wallMs).toFixed(2)) : 1,
		p50: quantile(durations, 0.5),
		// With a dozen children p95 is one or two samples. Reported with N so a
		// reader can see how much it is worth; no p99 is offered at all, because
		// at this N it would be the maximum wearing a different name.
		p95: quantile(durations, 0.95),
		max: quantile(durations, 1),
		exitNonZero: children.filter((c) => c.exitCode !== 0).length,
		missingOutput: children.filter((c) => c.output === null).length,
	};
}

const invokedDirectly =
	process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) {
	const { readChildOutputs } = await import("./read-results.mjs");
	const [, , projectPath, runId] = process.argv;
	if (!projectPath) {
		console.error("usage: node run-shape.mjs <project-cwd> [runId]");
		process.exit(2);
	}
	const all = readChildOutputs(projectPath, { runId: runId ?? null });
	if (!all.available) {
		console.log(`no artifacts dir: ${all.dir}\nreason: ${all.reason}`);
		process.exit(1);
	}
	for (const [id, kids] of groupByRun(all.children)) {
		const s = runShape(kids);
		const peak = s.ambiguous ? `${s.peakOverlapRange[0]}-${s.peakOverlapRange[1]} (ambiguous)` : String(s.peakOverlap);
		console.log(
			`run ${id}: n=${s.n} peak=${peak} wall=${(s.wallMs / 1000).toFixed(1)}s serial=${(s.serialMs / 1000).toFixed(1)}s ` +
				`speedup=${s.speedup}x  durations p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms (N=${s.n})` +
				(s.exitNonZero ? `  nonzero-exit=${s.exitNonZero}` : "") +
				(s.missingOutput ? `  missing-output=${s.missingOutput}` : ""),
		);
	}
}
