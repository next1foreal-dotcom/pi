import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	initStore,
	Memory,
	parseFrontmatter,
	readJson,
	readText,
	SEED_CONTEXT,
	writeText,
} from "../src/her-core/index.ts";

const meta = { timestamp: "2026-06-02T2330", sessionId: "sess01", project: "her" };

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-ts-"));
	await initStore(root);
	return root;
}

const fakeModel = {
	complete() {
		return "- what: built X\n- decisions: chose Y\n- signals: prefers Z";
	},
};

test("capture writes raw and daily summary", async () => {
	const store = await tempStore();
	const memory = new Memory(store, fakeModel);
	const id = await memory.capture("I worked on the memory layer today.", meta);
	assert.equal(id, "sess01");

	const raw = await readText(join(store, "episodic", "raw", "2026-06-02T2330--sess01.md"));
	const parsed = parseFrontmatter(raw);
	assert.equal(parsed.data.id, "sess01");
	assert.match(parsed.body, /memory layer/);

	const daily = await readText(join(store, "episodic", "2026-06-02.md"));
	assert.match(daily ?? "", /## sess01/);
	assert.match(daily ?? "", /project: her/);
	assert.match(daily ?? "", /prefers Z/);
	assert.match(daily ?? "", /summary_pending: false/);
});

test("capture preserves raw when summary fails", async () => {
	const store = await tempStore();
	const memory = new Memory(store, {
		complete() {
			throw new Error("model down");
		},
	});
	await memory.capture("important raw content", meta);
	assert.match((await readText(join(store, "episodic", "raw", "2026-06-02T2330--sess01.md"))) ?? "", /important/);
	assert.match((await readText(join(store, "episodic", "2026-06-02.md"))) ?? "", /summary_pending: true/);
});

test("getContext returns seed context and facts", async () => {
	const store = await tempStore();
	const context = await new Memory(store).getContext();
	assert.equal(context.context, SEED_CONTEXT);
	assert.equal(context.facts, "");

	await writeText(join(store, "narrative", "FACTS.md"), "Fei is the owner.\n");
	assert.match((await new Memory(store).getContext()).facts, /Fei/);
});

test("readJson tolerates UTF-8 BOM in existing memory files", async () => {
	const store = await tempStore();
	await writeText(join(store, ".her", "seen.json"), '\uFEFF{"hash":"note"}\n');
	assert.deepEqual(await readJson(join(store, ".her", "seen.json"), {}), { hash: "note" });
});

test("recall searches markdown corpus", async () => {
	const store = await tempStore();
	await writeText(join(store, "semantic", "own-memory.md"), "# Own memory\n\nBorrow the harness, own memory.\n");
	const hits = await new Memory(store).recall("harness memory");
	assert.equal(hits[0]?.id, "semantic/own-memory");
});

test("writeIdea stores subagent ideas in ideas namespace", async () => {
	const store = await tempStore();
	const id = await new Memory(store).writeIdea({
		title: "Mirror should wait for purpose",
		content: "Surface memory only when it changes the next action.",
		connections: ["memory-is-purpose", "her-system"],
		source: "idea-engine",
	});

	const files = await import("node:fs/promises").then((fs) => fs.readdir(join(store, "ideas")));
	assert.equal(files.length, 1);
	const text = (await readText(join(store, "ideas", files[0]))) ?? "";
	const parsed = parseFrontmatter(text);
	assert.equal(parsed.data.id, id);
	assert.equal(parsed.data.source, "idea-engine");
	assert.match(parsed.body, /Surface memory only/);
	assert.match(parsed.body, /\[\[memory-is-purpose\]\]/);
});

test("surface returns relevant memory with per-session cooldown and dedupe", async () => {
	const store = await tempStore();
	await writeText(join(store, "semantic", "mirror.md"), "# Mirror\n\nMirror should wait for purpose.\n");
	await writeText(join(store, "semantic", "memory.md"), "# Memory\n\nMemory is retained consequence.\n");
	const memory = new Memory(store);

	const first = await memory.surface({ query: "Mirror purpose", sessionId: "s1", cooldownMinutes: 0 });
	assert.equal(first?.id, "semantic/mirror");
	const second = await memory.surface({ query: "Mirror purpose", sessionId: "s1", cooldownMinutes: 0 });
	assert.notEqual(second?.id, first?.id);
	const blocked = await memory.surface({ query: "Memory", sessionId: "s2", cooldownMinutes: 30 });
	assert.ok(blocked);
	assert.equal(await memory.surface({ query: "Mirror", sessionId: "s2", cooldownMinutes: 30 }), undefined);
});

test("writeWorldNote writes contract sections and dedupes by content hash", async () => {
	const store = await tempStore();
	const memory = new Memory(store);
	const data = {
		title: "Agent Tool Throughput",
		sourceUrl: "https://example.com/agent-tools",
		sourceType: "article",
		contentHash: "hash-123",
		memoryStatus: "active" as const,
		extracted: "Agents call tools often.",
		coverage: "Read full article. Nothing skipped.",
		read: "The useful point is tool-call overhead.",
		steal: ["Measure per-call overhead"],
		connections: ["own-memory"],
		take: "Worth stealing for Samantha evals.",
		possibleMoves: ["Add a throughput eval"],
	};

	const first = await memory.writeWorldNote(data);
	const second = await memory.writeWorldNote(data);
	assert.equal(first, second);
	assert.deepEqual(await readJson(join(store, ".her", "seen.json"), {}), { "hash-123": first });

	const files = await import("node:fs/promises").then((fs) => fs.readdir(join(store, "world")));
	assert.equal(files.length, 1);
	const text = (await readText(join(store, "world", files[0]))) ?? "";
	assert.match(text, /## Coverage/);
	assert.match(text, /Nothing skipped/);
	assert.match(text, /## Judgment Trail/);
});

test("judgment and memory status update existing world note", async () => {
	const store = await tempStore();
	const memory = new Memory(store);
	const id = await memory.writeWorldNote({
		title: "Mirror Timing",
		sourceUrl: "https://example.com/mirror",
		sourceType: "article",
		contentHash: "hash-456",
		memoryStatus: "needs_deep_read",
		extracted: "Mirror should wait.",
		coverage: "Orientation only.",
		read: "Timing matters.",
		steal: [],
		connections: [],
		take: "Needs deeper pass.",
		possibleMoves: [],
	});

	await memory.recordJudgment(id, { attraction: "timing", correction: "Do not over-trigger Mirror" });
	await memory.setMemoryStatus(id, "archive_only", "Useful but not urgent.");

	const text = (await readText(join(store, "world", "mirror-timing.md"))) ?? "";
	const parsed = parseFrontmatter(text);
	assert.equal(parsed.data.memory_status, "archive_only");
	assert.match(parsed.body, /attraction: timing/);
	assert.match(parsed.body, /correction: Do not over-trigger Mirror/);
	assert.match(parsed.body, /reason: Useful but not urgent/);
});
