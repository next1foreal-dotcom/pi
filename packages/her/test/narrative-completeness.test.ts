import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initStore, Memory, readJson, readText } from "../src/her-core/index.ts";
import { assertNarrativeComplete, NarrativeIncompleteError } from "../src/her-core/memory-utils.ts";

const BODY = "# Fei's Becoming Narrative\n\nHe builds systems he can grep, diff, and carry anywhere. ";

/**
 * Long enough to clear NARRATIVE_ESTABLISHED_MIN_CHARS (2,000), so a draft built from this
 * counts as an established narrative when it appears on the `current` side, and never trips
 * the length guard when it appears as the draft.
 */
function draftEndingWith(ending: string): string {
	return `${BODY.repeat(40)}${ending}`;
}

const CURRENT = BODY.repeat(2);

// The verbatim tail of proposals/2026-08-09-narrative-update.md and 2026-08-11-narrative-update.md,
// which were byte-identical to each other and to the CONTEXT.md they overwrote
// (SHA256 65f7ae5f469543fb..., 3,395 bytes, restored from 2e40e89 in her-memory b7f87f0).
const REAL_STUMP_TAIL = "bbox detection via vision models, SAM2/BiRefNet segmentation, and Flux-Fill/SD";

test("accepts drafts that end on a finished sentence, whatever the trailing markup", () => {
	// Sweep the ending SHAPE, since that is the dimension the defect lived in — one fixture
	// would only prove the one shape it happened to use.
	const endings = [
		"sovereignty is a choice of infrastructure.",
		"and that is the whole point!",
		"is it not?",
		'"The Design Co-Author," "The Evidence-First Contractor."*', // the real 08-02 ending shape
		"他把记忆当作资产。",
		"**记忆增值，harness 贬值。**",
		"a pause, and then silence…",
		"(and he carried it anywhere.)",
	];
	for (const ending of endings) {
		assert.doesNotThrow(() => assertNarrativeComplete(draftEndingWith(ending), CURRENT), ending);
	}
});

test("rejects drafts cut off mid-sentence, across ending shapes", () => {
	const endings = [
		REAL_STUMP_TAIL,
		"segmentation, and",
		"他知道 apply_patch 在 Windows 上会",
		"the moat he builds himself grows more valuable over",
		"```json",
	];
	for (const ending of endings) {
		assert.throws(() => assertNarrativeComplete(draftEndingWith(ending), CURRENT), NarrativeIncompleteError, ending);
	}
});

test("rejects an empty or whitespace-only narrative", () => {
	for (const draft of ["", "   ", "\n\n\t"]) {
		assert.throws(() => assertNarrativeComplete(draft, CURRENT), NarrativeIncompleteError);
	}
});

test("the two signals are independent: a clean ending does not rescue a collapsed draft", () => {
	// The observed cut landed mid-word, but nothing guarantees that — a cut one token later
	// ends on a period and would sail past an ending-only check. This is why the ratio guard
	// exists, and this test fails if it is ever removed.
	const current = draftEndingWith("the whole narrative, intact.");
	const collapsed = `${BODY}${REAL_STUMP_TAIL}.`;
	assert.ok(collapsed.length < current.trim().length * 0.5, "fixture must actually be a collapse");
	let caught: unknown;
	try {
		assertNarrativeComplete(collapsed, current);
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof NarrativeIncompleteError);
	assert.match((caught as Error).message, /under half/);
});

test("the length guard stays out of the way until there is a narrative worth protecting", () => {
	// A fresh store seeds CONTEXT.md with 113 chars. A first synthesize that legitimately has
	// little to say must not be rejected for being short — the guard protects an established
	// narrative, not a seed. Without the floor this is exactly the case that broke
	// her-core.test.ts's "synthesize writes CONTEXT with a trail commit".
	const seeded = "# Fei's Becoming Narrative\n\nSeeded placeholder awaiting a first synthesis.\n";
	assert.ok(seeded.length < 2000);
	assert.doesNotThrow(() => assertNarrativeComplete("# CONTEXT\n\nFei values verified execution.\n", seeded));
});

test("accepts a draft that holds or grows the narrative it replaces", () => {
	const current = draftEndingWith("the whole narrative, intact.");
	assert.doesNotThrow(() => assertNarrativeComplete(current, current));
	assert.doesNotThrow(() => assertNarrativeComplete(`${current} And one more turn.`, current));
});

test("08-09/08-11 accident replay: a truncated draft lands nothing and does not stamp the week done", async () => {
	const store = await mkdtemp(join(tmpdir(), "her-narrative-"));
	await initStore(store);
	const contextBefore = await readText(join(store, "narrative", "CONTEXT.md"));
	const proposalsBefore = await readdir(join(store, "proposals"));
	const memory = new Memory(store, {
		async complete() {
			return `${BODY.repeat(2)}${REAL_STUMP_TAIL}`;
		},
	});

	await assert.rejects(() => memory.synthesize(), NarrativeIncompleteError);

	// The three things that advanced together in the accident must all be untouched.
	assert.deepEqual(await readdir(join(store, "proposals")), proposalsBefore, "no proposal may be written");
	const state = await readJson<{ last_synthesize?: string | null }>(join(store, ".her", "state.json"), {});
	assert.ok(!state.last_synthesize, "last_synthesize must not advance on a failed synthesize");
	assert.equal(await readText(join(store, "narrative", "CONTEXT.md")), contextBefore, "CONTEXT.md must be untouched");
});
