import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
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
const execFileAsync = promisify(execFile);

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-ts-"));
	await initStore(root);
	return root;
}

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
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

test("capture redacts secrets before writing raw or summarizing", async () => {
	const store = await tempStore();
	let prompt = "";
	const memory = new Memory(store, {
		complete(input) {
			prompt = input;
			return "- captured safely";
		},
	});

	const deepseekKey = `sk-${"123456789012345678901234"}`;
	const apiKey = "abc123-secret";
	const githubToken = `ghp_${"1234567890abcdefghijklmnopqrstuvwxyz"}`;
	const googleKey = `AIza${"1234567890abcdefghijklmnopqrstuvwxyz"}`;
	const bearer = `${"Bearer"} ${"token-secret"}`;
	const privateKeyHeader = `-----BEGIN ${"PRIVATE"} KEY-----`;
	const privateKeyFooter = `-----END ${"PRIVATE"} KEY-----`;
	const raw = `DeepSeek ${deepseekKey}
api_key = ${apiKey}
${githubToken}
Authorization: ${bearer}
${googleKey}
${privateKeyHeader}
abc123
${privateKeyFooter}`;
	await memory.capture(raw, meta);

	const text = (await readText(join(store, "episodic", "raw", "2026-06-02T2330--sess01.md"))) ?? "";
	for (const leaked of [
		deepseekKey,
		apiKey,
		githubToken.slice(0, 14),
		bearer,
		googleKey.slice(0, 14),
		`${"BEGIN"} PRIVATE KEY`,
	]) {
		assert.doesNotMatch(text, new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(prompt, new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.match(text, /«REDACTED:secret»/);
	assert.match(prompt, /«REDACTED:secret»/);
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

test("sync commits and pushes memory changes", async () => {
	const store = await tempStore();
	const remote = await mkdtemp(join(tmpdir(), "her-remote-"));
	await git(remote, "init", "--bare");
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await git(store, "branch", "-M", "master");
	await git(store, "remote", "add", "origin", remote);
	await git(store, "push", "-u", "origin", "master");

	await new Memory(store).remember("Sync this new semantic note.", "note");
	const result = await new Memory(store).sync("memory(sync): test");

	assert.equal(result.status, "pushed");
	assert.match(result.commit ?? "", /^[0-9a-f]{7,40}$/);
	assert.equal((await git(store, "status", "--porcelain")).stdout.trim(), "");
	assert.match((await git(remote, "log", "--oneline", "-1")).stdout, /memory\(sync\): test/);
});

test("consolidate distills raw episodes into typed semantic notes and moments", async () => {
	const store = await tempStore();
	const memory = new Memory(store, {
		complete() {
			return JSON.stringify({
				notes: [
					{
						key: "verification-over-reassurance",
						type: "opinion",
						title: "Verification over reassurance",
						content: "Fei trusts machine truth more than soothing summaries.",
						relations: [{ to: "agent-work-style", rel: "proves" }],
						sources: ["episode-1"],
					},
				],
				moments: [{ trigger: "debugging confusion", shift: "Samantha should report verified state first" }],
			});
		},
	});
	await memory.capture("We verified the real state before reporting.", {
		timestamp: "2026-06-03T1200",
		sessionId: "episode-1",
		project: "her",
	});

	const result = await memory.consolidate();

	assert.deepEqual(result, { episodes: 1, notesTouched: 1, moments: 1 });
	const note = (await readText(join(store, "semantic", "verification-over-reassurance.md"))) ?? "";
	const parsed = parseFrontmatter(note);
	assert.equal(parsed.data.type, "opinion");
	assert.deepEqual(parsed.data.sources, ["episode-1"]);
	assert.deepEqual(parsed.data.relations, [{ to: "agent-work-style", rel: "proves" }]);
	assert.match(parsed.body, /Fei trusts machine truth/);
	assert.match((await readText(join(store, "narrative", "becoming-moments.md"))) ?? "", /Samantha should report/);
	assert.equal((await readJson<{ cursor?: string }>(join(store, ".her", "state.json"), {})).cursor, "2026-06-03T1200");
});

test("synthesize writes a proposal with FACTS and approve promotes it to CONTEXT", async () => {
	const store = await tempStore();
	const prompts: Array<{ prompt: string; strong: boolean }> = [];
	const memory = new Memory(store, {
		complete(prompt, options) {
			prompts.push({ prompt, strong: options?.strong === true });
			return "# CONTEXT\n\nFei values verified execution.\n";
		},
	});
	await writeText(join(store, "semantic", "verification.md"), "# Verification\n\nMachine truth first.\n");
	await writeText(join(store, "narrative", "becoming-moments.md"), "- 2026-06-03 · shift: calmer execution\n");
	await writeText(join(store, "narrative", "FACTS.md"), "Fei is the owner.\n");

	const proposalId = await memory.synthesize();
	await memory.approve(proposalId);

	assert.equal(proposalId, "2026-06-04-narrative-update");
	assert.match((await readText(join(store, "proposals", `${proposalId}.md`))) ?? "", /verified execution/);
	assert.match((await readText(join(store, "narrative", "CONTEXT.md"))) ?? "", /verified execution/);
	assert.equal(prompts[0].strong, true);
	assert.match(prompts[0].prompt, /GROUND-TRUTH FACTS/);
	assert.match(prompts[0].prompt, /Fei is the owner/);
});

test("buildTopicMaps and generateIdeas write derived markdown surfaces", async () => {
	const store = await tempStore();
	let call = 0;
	const memory = new Memory(store, {
		complete() {
			call++;
			if (call === 1) {
				return JSON.stringify({
					maps: [
						{
							theme: "Verification Practice",
							summary: "Machine truth before closure.",
							members: ["verification"],
						},
					],
				});
			}
			return JSON.stringify({
				ideas: [
					{
						title: "Verification as intimacy",
						connects: ["verification"],
						insight: "Reliability can be a relational signal.",
						spark: "Make every close-out prove what changed.",
						kind: "self-x-world",
					},
				],
			});
		},
	});
	await writeText(
		join(store, "semantic", "verification.md"),
		"---\ntype: opinion\n---\n# Verification\n\nMachine truth first.\n",
	);

	assert.deepEqual(await memory.buildTopicMaps(), ["verification-practice"]);
	const ideas = await memory.generateIdeas();

	assert.equal(ideas[0].title, "Verification as intimacy");
	assert.match((await readText(join(store, "topics", "verification-practice.md"))) ?? "", /Machine truth/);
	const ideaFiles = await import("node:fs/promises").then((fs) => fs.readdir(join(store, "ideas")));
	assert.equal(ideaFiles.length, 1);
	assert.match((await readText(join(store, "ideas", ideaFiles[0]))) ?? "", /Reliability can be/);
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
