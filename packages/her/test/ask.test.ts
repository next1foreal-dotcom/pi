/**
 * G-375 — structured option-card question (runtime half).
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/ask.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildAskMessage } from "../src/her-core/ask.ts";
import { resolveGovernedTool } from "../src/lib/governed-tools.ts";

const HINT = `(回复"选:<label>";可多选用顿号;其他答案直接打字)`;

const two = [
	{ label: "Yes", description: "proceed with the change" },
	{ label: "No", description: "leave it as-is" },
];

function labels(count: number): Array<{ label: string }> {
	return Array.from({ length: count }, (_, i) => ({ label: `Opt${i + 1}` }));
}

test("buildAskMessage accepts 2..6 unique options and defaults multi to false", () => {
	const result = buildAskMessage({ question: "Ship this?", options: two });
	assert.equal(result.details.kind, "her-ask");
	assert.equal(result.details.question, "Ship this?");
	assert.deepEqual(result.details.options, two);
	assert.equal(result.details.multi, false);

	const six = buildAskMessage({ question: "Pick one", options: labels(6) });
	assert.equal(six.details.options.length, 6);
	assert.equal(six.details.multi, false);
});

test("buildAskMessage rejects 1 or 7 options and names the 2..6 bound", () => {
	assert.throws(() => buildAskMessage({ question: "Ship this?", options: [two[0]!] }), /2|6/);
	assert.throws(() => buildAskMessage({ question: "Ship this?", options: labels(7) }), /2|6/);
	assert.throws(() => buildAskMessage({ question: "Ship this?", options: [] }), /2|6/);
});

test("buildAskMessage rejects duplicate labels", () => {
	assert.throws(
		() =>
			buildAskMessage({
				question: "Ship this?",
				options: [
					{ label: "Yes", description: "a" },
					{ label: "Yes", description: "b" },
				],
			}),
		/unique|duplicate|重复/i,
	);
	assert.throws(
		() =>
			buildAskMessage({
				question: "Ship this?",
				options: [{ label: "Yes" }, { label: " Yes " }],
			}),
		/unique|duplicate|重复/i,
	);
});

test("buildAskMessage rejects overlong question, label, and description", () => {
	assert.throws(() => buildAskMessage({ question: "q".repeat(501), options: two }), /500/);
	assert.throws(
		() =>
			buildAskMessage({
				question: "Ship this?",
				options: [{ label: "L".repeat(61) }, { label: "No" }],
			}),
		/60/,
	);
	assert.throws(
		() =>
			buildAskMessage({
				question: "Ship this?",
				options: [{ label: "Yes", description: "d".repeat(201) }, { label: "No" }],
			}),
		/200/,
	);
});

test("buildAskMessage rejects empty question and empty label", () => {
	assert.throws(() => buildAskMessage({ question: "", options: two }), /question/i);
	assert.throws(() => buildAskMessage({ question: "   ", options: two }), /question/i);
	assert.throws(
		() => buildAskMessage({ question: "Ship this?", options: [{ label: "" }, { label: "No" }] }),
		/label/i,
	);
	assert.throws(
		() => buildAskMessage({ question: "Ship this?", options: [{ label: "  " }, { label: "No" }] }),
		/label/i,
	);
});

test("buildAskMessage content includes every label and the fixed reply hint", () => {
	const result = buildAskMessage({ question: "Ship this?", options: two });
	const lines = result.content.split("\n");
	assert.equal(lines[0], "Ship this?");
	assert.equal(lines[1], "1. Yes — proceed with the change");
	assert.equal(lines[2], "2. No — leave it as-is");
	assert.equal(lines[3], HINT);
	assert.equal(lines.at(-1), HINT);
	for (const option of two) {
		assert.ok(result.content.includes(option.label), option.label);
	}

	const unlabeled = buildAskMessage({
		question: "Color?",
		options: [{ label: "Red" }, { label: "Blue", description: "cool" }],
	});
	assert.match(unlabeled.content, /^Color\?\n1\. Red\n2\. Blue — cool\n/);
	assert.ok(unlabeled.content.endsWith(HINT));
	assert.ok(unlabeled.content.includes("Red"));
	assert.ok(unlabeled.content.includes("Blue"));
});

test("buildAskMessage details pass question, options, and multi through unchanged", () => {
	const options = [
		{ label: "Keep", description: "stay on this branch" },
		{ label: "Revert" },
		{ label: "Park", description: "stash and wait" },
	];
	const result = buildAskMessage({ question: "What next?", options, multi: true });
	assert.deepEqual(result.details, {
		kind: "her-ask",
		question: "What next?",
		options,
		multi: true,
	});
	assert.equal(result.details.multi, true);

	const omitted = buildAskMessage({ question: "What next?", options: two, multi: false });
	assert.equal(omitted.details.multi, false);
	assert.deepEqual(omitted.details.options, two);
});

test("her_ask is registered non-destructive so Cedar :6 total permit covers it", () => {
	assert.deepEqual(resolveGovernedTool("her_ask"), { destructive: false, registered: true });
});
