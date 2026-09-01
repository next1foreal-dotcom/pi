import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CHARS_PER_TOKEN,
	DEFAULT_SYNTHESIZE_MAX_TOKENS,
	DEFAULT_SYNTHESIZE_WINDOW_TOKENS,
	listSemanticNotes,
	packSynthesizeNotes,
	type SemanticNoteRecord,
	SYNTHESIZE_PACK_RATIO,
	synthesizeLimits,
	synthesizeNoteBudgetChars,
} from "../src/her-core/synthesize-budget.ts";

function note(key: string, text: string, mtimeMs: number): SemanticNoteRecord {
	return { key, text, mtimeMs };
}

test("note budget is window*0.8 minus output tokens, then minus reserved chars", () => {
	assert.equal(
		synthesizeNoteBudgetChars({ reservedChars: 100, windowTokens: 1000, maxTokens: 100 }),
		(Math.floor(1000 * SYNTHESIZE_PACK_RATIO) - 100) * CHARS_PER_TOKEN - 100,
	);
	assert.equal(synthesizeNoteBudgetChars({ reservedChars: 10_000, windowTokens: 200, maxTokens: 100 }), 0);
	assert.equal(synthesizeNoteBudgetChars({ reservedChars: -1, windowTokens: 100, maxTokens: 80 }), 0);
});

test("synthesizeLimits reads env and rejects non-positive values", () => {
	// Against the exported defaults, not literals: this test is about reading
	// the environment, and pinning the numbers here is what made it fail when
	// the output budget was raised to a value that can actually emit
	// CONTEXT.md. synthesize-headroom.test.ts is what guards the value itself.
	assert.deepEqual(synthesizeLimits({}), {
		windowTokens: DEFAULT_SYNTHESIZE_WINDOW_TOKENS,
		maxTokens: DEFAULT_SYNTHESIZE_MAX_TOKENS,
	});
	assert.deepEqual(synthesizeLimits({ HER_SYNTHESIZE_WINDOW_TOKENS: "2000", HER_SYNTHESIZE_MAX_TOKENS: "200" }), {
		windowTokens: 2000,
		maxTokens: 200,
	});
	assert.throws(() => synthesizeLimits({ HER_SYNTHESIZE_WINDOW_TOKENS: "0" }), /HER_SYNTHESIZE_WINDOW_TOKENS/);
	assert.throws(() => synthesizeLimits({ HER_SYNTHESIZE_MAX_TOKENS: "-3" }), /HER_SYNTHESIZE_MAX_TOKENS/);
});

test("pack prefers stem overlap, then recency, then key, and never truncates", () => {
	const packed = packSynthesizeNotes(
		[
			note("unrelated-alpha", "DROP-A", 300),
			note("verification-habit", "KEEP", 100),
			note("unrelated-beta", "DROP-B", 200),
		],
		"Fei prefers verification in reviews",
		4,
	);
	assert.deepEqual(
		packed.selected.map((item) => item.key),
		["verification-habit"],
	);
	assert.equal(packed.packed, "KEEP");
	assert.deepEqual(
		packed.omitted.map((item) => item.key),
		["unrelated-alpha", "unrelated-beta"],
	);
	assert.equal(packed.omitted[0]?.score, 0);
});

test("equal scores break ties by mtime then key", () => {
	const packed = packSynthesizeNotes(
		[note("aaa-note", "A", 1), note("bbb-note", "B", 2), note("ccc-note", "C", 2)],
		"",
		3,
	);
	assert.deepEqual(
		packed.selected.map((item) => item.key),
		["bbb-note"],
	);
	assert.deepEqual(
		packed.omitted.map((item) => item.key),
		["ccc-note", "aaa-note"],
	);
});

test("an oversized note is omitted whole and the next candidate is tried", () => {
	const packed = packSynthesizeNotes([note("huge-note", "H".repeat(50), 1), note("tiny-note", "ok", 1)], "", 10);
	assert.deepEqual(
		packed.selected.map((item) => item.key),
		["tiny-note"],
	);
	assert.equal(packed.omitted[0]?.key, "huge-note");
	assert.equal(packed.omitted[0]?.chars, 50);
	assert.doesNotMatch(packed.packed, /H{10}/);
});

test("zero budget omits every note and still accounts them", () => {
	const packed = packSynthesizeNotes([note("one", "alpha", 1), note("two", "beta", 2)], "query text here", 0);
	assert.equal(packed.packed, "");
	assert.equal(packed.selected.length, 0);
	assert.equal(packed.omitted.length, 2);
	assert.ok(packed.omitted.every((item) => item.chars > 0));
});

test("listSemanticNotes reads markdown stems, text, and mtime", async () => {
	const dir = await mkdtemp(join(tmpdir(), "her-g263-notes-"));
	await writeFile(join(dir, "first-note.md"), "hello", "utf8");
	await writeFile(join(dir, "skip.txt"), "nope", "utf8");
	const notes = await listSemanticNotes(dir);
	assert.equal(notes.length, 1);
	assert.equal(notes[0]?.key, "first-note");
	assert.equal(notes[0]?.text, "hello");
	assert.ok((notes[0]?.mtimeMs ?? 0) > 0);
});
