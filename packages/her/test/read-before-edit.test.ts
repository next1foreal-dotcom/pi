/**
 * G-401 — read-before-edit guard (pure logic).
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/read-before-edit.test.ts
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createReadGuard } from "../src/her-core/read-before-edit.ts";

const SAMPLE_REL = "packages/her/src/her-core/read-before-edit.ts";
const SAMPLE_ABS = resolve(SAMPLE_REL);
const BLOCK_PREFIX = "未读先改被拦:本轮会话没有读过 ";
const BLOCK_SUFFIX = '。先 read 它再改——这条护栏防的是"凭想象改文件"。(移植自 Claude Code 的 Edit 前置)';

function flipDriveCase(filePath: string): string {
	return filePath.replace(/^([A-Za-z]):/, (_, letter: string) =>
		letter === letter.toLowerCase() ? `${letter.toUpperCase()}:` : `${letter.toLowerCase()}:`,
	);
}

function blockReason(filePath: string): string {
	return `${BLOCK_PREFIX}${filePath}${BLOCK_SUFFIX}`;
}

test("unread edit is blocked and reason names the path verbatim", () => {
	const guard = createReadGuard();
	const verdict = guard.checkToolCall("edit", { path: SAMPLE_ABS });
	assert.equal(verdict.block, true);
	assert.equal("reason" in verdict && verdict.reason, blockReason(SAMPLE_ABS));
	assert.ok(verdict.block && verdict.reason.includes(SAMPLE_ABS));
});

test("read then edit of the same path is allowed", () => {
	const guard = createReadGuard();
	guard.noteToolCall("read", { path: SAMPLE_ABS });
	assert.deepEqual(guard.checkToolCall("edit", { path: SAMPLE_ABS }), { block: false });
});

test("write then edit of the same path is allowed", () => {
	const guard = createReadGuard();
	guard.noteToolCall("write", { path: SAMPLE_ABS, content: "x" });
	assert.deepEqual(guard.checkToolCall("edit", { path: SAMPLE_ABS }), { block: false });
});

test("non-edit tools are allowed even when the path was never read", () => {
	const guard = createReadGuard();
	assert.deepEqual(guard.checkToolCall("bash", { command: "echo ok" }), { block: false });
	assert.deepEqual(guard.checkToolCall("read", { path: SAMPLE_ABS }), { block: false });
	assert.deepEqual(guard.checkToolCall("ls", { path: SAMPLE_ABS }), { block: false });
	assert.deepEqual(guard.checkToolCall("write", { path: SAMPLE_ABS, content: "x" }), { block: false });
});

test("edit with no recognizable path is allowed", () => {
	const guard = createReadGuard();
	assert.deepEqual(guard.checkToolCall("edit", {}), { block: false });
	assert.deepEqual(guard.checkToolCall("edit", { oldText: "a", newText: "b" }), { block: false });
	assert.deepEqual(guard.checkToolCall("edit", undefined), { block: false });
	assert.deepEqual(guard.checkToolCall("edit", null), { block: false });
	assert.deepEqual(guard.checkToolCall("edit", { path: "" }), { block: false });
	assert.deepEqual(guard.checkToolCall("edit", { path: "   " }), { block: false });
});

test("relative and absolute forms of the same path are one file", () => {
	const guard = createReadGuard();
	guard.noteToolCall("read", { path: SAMPLE_REL });
	assert.deepEqual(guard.checkToolCall("edit", { path: SAMPLE_ABS }), { block: false });

	const other = createReadGuard();
	other.noteToolCall("read", { path: SAMPLE_ABS });
	assert.deepEqual(other.checkToolCall("edit", { path: SAMPLE_REL }), { block: false });
});

test("drive-letter case variants of an absolute path are one file", () => {
	const guard = createReadGuard();
	const flipped = flipDriveCase(SAMPLE_ABS);
	guard.noteToolCall("read", { path: SAMPLE_ABS });
	assert.deepEqual(guard.checkToolCall("edit", { path: flipped }), { block: false });

	if (process.platform === "win32") {
		assert.notEqual(flipped, SAMPLE_ABS, "Windows drive letter actually flipped");
	}
});

test("repeated noteToolCall of the same path is idempotent", () => {
	const guard = createReadGuard();
	guard.noteToolCall("read", { path: SAMPLE_ABS });
	guard.noteToolCall("read", { path: SAMPLE_ABS });
	guard.noteToolCall("read", { path: SAMPLE_REL });
	guard.noteToolCall("write", { path: SAMPLE_ABS, content: "again" });
	assert.deepEqual(guard.checkToolCall("edit", { path: SAMPLE_ABS }), { block: false });
});

test("read via file_path or absolutePath counts for a later edit via path", () => {
	const viaFilePath = createReadGuard();
	viaFilePath.noteToolCall("read", { file_path: SAMPLE_ABS });
	assert.deepEqual(viaFilePath.checkToolCall("edit", { path: SAMPLE_ABS }), { block: false });

	const viaAbsolute = createReadGuard();
	viaAbsolute.noteToolCall("read", { absolutePath: SAMPLE_ABS });
	assert.deepEqual(viaAbsolute.checkToolCall("edit", { path: SAMPLE_ABS }), { block: false });
});

test("a tool whose name contains edit is gated the same way as edit", () => {
	const guard = createReadGuard();
	const unread = guard.checkToolCall("multi_edit", { path: SAMPLE_ABS });
	assert.equal(unread.block, true);
	assert.ok(unread.block && unread.reason.includes(SAMPLE_ABS));
	guard.noteToolCall("read", { path: SAMPLE_ABS });
	assert.deepEqual(guard.checkToolCall("multi_edit", { path: SAMPLE_ABS }), { block: false });
});
