import assert from "node:assert/strict";
import test from "node:test";
import { selection } from "../src/growth-experiment/parse.ts";

// Synthetic parser regressions, not evidence of autonomous learning or task gains.
// Empty adaptation means unchanged reuse; the host still owns applicability and authorization.
const unchanged = { decision: "use", reason: "The method fits this task without changes.", adaptation: [] };

test("unchanged reuse does not require an invented adaptation", () => {
	assert.deepEqual(selection(unchanged), unchanged);
});

test("real adaptations remain supported and normalized", () => {
	assert.deepEqual(selection({ ...unchanged, adaptation: ["  Use the new input path.  "] }), {
		...unchanged,
		adaptation: ["Use the new input path."],
	});
});

test("declining a method remains valid with no adaptation", () => {
	const decline = { ...unchanged, decision: "deliberate", reason: "The method does not fit." };
	assert.deepEqual(selection(decline), decline);
});

for (const [name, adaptation] of [
	["missing", undefined],
	["null", null],
	["string", "unchanged"],
	["object", {}],
	["empty step", [""]],
	["whitespace step", ["   "]],
	["non-text step", [1]],
	["oversized step", ["x".repeat(16_001)]],
	["too many steps", Array.from({ length: 33 }, () => "A valid step.")],
] as const) {
	test(`invalid adaptation still rejected: ${name}`, () => {
		assert.throws(() => selection({ ...unchanged, adaptation }), /adaptation/);
	});
}

test("a reason is still mandatory for unchanged reuse", () => {
	assert.throws(() => selection({ ...unchanged, reason: " " }), /reason/);
});

test("unknown decisions remain invalid", () => {
	assert.throws(() => selection({ ...unchanged, decision: "execute-now" }), /decision/);
});

test("the existing 32-step upper boundary remains valid", () => {
	const result = selection({
		...unchanged,
		adaptation: Array.from({ length: 32 }, () => "A valid step."),
	});
	assert.equal(result.adaptation.length, 32);
});

test("selection does not mutate the supplied decision or adaptation array", () => {
	const adaptation = Object.freeze(["  Use the current path.  "]);
	const input = Object.freeze({ ...unchanged, adaptation });
	const result = selection(input);
	assert.deepEqual(adaptation, ["  Use the current path.  "]);
	assert.deepEqual(result.adaptation, ["Use the current path."]);
	assert.notEqual(result.adaptation, adaptation);
});
