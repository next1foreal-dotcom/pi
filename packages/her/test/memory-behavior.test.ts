import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initStore, Memory, writeText } from "../src/her-core/index.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-memory-behavior-"));
	await initStore(root);
	return root;
}

test("aliases and a one-edit typo recall the same durable memory", async () => {
	const root = await tempStore();
	await writeText(
		join(root, "semantic", "dining.md"),
		"---\naliases:\n  - pasta\n  - takeout\n  - delivery\n---\n# Dining Preference\n\nFei prefers pasta for dinner.\n",
	);
	const memory = new Memory(root);
	assert.equal(
		(await memory.recall("takeout dinner", { recordAccess: false, privacy: "private" }))[0]?.id,
		"semantic/dining",
	);
	assert.equal(
		(await memory.recall("delivery dinner", { recordAccess: false, privacy: "private" }))[0]?.id,
		"semantic/dining",
	);
	assert.equal((await memory.recall("pazta", { recordAccess: false, privacy: "private" }))[0]?.id, "semantic/dining");
});

test("expired and superseded memories leave normal recall but remain in history", async () => {
	const root = await tempStore();
	await writeText(
		join(root, "semantic", "weekend-exam.md"),
		"---\nvalid_until: 2020-01-01T00:00:00.000Z\n---\n# Weekend Exam\n\nBring the blue admission card.\n",
	);
	await writeText(
		join(root, "semantic", "old-provider.md"),
		"---\nstatus: superseded\n---\n# Old Provider\n\nUse the retired cobalt route.\n",
	);
	const memory = new Memory(root);
	assert.equal((await memory.recall("blue admission card", { recordAccess: false, privacy: "private" })).length, 0);
	assert.equal((await memory.recall("retired cobalt route", { recordAccess: false, privacy: "private" })).length, 0);
	assert.equal((await memory.recallArchive("blue admission card"))[0]?.id, "history/semantic/weekend-exam");
	assert.equal((await memory.recallArchive("retired cobalt route"))[0]?.id, "history/semantic/old-provider");
});
