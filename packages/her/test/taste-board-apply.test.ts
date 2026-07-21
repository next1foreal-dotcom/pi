import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initStore, Memory, parseFrontmatter, StorePaths } from "../src/her-core/index.ts";

async function tempStore(): Promise<StorePaths> {
	const root = await mkdtemp(join(tmpdir(), "her-taste-board-apply-"));
	await initStore(root);
	return new StorePaths(root);
}

async function writeTasteCard(paths: StorePaths, stem: string, boards: string[] = []): Promise<void> {
	const boardsBlock =
		boards.length > 0 ? ["boards:", ...boards.map((board) => `  - ${board}`)].join("\n") : "boards: []";
	const text = [
		"---",
		`id: ${stem}`,
		`title: ${stem}`,
		"source_type: taste-card",
		boardsBlock,
		"---",
		"",
		`Body ${stem}.`,
		"",
	].join("\n");
	await writeFile(join(paths.world, `${stem}.md`), text, "utf8");
}

async function writeOrdinaryNote(paths: StorePaths, stem: string): Promise<void> {
	const text = [
		"---",
		`id: ${stem}`,
		`title: ${stem}`,
		"source_type: article",
		"---",
		"",
		"Not a taste card.",
		"",
	].join("\n");
	await writeFile(join(paths.world, `${stem}.md`), text, "utf8");
}

test("applyTasteBoard tags the requested cards and leaves untouched cards byte-identical", async () => {
	const paths = await tempStore();
	await writeTasteCard(paths, "card-a", ["design"]);
	await writeTasteCard(paths, "card-b", ["design"]);
	await writeTasteCard(paths, "card-c", ["design"]);
	const untouchedBefore = await readFile(join(paths.world, "card-c.md"), "utf8");

	const memory = new Memory(paths.root);
	const resultA = await memory.applyTasteBoard("card-a", "慢出场");
	const resultB = await memory.applyTasteBoard("card-b", "慢出场");

	assert.equal(resultA.outcome, "applied");
	assert.equal(resultB.outcome, "applied");

	const parsedA = parseFrontmatter(await readFile(join(paths.world, "card-a.md"), "utf8"));
	const parsedB = parseFrontmatter(await readFile(join(paths.world, "card-b.md"), "utf8"));
	assert.deepEqual(parsedA.data.boards, ["design", "慢出场"]);
	assert.deepEqual(parsedB.data.boards, ["design", "慢出场"]);

	const untouchedAfter = await readFile(join(paths.world, "card-c.md"), "utf8");
	assert.equal(untouchedAfter, untouchedBefore);
});

test("applyTasteBoard skips a card that already carries the board without rewriting the file", async () => {
	const paths = await tempStore();
	await writeTasteCard(paths, "card-a", ["design", "慢出场"]);
	const path = join(paths.world, "card-a.md");
	const before = await readFile(path, "utf8");
	const statBefore = await stat(path);

	const memory = new Memory(paths.root);
	const result = await memory.applyTasteBoard("card-a", "慢出场");

	assert.equal(result.outcome, "skipped");
	const after = await readFile(path, "utf8");
	const statAfter = await stat(path);
	assert.equal(after, before);
	assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
});

test("applyTasteBoard rejects a non-taste-card note by name and continues with the rest", async () => {
	const paths = await tempStore();
	await writeTasteCard(paths, "card-a", ["design"]);
	await writeOrdinaryNote(paths, "plain-note");

	const memory = new Memory(paths.root);
	const okResult = await memory.applyTasteBoard("card-a", "慢出场");
	const rejectedResult = await memory.applyTasteBoard("plain-note", "慢出场");

	assert.equal(okResult.outcome, "applied");
	assert.equal(rejectedResult.outcome, "rejected");
	assert.match(rejectedResult.reason ?? "", /not a taste card/);
});

test("applyTasteBoard reports not-found for an id that does not exist", async () => {
	const paths = await tempStore();
	await writeTasteCard(paths, "card-a", ["design"]);
	const memory = new Memory(paths.root);
	const result = await memory.applyTasteBoard("no-such-card", "慢出场");
	assert.equal(result.outcome, "not-found");
});
