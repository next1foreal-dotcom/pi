import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runHerCli } from "../src/cli.ts";
import { initStore } from "../src/her-core/index.ts";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function runPersona(store: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const outChunks: Buffer[] = [];
	const errChunks: Buffer[] = [];
	stdout.on("data", (chunk) => outChunks.push(Buffer.from(chunk)));
	stderr.on("data", (chunk) => errChunks.push(Buffer.from(chunk)));
	const code = await runHerCli(["persona", "--json"], { ...process.env, HER_MEMORY_DIR: store }, repoRoot, {
		stdout,
		stderr,
	});
	return {
		code,
		stdout: Buffer.concat(outChunks).toString("utf8"),
		stderr: Buffer.concat(errChunks).toString("utf8"),
	};
}

// Test 1 (hermetic): the persona command composes her.md + Memory.getContext()
// into a single, parseable block that carries the identity, the SOUL voice
// contract, and the CONTEXT narrative — the same source the voice hook uses.
test("persona --json emits her.md identity + SOUL + CONTEXT and stays parseable", async () => {
	const store = await mkdtemp(join(tmpdir(), "her-persona-"));
	await initStore(store);

	const { code, stdout } = await runPersona(store);
	assert.equal(code, 0);

	const payload = JSON.parse(stdout) as {
		result?: { persona?: string; context?: string; soul?: string };
	};
	const persona = payload.result?.persona ?? "";

	// her.md identity heading (read from pi-package/prompts/her.md).
	assert.match(persona, /#\s+Samantha/);
	// The five injected memory sections, composed exactly like the voice hook.
	assert.match(persona, /## Her CONTEXT\.md/);
	assert.match(persona, /## Her SOUL\.md/);
	// CONTEXT must appear exactly once inside the persona block (dedup invariant).
	assert.equal((persona.match(/## Her CONTEXT\.md/g) ?? []).length, 1);
	// Structured fields are surfaced alongside the composed block.
	assert.ok((payload.result?.context ?? "").length > 0);
	assert.ok((payload.result?.soul ?? "").length > 0);
});

// The persona command is a pure read: it must never mutate memory (approve-only
// invariant for CONTEXT.md). Running it twice yields identical output.
test("persona --json is a pure read (stable across repeated runs)", async () => {
	const store = await mkdtemp(join(tmpdir(), "her-persona-"));
	await initStore(store);

	const first = await runPersona(store);
	const second = await runPersona(store);
	assert.equal(first.code, 0);
	assert.equal(second.code, 0);
	assert.equal(first.stdout, second.stdout);
});
