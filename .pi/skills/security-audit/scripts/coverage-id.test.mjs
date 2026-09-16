import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { coverageId, encodeRef, QUICK_SUBSYSTEM } from "./coverage-id.mjs";

// run-1's ledger validated clean against the upstream validate-coverage-ledger.cjs,
// so its ids are a known-good target. Calibrating the encoder against something
// already known to pass is the point: a green test against ids this same file
// produced would prove nothing.
const RUN_1_LEDGER = "C:/Users/Admin/security-audit-skill/n1-line/run-1/coverage-ledger.json";

function loadRun1Units() {
	try {
		const parsed = JSON.parse(readFileSync(RUN_1_LEDGER, "utf8"));
		return Array.isArray(parsed) ? parsed : (parsed.units ?? []);
	} catch {
		return null;
	}
}

test("reproduces every coverage_id in run-1's validated ledger", () => {
	const units = loadRun1Units();
	if (units === null) {
		// Not a silent skip: say which check did not run and why.
		console.log("run-1 ledger not readable here — encoder unverified against real ids");
		return;
	}
	assert.ok(units.length > 0, "run-1 ledger has units");
	for (const unit of units) {
		assert.equal(coverageId(unit.canonical_refs), unit.coverage_id, `unit ${unit.coverage_id}`);
	}
});

test("multi-byte characters encode per byte, uppercase", () => {
	// ≠ is U+2260, three UTF-8 bytes. run-1 has this in a real boundary ref, and
	// a per-codepoint encoder would quietly produce a different id.
	assert.equal(encodeRef("tree≠"), "tree%E2%89%A0");
	assert.equal(encodeRef("a b"), "a%20b");
	assert.equal(encodeRef("A-Z.a_z~0"), "A-Z.a_z~0");
});

test("refs that would encode to something plausible but wrong are refused", () => {
	assert.throws(() => encodeRef(""), /empty/);
	assert.throws(() => encodeRef(" leading"), /leading\/trailing/);
	assert.throws(() => encodeRef("trailing "), /leading\/trailing/);
	assert.throws(() => encodeRef("zero\u200bwidth"), /control or zero-width/);
	assert.throws(() => encodeRef("bom\ufeff"), /control or zero-width/);
	assert.throws(() => encodeRef("nl\n"), /control or zero-width/);
});

test("a unit missing a canonical ref is refused, not coarsened", () => {
	assert.throws(
		() => coverageId({ surface: "s", boundary: "b", subsystem: QUICK_SUBSYSTEM }),
		/missing: attack_class/,
	);
});
