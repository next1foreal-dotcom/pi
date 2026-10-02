import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathIsWithin, sideChatToolViolation } from "../src/side-chat-guard.ts";

async function fixture(t: TestContext): Promise<{ root: string; outside: string }> {
	const base = await mkdtemp(join(tmpdir(), "her-side-chat-"));
	t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
	const root = join(base, "work");
	const outside = join(base, "work-other");
	await mkdir(join(root, "src"), { recursive: true });
	await mkdir(outside);
	await writeFile(join(root, "src", "a.ts"), "// source\n");
	await writeFile(join(outside, "secret.txt"), "synthetic fixture only\n");
	return { root, outside };
}

// PR #10: native, real filesystem fixtures replace Windows-only strings on POSIX.
// The production guard remains unchanged; permissions are not widened to make tests pass.
test("side chat allows only read tools inside the canonical workspace", async (t) => {
	const { root, outside } = await fixture(t);
	assert.equal(await sideChatToolViolation(root, "read", { path: join("src", "a.ts") }), null);
	assert.equal(
		await sideChatToolViolation(root, "read", { path: join(outside, "secret.txt") }),
		`path ${join(outside, "secret.txt")} escapes the authorized workspace`,
	);
	assert.equal(
		await sideChatToolViolation(root, "write", { path: "a.ts" }),
		"tool write is not read-only",
	);
});

test("path containment rejects siblings and accepts the root", () => {
	const root = resolve(tmpdir(), "her-containment", "work");
	assert.equal(pathIsWithin(root, root), true);
	assert.equal(pathIsWithin(root, join(root, "src", "a.ts")), true);
	assert.equal(pathIsWithin(root, `${root}-other`), false);
	assert.equal(pathIsWithin(root, resolve(root, "..", "secret")), false);
	assert.equal(pathIsWithin(root, parse(root).root), false);
});

test("side chat checks real symlink or junction destinations instead of their apparent paths", async (t) => {
	const { root, outside } = await fixture(t);
	await symlink(outside, join(root, "link-out"), "junction");
	await symlink(join(root, "src"), join(root, "link-in"), "junction");
	const escaped = join("link-out", "secret.txt");
	assert.equal(
		await sideChatToolViolation(root, "read", { path: escaped }),
		`path ${escaped} escapes the authorized workspace`,
	);
	assert.equal(await sideChatToolViolation(root, "read", { path: join("link-in", "a.ts") }), null);
});

test("side chat keeps its four read-only tools scoped, including default directory reads", async (t) => {
	const { root, outside } = await fixture(t);
	for (const tool of ["read", "grep", "find", "ls"]) {
		assert.equal(await sideChatToolViolation(root, tool, {}), null);
		assert.match((await sideChatToolViolation(root, tool, { path: outside }))!, /escapes/);
	}
	for (const tool of ["write", "edit", "bash", "powershell", "codemode", "unknown"]) {
		assert.equal(await sideChatToolViolation(root, tool, {}), `tool ${tool} is not read-only`);
	}
});

test("side chat fails closed on missing paths and canonicalization errors", async (t) => {
	const { root } = await fixture(t);
	assert.match((await sideChatToolViolation(root, "read", { path: "missing.ts" }))!, /could not be verified/);
	const unavailable = async (): Promise<string> => {
		throw new Error("fixture canonicalization failure");
	};
	assert.match((await sideChatToolViolation(root, "read", {}, unavailable))!, /could not be verified/);
});

test("side chat resolves against the tool cwd while enforcing the original authorized root", async (t) => {
	const { root, outside } = await fixture(t);
	assert.equal(await sideChatToolViolation(root, "read", { path: "a.ts" }, realpath, join(root, "src")), null);
	assert.equal(await sideChatToolViolation(root, "ls", { path: ".." }, realpath, join(root, "src")), null);
	assert.match((await sideChatToolViolation(root, "read", { path: "secret.txt" }, realpath, outside))!, /escapes/);
});
