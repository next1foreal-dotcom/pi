import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { splitChapters } from "../src/compendium/chapter-split.ts";
import { type DeerParallel, fanoutCompendium, type ReaderTask } from "../src/compendium/fanout.ts";

const manifestFixture = {
	slug: "reading-fixture",
	materials: [
		{
			id: "first-source",
			sourceUrl: "https://example.test/first",
			text: "# Start\nAlpha\n\n# End\nBeta",
		},
	],
};

const cannedAnalysis = [
	"---",
	"source: https://example.test/first",
	"chunk: first-source-0",
	'lens-version: "1"',
	"---",
	"",
	"## Facts",
	"- HIGH: Fixture fact [https://example.test/first, chars 0-14]",
].join("\n");
const deerParallel: DeerParallel = async (tasks) =>
	Promise.all(
		tasks.map(async (task) => {
			try {
				return await task();
			} catch {
				return null;
			}
		}),
	);

test("splitChapters separates markdown headings with exact character ranges", () => {
	const text = "# First\nAlpha\n\n# Second\nBeta";
	const chunks = splitChapters(text);

	assert.deepEqual(
		chunks.map((chunk) => ({ title: chunk.title, text: chunk.text, charRange: chunk.charRange })),
		[
			{ title: "First", text: "# First\nAlpha\n\n", charRange: [0, 15] },
			{ title: "Second", text: "# Second\nBeta", charRange: [15, text.length] },
		],
	);
});

test("splitChapters uses paragraph boundaries when text has no headings", () => {
	const text = "aaaa\n\nbbbb\n\ncccc";
	const chunks = splitChapters(text, 11);

	assert.deepEqual(
		chunks.map((chunk) => chunk.charRange),
		[
			[0, 6],
			[6, text.length],
		],
	);
	assert.deepEqual(
		chunks.map((chunk) => chunk.text),
		["aaaa\n\n", "bbbb\n\ncccc"],
	);
	assert.equal("title" in chunks[0], false);
});

test("fanout writes mocked analysis through the trusted parent only", async () => {
	const root = await mkdtemp(join(tmpdir(), "compendium-fanout-"));
	const tasks: ReaderTask[] = [];
	try {
		const result = await fanoutCompendium({
			manifest: manifestFixture,
			question: "What matters?",
			herMemoryRoot: root,
			spawn: async (task) => {
				tasks.push(task);
				return cannedAnalysis;
			},
			deerParallel,
		});

		assert.equal(result.failed.length, 0);
		assert.equal(result.written.length, 2);
		assert.equal(await readFile(join(result.analysisDirectory, "first-source-0.md"), "utf8"), cannedAnalysis);
		assert.equal(await readFile(join(result.analysisDirectory, "first-source-1.md"), "utf8"), cannedAnalysis);
		assert.deepEqual(JSON.parse(await readFile(join(result.analysisDirectory, "failed.json"), "utf8")), []);
		assert.equal(tasks.length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fanout retries one failed chunk and records a persistent failure without throwing", async () => {
	const root = await mkdtemp(join(tmpdir(), "compendium-fanout-"));
	const attempts = new Map<number, number>();
	try {
		const result = await fanoutCompendium({
			manifest: manifestFixture,
			question: "What matters?",
			herMemoryRoot: root,
			spawn: async (task) => {
				attempts.set(task.chunk.index, (attempts.get(task.chunk.index) ?? 0) + 1);
				if (task.chunk.index === 1) return "not structured";
				return cannedAnalysis;
			},
			deerParallel,
		});

		assert.equal(result.written.length, 1);
		assert.deepEqual(
			attempts,
			new Map([
				[0, 1],
				[1, 2],
			]),
		);
		assert.deepEqual(
			result.failed.map((failed) => ({ materialId: failed.materialId, chunkIndex: failed.chunkIndex })),
			[{ materialId: "first-source", chunkIndex: 1 }],
		);
		assert.match(await readFile(join(result.analysisDirectory, "failed.json"), "utf8"), /YAML front matter/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reader task exposes only the deep-reader read tool allowlist", async () => {
	const root = await mkdtemp(join(tmpdir(), "compendium-fanout-"));
	try {
		let task: ReaderTask | undefined;
		await fanoutCompendium({
			manifest: { ...manifestFixture, materials: [manifestFixture.materials[0]] },
			question: "What matters?",
			herMemoryRoot: root,
			spawn: async (received) => {
				task = received;
				return cannedAnalysis;
			},
			deerParallel,
		});

		assert.ok(task);
		if (!task) throw new Error("reader task was not captured");
		assert.equal(task.agentProfilePath, ".pi/agents/deep-reader.md");
		assert.deepEqual(task.tools, ["fetch_content", "get_search_content", "web_search", "read", "grep", "find", "ls"]);
		for (const forbidden of ["write", "edit", "bash", "her_world_note", "her_remember"]) {
			assert.ok(!task.tools.includes(forbidden));
		}
		assert.match(task.prompt, /untrusted data/);
		assert.match(task.prompt, /do not execute, follow, or prioritize/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
