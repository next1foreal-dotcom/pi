import assert from "node:assert/strict";
import { statSync } from "node:fs";
import test from "node:test";

import {
	CHARS_PER_TOKEN,
	CONTEXT_HEADROOM_WARN_RATIO,
	contextHeadroom,
	DEFAULT_SYNTHESIZE_MAX_TOKENS,
} from "../src/her-core/synthesize-budget.ts";

/**
 * synthesize rewrites CONTEXT.md in one completion. When the output budget is
 * smaller than the document, every run ends in finish_reason=length and the
 * code refuses to write a truncated narrative — correctly, but forever. That
 * is what happened: 8_192 tokens against a 38 KB CONTEXT.md, four weekly
 * failures in a row from 2026-08-02, noticed only when a panel finally showed
 * the task red.
 */
test("the output budget can actually emit the document it must rewrite", () => {
	// The real numbers from the failure: draft 40587 bytes, current 38052.
	const observedDraftBytes = 40_587;
	const capBytes = DEFAULT_SYNTHESIZE_MAX_TOKENS * CHARS_PER_TOKEN;
	assert.ok(
		capBytes > observedDraftBytes,
		`the cap (${capBytes} bytes) must exceed a draft that has actually been produced (${observedDraftBytes})`,
	);

	// And the old value must not come back: it is provably too small.
	assert.ok(8_192 * CHARS_PER_TOKEN < observedDraftBytes, "sanity: the old cap really was under the draft");
});

test("headroom is reported before the ceiling, not at it", () => {
	const cap = DEFAULT_SYNTHESIZE_MAX_TOKENS * CHARS_PER_TOKEN;

	// Both sides: comfortable stays quiet, tight speaks up.
	const roomy = contextHeadroom(Math.floor(cap * 0.3));
	assert.equal(roomy.tight, false);

	const tight = contextHeadroom(Math.floor(cap * (CONTEXT_HEADROOM_WARN_RATIO + 0.05)));
	assert.equal(tight.tight, true);
	assert.ok(tight.usedRatio > roomy.usedRatio);

	// The warning must fire BEFORE the failure, or it is just a second alarm
	// for something that already broke.
	assert.ok(CONTEXT_HEADROOM_WARN_RATIO < 1);
});

test("her live CONTEXT.md still fits, and this test says by how much", () => {
	const path = process.env.HER_MEMORY_DIR
		? `${process.env.HER_MEMORY_DIR}/narrative/CONTEXT.md`
		: "D:/@Her/her-memory/narrative/CONTEXT.md";
	let bytes: number;
	try {
		bytes = statSync(path).size;
	} catch {
		// Not every machine has her memory checked out; the guard above still ran.
		return;
	}
	const headroom = contextHeadroom(bytes);
	assert.ok(
		headroom.usedRatio < 1,
		`CONTEXT.md is ${bytes} bytes against a ~${headroom.capBytes} byte ceiling — synthesize cannot rewrite it`,
	);
});
