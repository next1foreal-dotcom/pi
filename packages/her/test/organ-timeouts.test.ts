import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	FakeModel,
	frontmatter,
	initStore,
	Memory,
	type ModelLike,
	ORGAN_MODEL_TIMEOUT_MS,
	readJson,
	readText,
	writeJson,
	writeText,
} from "../src/her-core/index.ts";

const execFileAsync = promisify(execFile);

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-organ-timeout-"));
	await initStore(root);
	return root;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execFileAsync("git", args, { cwd });
}

async function gitInit(store: string): Promise<void> {
	await git(store, "init");
	await git(store, "config", "user.name", "Her Organ Timeout Test");
	await git(store, "config", "user.email", "her-organ-timeout@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
}

async function writeRawEpisode(store: string, ts: string, id: string, body: string): Promise<void> {
	await writeText(
		join(store, "episodic", "raw", `${ts}--${id}.md`),
		["---", `id: ${id}`, `timestamp: ${ts}`, "project: her", "---", "", body, ""].join("\n"),
	);
}

async function seedNote(store: string, key: string): Promise<void> {
	await writeText(
		join(store, "semantic", `${key}.md`),
		`${frontmatter({ type: "concept" })}# ${key}\n\nKnowledge for ${key}.\n`,
	);
}

async function mdNames(dir: string): Promise<string[]> {
	return (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
}

async function stateOf(store: string): Promise<Record<string, unknown>> {
	return await readJson<Record<string, unknown>>(join(store, ".her", "state.json"), {});
}

function hangingModel(): { model: ModelLike; signal: () => AbortSignal | undefined } {
	let signal: AbortSignal | undefined;
	return {
		model: {
			complete(_prompt: string, options?: { signal?: AbortSignal }) {
				signal = options?.signal;
				return new Promise<string>(() => {});
			},
		},
		signal: () => signal,
	};
}

test("default organ model timeouts match the G-287 wall-clock table", () => {
	assert.equal(ORGAN_MODEL_TIMEOUT_MS.consolidate, 900_000);
	assert.equal(ORGAN_MODEL_TIMEOUT_MS.reflect, 600_000);
	assert.equal(ORGAN_MODEL_TIMEOUT_MS.synthesize, 900_000);
	assert.equal(ORGAN_MODEL_TIMEOUT_MS["topic-maps"], 1_200_000);
	assert.equal(ORGAN_MODEL_TIMEOUT_MS.ideas, 600_000);
});

test("reflect FakeModel NONE still advances last_reflect under a short timeout budget", async () => {
	const store = await tempStore();
	try {
		await writeRawEpisode(store, "2026-07-01T0900", "ep1", "Ordinary session.");
		const model = new FakeModel("NONE");
		const result = await new Memory(store, { model, modelTimeouts: { reflect: 50 } }).reflect();
		assert.equal(result.ran, true);
		assert.equal(result.id, undefined);
		const state = await stateOf(store);
		assert.equal(typeof state.last_reflect, "string");
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("reflect hanging model times out without advancing last_reflect", { timeout: 5000 }, async () => {
	const store = await tempStore();
	try {
		await writeRawEpisode(store, "2026-07-01T0900", "ep1", "Ordinary session.");
		const last = "2026-06-01T00:00:00.000Z";
		await writeJson(join(store, ".her", "state.json"), {
			...(await stateOf(store)),
			last_reflect: last,
		});
		const before = await stateOf(store);
		const recognitionsBefore = await mdNames(join(store, "recognitions"));
		const hang = hangingModel();
		const started = Date.now();
		await assert.rejects(
			() => new Memory(store, { model: hang.model, modelTimeouts: { reflect: 50 } }).reflect(),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /reflect/i);
				assert.match(error.message, /timed out/i);
				assert.match(error.message, /50ms/);
				return true;
			},
		);
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 2000, `timeout path hung (${elapsed}ms)`);
		assert.equal(hang.signal()?.aborted, true);
		assert.deepEqual(await stateOf(store), before);
		assert.deepEqual(await mdNames(join(store, "recognitions")), recognitionsBefore);
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("consolidate FakeModel JSON still advances the cursor under a short timeout budget", async () => {
	const store = await tempStore();
	try {
		await writeRawEpisode(store, "2026-06-03T1200", "episode-1", "Episode content.");
		const model = new FakeModel(JSON.stringify({ notes: [], moments: [] }));
		const result = await new Memory(store, { model, modelTimeouts: { consolidate: 50 } }).consolidate();
		assert.equal(result.episodes, 1);
		const state = await stateOf(store);
		assert.equal((state.cursor as { ts?: string } | null)?.ts, "2026-06-03T1200");
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test(
	"consolidate hanging model times out without advancing cursor or last_consolidate",
	{ timeout: 5000 },
	async () => {
		const store = await tempStore();
		try {
			await writeRawEpisode(store, "2026-06-03T1200", "episode-1", "must not digest");
			const before = await stateOf(store);
			const hang = hangingModel();
			const started = Date.now();
			await assert.rejects(
				() => new Memory(store, { model: hang.model, modelTimeouts: { consolidate: 50 } }).consolidate(),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.match(error.message, /consolidate/i);
					assert.match(error.message, /timed out/i);
					assert.match(error.message, /50ms/);
					return true;
				},
			);
			const elapsed = Date.now() - started;
			assert.ok(elapsed < 2000, `timeout path hung (${elapsed}ms)`);
			assert.equal(hang.signal()?.aborted, true);
			assert.deepEqual(await stateOf(store), before);
			assert.equal((await readdir(join(store, "semantic"))).filter((name) => name.endsWith(".md")).length, 0);
			assert.equal(await readText(join(store, "audit", "consolidate-skips.jsonl")), undefined);
		} finally {
			await rm(store, { recursive: true, force: true });
		}
	},
);

test("synthesize FakeModel narrative still writes under a short timeout budget", async () => {
	const store = await tempStore();
	try {
		await gitInit(store);
		await writeText(join(store, "narrative", "FACTS.md"), "Fei is the owner.\n");
		const model = new FakeModel("# CONTEXT\n\nFei values verified execution.\n");
		const proposalId = await new Memory(store, { model, modelTimeouts: { synthesize: 50 } }).synthesize();
		const today = new Date().toISOString().slice(0, 10);
		assert.equal(proposalId, `${today}-narrative-update`);
		assert.match((await readText(join(store, "proposals", `${proposalId}.md`))) ?? "", /verified execution/);
		const state = await stateOf(store);
		assert.equal(typeof state.last_synthesize, "string");
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("synthesize hanging model times out without writing proposal or last_synthesize", { timeout: 5000 }, async () => {
	const store = await tempStore();
	try {
		const last = "2026-06-01T00:00:00.000Z";
		await writeJson(join(store, ".her", "state.json"), {
			...(await stateOf(store)),
			last_synthesize: last,
		});
		const before = await stateOf(store);
		const contextBefore = await readText(join(store, "narrative", "CONTEXT.md"));
		const hang = hangingModel();
		const started = Date.now();
		await assert.rejects(
			() => new Memory(store, { model: hang.model, modelTimeouts: { synthesize: 50 } }).synthesize(),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /synthesize/i);
				assert.match(error.message, /timed out/i);
				assert.match(error.message, /50ms/);
				return true;
			},
		);
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 2000, `timeout path hung (${elapsed}ms)`);
		assert.equal(hang.signal()?.aborted, true);
		assert.deepEqual(await stateOf(store), before);
		assert.equal(await readText(join(store, "narrative", "CONTEXT.md")), contextBefore);
		assert.deepEqual(await mdNames(join(store, "proposals")), []);
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("buildTopicMaps FakeModel JSON still writes under a short timeout budget", async () => {
	const store = await tempStore();
	try {
		await seedNote(store, "verification");
		const model = new FakeModel(
			JSON.stringify({
				maps: [{ theme: "Verification Practice", summary: "Machine truth.", members: ["verification"] }],
			}),
		);
		const written = await new Memory(store, { model, modelTimeouts: { "topic-maps": 50 } }).buildTopicMaps();
		assert.deepEqual(written, ["verification-practice"]);
		assert.match((await readText(join(store, "topics", "verification-practice.md"))) ?? "", /Machine truth/);
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("buildTopicMaps hanging model times out without writing topic files", { timeout: 5000 }, async () => {
	const store = await tempStore();
	try {
		await seedNote(store, "verification");
		const before = await stateOf(store);
		const topicsBefore = await mdNames(join(store, "topics"));
		const hang = hangingModel();
		const started = Date.now();
		await assert.rejects(
			() => new Memory(store, { model: hang.model, modelTimeouts: { "topic-maps": 50 } }).buildTopicMaps(),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /topic-maps/i);
				assert.match(error.message, /timed out/i);
				assert.match(error.message, /50ms/);
				return true;
			},
		);
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 2000, `timeout path hung (${elapsed}ms)`);
		assert.equal(hang.signal()?.aborted, true);
		assert.deepEqual(await stateOf(store), before);
		assert.deepEqual(await mdNames(join(store, "topics")), topicsBefore);
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("generateIdeas FakeModel JSON still writes under a short timeout budget", async () => {
	const store = await tempStore();
	try {
		await seedNote(store, "verification");
		const model = new FakeModel(
			JSON.stringify({
				ideas: [
					{
						title: "Verification as intimacy",
						connects: ["verification"],
						insight: "Care as proof.",
						spark: "Prove what changed.",
						kind: "cross-domain",
					},
				],
			}),
		);
		const ideas = await new Memory(store, { model, modelTimeouts: { ideas: 50 } }).generateIdeas();
		assert.equal(ideas.length, 1);
		assert.equal(ideas[0].title, "Verification as intimacy");
		assert.equal((await mdNames(join(store, "ideas"))).length, 1);
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("generateIdeas hanging model times out without writing idea files", { timeout: 5000 }, async () => {
	const store = await tempStore();
	try {
		await seedNote(store, "verification");
		const before = await stateOf(store);
		const ideasBefore = await mdNames(join(store, "ideas"));
		const hang = hangingModel();
		const started = Date.now();
		await assert.rejects(
			() => new Memory(store, { model: hang.model, modelTimeouts: { ideas: 50 } }).generateIdeas(),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /ideas/i);
				assert.match(error.message, /timed out/i);
				assert.match(error.message, /50ms/);
				return true;
			},
		);
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 2000, `timeout path hung (${elapsed}ms)`);
		assert.equal(hang.signal()?.aborted, true);
		assert.deepEqual(await stateOf(store), before);
		assert.deepEqual(await mdNames(join(store, "ideas")), ideasBefore);
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});
