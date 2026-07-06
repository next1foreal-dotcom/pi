import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initStore, runMemoryLint, writeText } from "../src/her-core/index.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-lint-"));
	await initStore(root);
	return root;
}

async function writeSemantic(root: string, key: string, body: string, frontmatter = ""): Promise<void> {
	const header = frontmatter ? `---\n${frontmatter.trim()}\n---\n` : "";
	await writeText(join(root, "semantic", `${key}.md`), `${header}${body.trimEnd()}\n`);
}

test("runMemoryLint reports broken wikilinks", async () => {
	const store = await tempStore();
	await writeSemantic(store, "source", "# Source\n\nBroken refs: [[semantic/missing]] and [[missing-bare]].");

	const report = await runMemoryLint(store);

	assert.equal(report.status, "fail");
	assert.deepEqual(
		report.brokenLinks.map((item) => item.target),
		["missing-bare", "semantic/missing"],
	);
});

test("runMemoryLint reports orphan notes", async () => {
	const store = await tempStore();
	await writeSemantic(store, "lonely", "# Lonely\n\nNo incoming links.");

	const report = await runMemoryLint(store);

	assert.equal(report.status, "fail");
	assert.deepEqual(
		report.orphans.map((item) => item.id),
		["semantic/lonely"],
	);
});

test("runMemoryLint reports broken supersession chains", async () => {
	const store = await tempStore();
	await writeSemantic(store, "old", "# Old\n\nSuperseded note.", "status: superseded\nsuperseded_by: replacement");

	const report = await runMemoryLint(store);

	assert.equal(report.status, "fail");
	assert.deepEqual(report.supersessionIssues, [
		{
			file: "semantic/old.md",
			reason: "missing target semantic/replacement.md",
			supersededBy: "replacement",
		},
	]);
});

test("runMemoryLint passes a clean store and rewrites a stable report", async () => {
	const store = await tempStore();
	await writeSemantic(store, "a", "# A\n\nLinks to [[b]].");
	await writeSemantic(store, "b", "# B\n\nLinks to [[a]].");

	const report = await runMemoryLint(store);
	const first = await readFile(join(store, "evals", "lint.md"), "utf8");
	await rm(join(store, "evals", "lint.md"));
	const rerun = await runMemoryLint(store);
	const second = await readFile(join(store, "evals", "lint.md"), "utf8");

	assert.equal(report.status, "pass");
	assert.equal(rerun.status, "pass");
	assert.equal(first, second);
	assert.equal(report.brokenLinks.length, 0);
	assert.equal(report.orphans.length, 0);
	assert.equal(report.supersessionIssues.length, 0);
});
