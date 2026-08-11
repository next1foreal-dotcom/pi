import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { frontmatter, initStore, Memory, parseFrontmatter, readText, writeText } from "../src/her-core/index.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-organ-"));
	await initStore(root);
	return root;
}

async function seedNotes(store: string, keys: string[]): Promise<void> {
	for (const key of keys) {
		await writeText(
			join(store, "semantic", `${key}.md`),
			`${frontmatter({ type: "concept" })}# ${key}\n\nKnowledge for ${key}.\n`,
		);
	}
}

function unitKeys(prompt: string): string[] {
	return [...prompt.matchAll(/^- (unit-\d+) \(/gm)].map((match) => match[1]);
}

async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	const previous: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(overrides)) {
		previous[name] = process.env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		await fn();
	} finally {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("generateIdeas shrinks a truncated latest subset until a valid response fits", async () => {
	await withEnv({ HER_IDEAS_MAX_UNITS: "4", HER_IDEAS_MIN_UNITS: "2" }, async () => {
		const store = await tempStore();
		try {
			await seedNotes(store, ["unit-1", "unit-2", "unit-3", "unit-4", "unit-5"]);
			let calls = 0;
			const prompts: string[] = [];
			const model = {
				complete(prompt: string): string {
					calls++;
					prompts.push(prompt);
					if (unitKeys(prompt).length > 2) return '{"ideas":[{"title":"truncated';
					return JSON.stringify({
						ideas: [
							{
								title: "A fitting idea",
								connects: ["unit-5"],
								insight: "insight",
								spark: "spark",
								kind: "cross-domain",
							},
						],
					});
				},
			};

			const ideas = await new Memory(store, model).generateIdeas();

			assert.equal(calls, 2, "the first oversized response is retried with the latest half");
			assert.deepEqual(unitKeys(prompts[0]), ["unit-2", "unit-3", "unit-4", "unit-5"]);
			assert.deepEqual(unitKeys(prompts[1]), ["unit-4", "unit-5"]);
			assert.equal(ideas.length, 1);
			assert.equal(ideas[0].title, "A fitting idea");
			assert.equal((await readdir(join(store, "ideas"))).length, 1);
		} finally {
			await rm(store, { recursive: true, force: true });
		}
	});
});

test("generateIdeas records a floor skip and returns an empty list when every response truncates", async () => {
	await withEnv({ HER_IDEAS_MAX_UNITS: "4", HER_IDEAS_MIN_UNITS: "2" }, async () => {
		const store = await tempStore();
		try {
			await seedNotes(store, ["unit-1", "unit-2", "unit-3", "unit-4", "unit-5"]);
			const model = { complete: (): string => '{"ideas":[{"title":"truncated' };

			const ideas = await new Memory(store, model).generateIdeas();

			assert.deepEqual(ideas, []);
			const raw = (await readText(join(store, "audit", "organ-skips.jsonl"))) ?? "";
			const entries = raw
				.trim()
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			assert.equal(entries.length, 1);
			assert.deepEqual(entries[0].organ, "ideas");
			assert.deepEqual(entries[0].reason, "truncated-at-floor");
			assert.equal(entries[0].units, 2);
			assert.equal(entries[0].attempts, 2);
		} finally {
			await rm(store, { recursive: true, force: true });
		}
	});
});

test("buildTopicMaps batches units and merges same-slug themes with deduplicated members", async () => {
	await withEnv({ HER_TOPICS_BATCH_UNITS: "2", HER_TOPICS_MIN_BATCH_UNITS: "1" }, async () => {
		const store = await tempStore();
		try {
			await seedNotes(store, ["unit-1", "unit-2", "unit-3", "unit-4"]);
			let calls = 0;
			const model = {
				complete(): string {
					calls++;
					return JSON.stringify({
						maps: [
							{
								theme: "Shared Theme",
								summary: calls === 1 ? "first summary" : "second summary",
								members: calls === 1 ? ["unit-1", "unit-2", "unit-1"] : ["unit-2", "unit-3"],
							},
						],
					});
				},
			};

			const written = await new Memory(store, model).buildTopicMaps();

			assert.equal(calls, 2);
			assert.deepEqual(written, ["shared-theme"]);
			const topicFiles = (await readdir(join(store, "topics"))).filter((name) => name.endsWith(".md"));
			assert.deepEqual(topicFiles, ["shared-theme.md"]);
			const topic = parseFrontmatter(await readText(join(store, "topics", "shared-theme.md")));
			assert.deepEqual(topic.data.members, ["unit-1", "unit-2", "unit-3"]);
			assert.match(topic.body, /first summary/);
		} finally {
			await rm(store, { recursive: true, force: true });
		}
	});
});

test("buildTopicMaps skips a permanently truncated batch and continues with later batches", async () => {
	await withEnv({ HER_TOPICS_BATCH_UNITS: "2", HER_TOPICS_MIN_BATCH_UNITS: "1" }, async () => {
		const store = await tempStore();
		try {
			await seedNotes(store, ["unit-1", "unit-2", "unit-3", "unit-4"]);
			const model = {
				complete(prompt: string): string {
					const keys = unitKeys(prompt);
					if (keys.some((key) => key === "unit-1" || key === "unit-2")) return '{"maps":[{"theme":"truncated';
					return JSON.stringify({ maps: [{ theme: "Survives", summary: "later batch", members: keys }] });
				},
			};

			const written = await new Memory(store, model).buildTopicMaps();

			assert.deepEqual(written, ["survives"]);
			assert.ok(await readText(join(store, "topics", "survives.md")));
			assert.equal(await readText(join(store, "topics", "truncated.md")), undefined);
			const raw = (await readText(join(store, "audit", "organ-skips.jsonl"))) ?? "";
			const entries = raw
				.trim()
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			assert.equal(entries.length, 1);
			assert.equal(entries[0].organ, "topic-maps");
			assert.equal(entries[0].reason, "truncated-at-floor");
		} finally {
			await rm(store, { recursive: true, force: true });
		}
	});
});

test("small organs keep their single-call behavior", async () => {
	await withEnv(
		{
			HER_TOPICS_BATCH_UNITS: "10",
			HER_TOPICS_MIN_BATCH_UNITS: "2",
			HER_IDEAS_MAX_UNITS: "10",
			HER_IDEAS_MIN_UNITS: "2",
		},
		async () => {
			const store = await tempStore();
			try {
				await seedNotes(store, ["unit-1"]);
				let calls = 0;
				const model = {
					complete(prompt: string): string {
						calls++;
						if (prompt.includes("Group these knowledge units")) {
							return JSON.stringify({ maps: [{ theme: "One Theme", members: ["unit-1"] }] });
						}
						return JSON.stringify({ ideas: [{ title: "One Idea", kind: "unnamed-pattern" }] });
					},
				};

				await new Memory(store, model).buildTopicMaps();
				await new Memory(store, model).generateIdeas();

				assert.equal(calls, 2);
			} finally {
				await rm(store, { recursive: true, force: true });
			}
		},
	);
});

test("non-truncation model errors still propagate from both organs", async () => {
	const store = await tempStore();
	try {
		await seedNotes(store, ["unit-1"]);
		const model = {
			complete: (): string => {
				throw new Error("hard model failure");
			},
		};

		await assert.rejects(() => new Memory(store, model).buildTopicMaps(), /hard model failure/);
		await assert.rejects(() => new Memory(store, model).generateIdeas(), /hard model failure/);
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});
