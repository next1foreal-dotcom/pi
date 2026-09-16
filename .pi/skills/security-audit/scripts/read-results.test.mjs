import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { extractSingleJsonObject, parseArtifactName, readChildOutputs } from "./read-results.mjs";

// run-1's saved agent replies are the calibration target: the parent accepted
// these, and the findings built from them validated clean upstream. A green test
// against text this file invented would prove nothing about real worker output.
const RUN_1_AGENTS = "C:/Users/Admin/security-audit-skill/n1-line/run-1/agents";

function run1(id) {
	const path = `${RUN_1_AGENTS}/${id}/result.raw.txt`;
	return existsSync(path) ? readFileSync(path, "utf8") : null;
}

test("a real verifier reply: prose preamble, then exactly one object", () => {
	const raw = run1("v01-review-mjs-buildprompt-data-injection-no");
	if (raw === null) {
		console.log("run-1 agent replies not readable here — extractor unverified against real worker output");
		return;
	}
	const got = extractSingleJsonObject(raw, { requiredKeys: ["decision"] });
	assert.equal(got.ok, true, got.reason);
	assert.equal(got.preamble, true, "the parent note before the object is reported, not silently eaten");
	assert.equal(got.postamble, false);
	assert.equal(got.value.decision, "needs_validation");
	assert.equal(got.value.record.fingerprint, "review.mjs:buildPrompt/data-injection-no-deterministic-verdict-control");
	assert.equal(got.value.record.trace.length, 7);
});

test("a real critic reply: different required key, no prose around it", () => {
	const raw = run1("critic-final");
	if (raw === null) {
		console.log("run-1 critic reply not readable here — extractor unverified against real worker output");
		return;
	}
	const got = extractSingleJsonObject(raw, { requiredKeys: ["missing_units"] });
	assert.equal(got.ok, true, got.reason);
	assert.equal(got.value.missing_units.length, 2);
	assert.equal(got.value.stop, false);
});

test("HTML entities inside a value survive", () => {
	// run-1 unescaped &lt; &amp; and friends because its transport (an Agent tool
	// notification) escaped them. pi-subagents writes the child's bytes straight
	// to <runId>_<agent>_<i>_output.md, so that transform now has nothing to undo
	// and would instead corrupt any finding that legitimately quotes an entity —
	// exactly the kind of silent content edit a schema validator cannot see.
	const text = String.raw`{"decision":"confirmed","note":"payload was &lt;script&gt; and A&amp;B"}`;
	const got = extractSingleJsonObject(text, { requiredKeys: ["decision"] });
	assert.equal(got.ok, true, got.reason);
	assert.equal(got.value.note, "payload was &lt;script&gt; and A&amp;B");
});

test("two candidate objects is a discard, not a pick-the-first", () => {
	const text = `thinking out loud\n{"decision":"confirmed"}\nactually, revised:\n{"decision":"rejected"}`;
	const got = extractSingleJsonObject(text, { requiredKeys: ["decision"] });
	assert.equal(got.ok, false);
	assert.match(got.reason, /2 candidate/);
});

test("no object at all says so instead of throwing", () => {
	const got = extractSingleJsonObject("I could not complete this task.", { requiredKeys: ["decision"] });
	assert.equal(got.ok, false);
	assert.match(got.reason, /no top-level JSON object/);
});

test("an object that does not carry the required key is not a candidate", () => {
	const got = extractSingleJsonObject(String.raw`{"summary":"done"}`, { requiredKeys: ["decision"] });
	assert.equal(got.ok, false);
	assert.match(got.reason, /no top-level JSON object/);
});

test("a malformed object next to a good one is a discard", () => {
	// Truncation is the common shape here: a child that ran out of output budget
	// leaves a half-object. Taking the parseable one and moving on would drop the
	// real answer and keep a fragment.
	const text = `{"decision":"confirmed","record":{"verdict":"confirmed"}} then {"decision": oops}`;
	const got = extractSingleJsonObject(text, { requiredKeys: ["decision"] });
	assert.equal(got.ok, false);
	assert.match(got.reason, /unparsable/);
});

test("a duplicate key is a discard — JSON.parse would silently keep the last", () => {
	const text = String.raw`{"decision":"rejected","record":{"verdict":"rejected"},"decision":"confirmed"}`;
	const parsedByNode = JSON.parse(text);
	assert.equal(parsedByNode.decision, "confirmed", "node really does keep the last one");
	const got = extractSingleJsonObject(text, { requiredKeys: ["decision"] });
	assert.equal(got.ok, false);
	assert.match(got.reason, /duplicate key/);
	assert.match(got.reason, /decision/);
});

test("a duplicate key nested deeper is caught too", () => {
	const text = String.raw`{"decision":"confirmed","record":{"verdict":"confirmed","verdict":"rejected"}}`;
	const got = extractSingleJsonObject(text, { requiredKeys: ["decision"] });
	assert.equal(got.ok, false);
	assert.match(got.reason, /duplicate key/);
});

test("the same key in sibling objects is not a duplicate", () => {
	// The naive version of the duplicate check — count keys per nesting depth —
	// fails here, and every trace[] array in a real finding trips it.
	const text = String.raw`{"decision":"confirmed","trace":[{"file":"a.mjs"},{"file":"b.mjs"}]}`;
	const got = extractSingleJsonObject(text, { requiredKeys: ["decision"] });
	assert.equal(got.ok, true, got.reason);
	assert.equal(got.value.trace.length, 2);
});

test("braces inside strings do not end the object", () => {
	const text = String.raw`{"decision":"confirmed","note":"regex /^\\{.*\\}$/ and a quote \" here"}`;
	const got = extractSingleJsonObject(text, { requiredKeys: ["decision"] });
	assert.equal(got.ok, true, got.reason);
	assert.match(got.value.note, /regex/);
});

test("artifact filenames split even when the agent id contains underscores", () => {
	assert.deepEqual(parseArtifactName("e61fd4a8_nonce-reader_0_output.md"), {
		runId: "e61fd4a8",
		agent: "nonce-reader",
		index: 0,
		kind: "output",
	});
	assert.deepEqual(parseArtifactName("83fe3a9f_h2_file_handling_11_meta.json"), {
		runId: "83fe3a9f",
		agent: "h2_file_handling",
		index: 11,
		kind: "meta",
	});
	assert.equal(parseArtifactName("notes.txt"), null);
});

test("reads a real fan-out's children off disk, pairing output with meta", () => {
	const all = readChildOutputs(String.raw`D:\@Her\Her-repo\samantha`);
	if (!all.available) {
		console.log(`artifacts dir unavailable (${all.reason}) — reader unverified against real children`);
		return;
	}
	assert.ok(all.children.length > 0, "found children");
	for (const child of all.children) {
		assert.match(child.runId, /^[0-9a-f]+$/);
		assert.equal(typeof child.agent, "string");
		assert.equal(typeof child.index, "number");
		// The three things a run ledger cannot be built without.
		assert.ok(child.task, `child ${child.key} has its task text`);
		assert.equal(typeof child.exitCode, "number");
		assert.ok(child.output !== undefined, `child ${child.key} has output or a stated reason`);
	}
	const runIds = new Set(all.children.map((c) => c.runId));
	const one = [...runIds][0];
	const filtered = readChildOutputs(String.raw`D:\@Her\Her-repo\samantha`, { runId: one });
	assert.ok(filtered.children.length > 0);
	assert.ok(
		filtered.children.every((c) => c.runId === one),
		"filtering by runId keeps one fan-out's children apart from an earlier one's",
	);
	assert.ok(filtered.children.length < all.children.length || runIds.size === 1);
});
