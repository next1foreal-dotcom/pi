import { MERGE_CRITERIA, type SelfModGateResult } from "./selfmod-types.ts";

/**
 * Parse the trusted host runner's explicit `node --test --test-reporter=tap`
 * summary. An exit code alone is not evidence that a single test ran.
 * This parser does not authenticate stdout or replace evaluator isolation.
 */
export function parseSelfmodTestEvidence(output: string): { failed: number; passed: number } {
	const names = ["tests", "pass", "fail", "cancelled", "skipped", "todo"] as const;
	const counts = new Map<string, number>();
	for (const name of names) {
		const rows = [...output.matchAll(new RegExp(`^# ${name} ([^\\r\\n]+)\\r?$`, "gm"))];
		if (rows.length !== 1 || !/^\d+$/.test(rows[0][1])) {
			throw new Error(`missing or ambiguous node:test summary: ${name}`);
		}
		const count = Number(rows[0][1]);
		if (!Number.isSafeInteger(count)) throw new Error(`invalid node:test count: ${name}`);
		counts.set(name, count);
	}
	const count = (name: string): number => counts.get(name) ?? 0;
	const accounted = count("pass") + count("fail") + count("cancelled") + count("skipped") + count("todo");
	if (accounted !== count("tests")) throw new Error("inconsistent node:test summary");
	if (count("pass") === 0 || count("fail") !== 0 || count("cancelled") !== 0 || count("todo") !== 0) {
		throw new Error("node:test did not produce a nonempty passing run");
	}
	return { failed: count("fail"), passed: count("pass") };
}

/** No new authority: this only strengthens the existing mechanical merge gate. */
export function meetsMeasuredMergeCriteria(gate: SelfModGateResult): boolean {
	return (
		Number.isSafeInteger(gate.testsPassed) &&
		gate.testsPassed > 0 &&
		gate.typecheckExit === MERGE_CRITERIA.typecheckExit &&
		gate.testsFailed === MERGE_CRITERIA.testsFailed &&
		gate.evalGateFixturesPassed === MERGE_CRITERIA.evalGateFixturesPassed &&
		gate.anchorScanClean === MERGE_CRITERIA.anchorScanClean &&
		gate.encodingScanClean === MERGE_CRITERIA.encodingScanClean
	);
}
