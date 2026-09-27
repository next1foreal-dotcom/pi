import assert from "node:assert/strict";
import { win32 } from "node:path";
import { test } from "node:test";
import { pathIsWithin, sideChatToolViolation } from "../src/side-chat-guard.ts";

test("side chat allows only read tools inside the canonical workspace", async () => {
	const canonical = async (path: string) => {
		if (path.endsWith("link-out")) return "C:\\outside\\secret";
		return win32.resolve(path);
	};
	assert.equal(await sideChatToolViolation("C:\\work", "read", { path: "src\\a.ts" }, canonical), null);
	assert.equal(
		await sideChatToolViolation("C:\\work", "read", { path: "link-out" }, canonical),
		"path link-out escapes the authorized workspace",
	);
	assert.equal(
		await sideChatToolViolation("C:\\work", "write", { path: "a.ts" }, canonical),
		"tool write is not read-only",
	);
});

test("path containment rejects siblings and accepts the root", () => {
	assert.equal(pathIsWithin("C:\\work", "C:\\work"), true);
	assert.equal(pathIsWithin("C:\\work", "C:\\work\\src\\a.ts"), true);
	assert.equal(pathIsWithin("C:\\work", "C:\\work-other\\a.ts"), false);
	assert.equal(pathIsWithin("C:\\work", "D:\\outside\\a.ts"), false);
});
