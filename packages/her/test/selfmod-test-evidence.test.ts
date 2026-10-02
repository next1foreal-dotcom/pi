import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { meetsMeasuredMergeCriteria, parseSelfmodTestEvidence } from "../src/her-core/selfmod-test-evidence.ts";

function tap(over: Partial<Record<"tests" | "pass" | "fail" | "cancelled" | "skipped" | "todo", number>> = {}): string {
	const summary = { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...over };
	return `TAP version 13\n${Object.entries(summary)
		.map(([key, value]) => `# ${key} ${value}`)
		.join("\n")}\n`;
}

const green = {
	typecheckExit: 0,
	testsPassed: 3,
	testsFailed: 0,
	evalGateFixturesPassed: true,
	anchorScanClean: true,
	encodingScanClean: true,
};

test("returns measured counts, not one invented passing test", () => {
	assert.deepEqual(parseSelfmodTestEvidence(tap()), { passed: 3, failed: 0 });
});

for (const [name, output] of Object.entries({
	empty: "",
	claim: "All tests passed",
	zero: tap({ tests: 0, pass: 0 }),
	skipped: tap({ pass: 0, skipped: 3 }),
	failed: tap({ pass: 2, fail: 1 }),
	cancelled: tap({ pass: 2, cancelled: 1 }),
	todo: tap({ pass: 2, todo: 1 }),
	missing: tap().replace("# pass 3\n", ""),
	duplicate: `${tap()}# pass 3\n`,
	negative: tap({ pass: -1 }),
	fractional: tap({ pass: 2.5 }),
	nonfinite: tap({ pass: Number.POSITIVE_INFINITY }),
	inconsistent: tap({ tests: 99 }),
	overflow: tap({ tests: Number.MAX_SAFE_INTEGER + 1 }),
})) {
	test(`refuses ${name} test evidence`, () => assert.throws(() => parseSelfmodTestEvidence(output)));
}

test("accepts real Node TAP output including nested tests", () => {
	const dir = mkdtempSync(join(tmpdir(), "her-evidence-real-"));
	try {
		const file = join(dir, "passing.test.mjs");
		writeFileSync(
			file,
			'import test from "node:test"; test("outer", async t => { await t.test("inner", () => {}); });\n',
		);
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		const stdout = execFileSync(process.execPath, ["--test", "--test-reporter=tap", file], { encoding: "utf8", env });
		const counts = parseSelfmodTestEvidence(stdout);
		assert.ok(counts.passed > 0);
		assert.equal(counts.failed, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("empty real Node suite cannot pass the evidence gate", () => {
	const dir = mkdtempSync(join(tmpdir(), "her-evidence-empty-"));
	try {
		const file = join(dir, "empty.test.mjs");
		writeFileSync(file, 'import { describe } from "node:test"; describe("empty suite", () => {});\n');
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		const stdout = execFileSync(process.execPath, ["--test", "--test-reporter=tap", file], { encoding: "utf8", env });
		assert.throws(() => parseSelfmodTestEvidence(stdout));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("measured green permits only the existing merge predicate", () => {
	assert.equal(meetsMeasuredMergeCriteria(green), true);
});
for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
	test(`merge predicate rejects invalid passing count ${String(value)}`, () => {
		assert.equal(meetsMeasuredMergeCriteria({ ...green, testsPassed: value }), false);
	});
}
test("every prior safety gate remains necessary", () => {
	for (const field of ["evalGateFixturesPassed", "anchorScanClean", "encodingScanClean"] as const) {
		assert.equal(meetsMeasuredMergeCriteria({ ...green, [field]: false }), false);
	}
	assert.equal(meetsMeasuredMergeCriteria({ ...green, typecheckExit: 1 }), false);
	assert.equal(meetsMeasuredMergeCriteria({ ...green, testsFailed: 1 }), false);
	assert.equal(meetsMeasuredMergeCriteria({ ...green, testsFailed: NaN }), false);
});
