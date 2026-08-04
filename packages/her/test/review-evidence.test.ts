import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyEvidence } from "../src/her-core/review-evidence.ts";

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "her-review-evidence-"));
}

test("verifyEvidence marks a path that escapes cwd as unverified", () => {
	const cwd = tempCwd();
	const result = verifyEvidence([{ file: "../outside.ts", claim: "x" }], cwd);
	assert.equal(result[0].verified, false);
	assert.match(result[0].verify_note ?? "", /工作目录之外/);
});

test("verifyEvidence marks a missing file as unverified", () => {
	const cwd = tempCwd();
	const result = verifyEvidence([{ file: "nope.ts", claim: "x" }], cwd);
	assert.equal(result[0].verified, false);
	assert.match(result[0].verify_note ?? "", /不存在或不可读/);
});

test("verifyEvidence marks a malformed lines field as unverified", () => {
	const cwd = tempCwd();
	writeFileSync(join(cwd, "a.ts"), "line1\nline2\nline3\n");
	const result = verifyEvidence([{ file: "a.ts", lines: "abc", claim: "x" }], cwd);
	assert.equal(result[0].verified, false);
	assert.match(result[0].verify_note ?? "", /行号格式无法解析/);
});

test("verifyEvidence marks an out-of-range lines field as unverified and reports the total", () => {
	const cwd = tempCwd();
	writeFileSync(join(cwd, "a.ts"), "line1\nline2\nline3\n");
	const total = "line1\nline2\nline3\n".split("\n").length;
	const result = verifyEvidence([{ file: "a.ts", lines: "1-999", claim: "x" }], cwd);
	assert.equal(result[0].verified, false);
	assert.match(result[0].verify_note ?? "", /行号越界/);
	assert.match(result[0].verify_note ?? "", new RegExp(`共 ${total} 行`));
});

test("verifyEvidence marks a valid line range as verified", () => {
	const cwd = tempCwd();
	writeFileSync(join(cwd, "a.ts"), "line1\nline2\nline3\n");
	const result = verifyEvidence([{ file: "a.ts", lines: "1-2", claim: "x" }], cwd);
	assert.equal(result[0].verified, true);
	assert.equal(result[0].verify_note, undefined);
});

test("verifyEvidence treats a missing lines field as verified when the file exists", () => {
	const cwd = tempCwd();
	writeFileSync(join(cwd, "a.ts"), "line1\nline2\nline3\n");
	const result = verifyEvidence([{ file: "a.ts", claim: "x" }], cwd);
	assert.equal(result[0].verified, true);
});

test("verifyEvidence never drops an entry and preserves order across mixed outcomes", () => {
	const cwd = tempCwd();
	writeFileSync(join(cwd, "a.ts"), "line1\nline2\nline3\n");
	const input = [
		{ file: "a.ts", lines: "1-2", claim: "valid" },
		{ file: "missing.ts", claim: "missing" },
		{ file: "../escape.ts", claim: "escape" },
		{ file: "a.ts", lines: "9-10", claim: "out of range" },
	];
	const result = verifyEvidence(input, cwd);
	assert.equal(result.length, input.length, "no entry may be dropped");
	assert.deepEqual(
		result.map((e) => e.claim),
		["valid", "missing", "escape", "out of range"],
		"order must be preserved",
	);
	assert.deepEqual(
		result.map((e) => e.verified),
		[true, false, false, false],
	);
});
