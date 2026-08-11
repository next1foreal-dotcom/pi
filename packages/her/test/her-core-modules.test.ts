import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { DEFAULT_CONFIG, loadConfig, renderConfig } from "../src/her-core/config.ts";
import { createEmbeddingSearch } from "../src/her-core/embedding-search.ts";
import { initStore, Memory, readJson, readText, writeText } from "../src/her-core/index.ts";
import {
	completeJson,
	extractJson,
	JsonExtractError,
	JsonMalformedError,
	JsonTruncatedError,
	looksTruncated,
	stripCodeFence,
} from "../src/her-core/memory-utils.ts";
import { FakeModel, OpenAICompatibleModel } from "../src/her-core/model.ts";
import { validateMemoryProvenance } from "../src/her-core/privacy.ts";
import {
	choiceModelPrompt,
	consolidatePrompt,
	selfNarrativePrompt,
	summaryPrompt,
	surfacePrompt,
	synthesizePrompt,
} from "../src/her-core/prompts.ts";
import { isTransientFsContention, retryOnFsContention } from "../src/her-core/store.ts";
import { isLockContention } from "../src/her-core/store-lock.ts";

test("isLockContention classifies lock create contention errors", () => {
	const withCode = (code: string): Error & { code: string } => Object.assign(new Error(), { code });

	assert.equal(isLockContention(withCode("EEXIST")), true);
	assert.equal(isLockContention(withCode("EPERM")), true);
	assert.equal(isLockContention(withCode("ENOENT")), false);
	assert.equal(isLockContention(undefined), false);
	assert.equal(isLockContention(new Error("missing code")), false);
});

test("isTransientFsContention classifies transient Windows fs contention errors", () => {
	const withCode = (code: string): Error & { code: string } => Object.assign(new Error(), { code });

	assert.equal(isTransientFsContention(withCode("EPERM")), true);
	assert.equal(isTransientFsContention(withCode("EACCES")), true);
	assert.equal(isTransientFsContention(withCode("EBUSY")), true);
	assert.equal(isTransientFsContention(withCode("ENOENT")), false);
	assert.equal(isTransientFsContention(withCode("ENOSPC")), false);
	assert.equal(isTransientFsContention(undefined), false);
	assert.equal(isTransientFsContention(null), false);
	assert.equal(isTransientFsContention(new Error("missing code")), false);
});

test("retryOnFsContention retries transient errors and returns on success", async () => {
	let calls = 0;
	const eperm = (): Error & { code: string } => Object.assign(new Error("EPERM"), { code: "EPERM" });
	const result = await retryOnFsContention(
		async () => {
			calls++;
			if (calls < 3) throw eperm();
			return "ok";
		},
		{ attempts: 5, baseDelayMs: 1, label: "test-retry-success" },
	);
	assert.equal(result, "ok");
	assert.equal(calls, 3, "op called exactly 3 times: 2 transient failures + 1 success");
});

test("retryOnFsContention exhausts attempts then throws the original error object", async () => {
	let calls = 0;
	const original = Object.assign(new Error("EPERM"), { code: "EPERM" });
	await assert.rejects(
		() =>
			retryOnFsContention(
				async () => {
					calls++;
					throw original;
				},
				{ attempts: 3, baseDelayMs: 1, label: "test-retry-exhaust" },
			),
		(thrown: unknown) => {
			assert.equal(thrown, original, "must throw the original error object, not a wrapper");
			return true;
		},
	);
	assert.equal(calls, 3, "op called exactly attempts times");
});

test("retryOnFsContention does not retry non-transient errors", async () => {
	let calls = 0;
	const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	await assert.rejects(
		() =>
			retryOnFsContention(
				async () => {
					calls++;
					throw enoent;
				},
				{ attempts: 5, baseDelayMs: 1, label: "test-no-retry" },
			),
		(thrown: unknown) => {
			assert.equal(thrown, enoent);
			return true;
		},
	);
	assert.equal(calls, 1, "non-transient error must not be retried");
});

test("prompts preserve Python memory operation contracts", () => {
	assert.match(summaryPrompt("raw session"), /exactly these fields/);
	assert.match(summaryPrompt("raw session"), /- what:/);
	assert.match(consolidatePrompt("[episode] text", ["existing-key"]), /TYPED units/);
	assert.match(
		consolidatePrompt("[episode] text", ["existing-key"]),
		/question \| concept \| opinion \| case \| solution/,
	);
	assert.match(synthesizePrompt("current", "notes", "moments", "Fei is the owner."), /GROUND-TRUTH FACTS/);
	assert.match(
		synthesizePrompt("current", "notes", "moments", "Fei is the owner.", "Soul seed", "Samantha self", "Choice rule"),
		/SOUL SEED/,
	);
	assert.match(
		synthesizePrompt("current", "notes", "moments", "Fei is the owner.", "Soul seed", "Samantha self", "Choice rule"),
		/SAMANTHA SELF-NARRATIVE/,
	);
	assert.match(
		synthesizePrompt("current", "notes", "moments", "Fei is the owner.", "Soul seed", "Samantha self", "Choice rule"),
		/CHOICE MODEL/,
	);
	assert.match(choiceModelPrompt("current choice", "correction: choose smaller reversible moves"), /JUDGMENT TRAILS/);
	assert.match(choiceModelPrompt("current choice", "correction: choose smaller reversible moves"), /current choice/);
	assert.match(
		selfNarrativePrompt("current self", "context", "Samantha should report verified state", "recognition"),
		/SAMANTHA SELF-EVIDENCE/,
	);
	assert.match(
		selfNarrativePrompt("current self", "context", "Samantha should report verified state", "recognition"),
		/current self/,
	);
	assert.match(surfacePrompt("recent", "existing"), /reply with exactly: NONE/);
});

test("extractJson repairs an illegal \\C escape from a Windows path in a string value", () => {
	const bad = String.raw`{"path": "C:\WindowsApps\Claude", "ok": true}`;
	const result = extractJson<{ path: string; ok: boolean }>(bad);
	assert.equal(result.path, String.raw`C:\WindowsApps\Claude`);
	assert.equal(result.ok, true);
});

test("extractJson repairs an illegal \\' escape from a quoted shell arg", () => {
	const bad = String.raw`{"cmd": "Get-Process \'cowork-svc\'", "ok": true}`;
	const result = extractJson<{ cmd: string; ok: boolean }>(bad);
	assert.equal(result.cmd, String.raw`Get-Process \'cowork-svc\'`);
	assert.equal(result.ok, true);
});

test("extractJson never invokes the repair path for legal JSON", () => {
	const parseSpy = mock.method(JSON, "parse");
	try {
		const result = extractJson<{ a: number }>('{"a": 1}');
		assert.equal(result.a, 1);
		assert.equal(parseSpy.mock.calls.length, 1);
	} finally {
		parseSpy.mock.restore();
	}
});

test("extractJson fail-loud on truncated JSON reports both original and repair-attempt errors", () => {
	const truncated = '{"a": 1, "b": [1, 2,';
	assert.throws(
		() => extractJson(truncated),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /original error/i);
			assert.match(error.message, /after repair/i);
			return true;
		},
	);
});

test("stripCodeFence handles closed, unclosed, absent, and prose-wrapped fences", () => {
	// closed fence
	assert.equal(stripCodeFence('```json\n{"a": 1}\n```'), '{"a": 1}');
	// unclosed opening fence (a truncated response): strip the dangling opener, keep the tail
	assert.equal(stripCodeFence('```json\n{"a": 1, "b": ['), '{"a": 1, "b": [');
	// no fence: returned unchanged
	assert.equal(stripCodeFence('{"a": 1}'), '{"a": 1}');
	// fence buried in surrounding prose
	assert.equal(stripCodeFence('Here you go:\n```json\n{"a": 1}\n```\nHope that helps!'), '{"a": 1}');
});

test("looksTruncated flags unterminated JSON but not complete-but-malformed JSON", () => {
	assert.equal(looksTruncated('{"a": 1, "b": [1, 2,'), true); // unbalanced braces/brackets
	assert.equal(looksTruncated('{"notes": [{"key": "k", "title": "t'), true); // ends inside a string
	assert.equal(looksTruncated('{"a": 1}'), false); // complete
	// complete but malformed (an unescaped inner quote): structurally balanced, so NOT truncation
	assert.equal(looksTruncated('{"t": "he said "hi" mid"}'), false);
});

test("extractJson strips an unclosed opening fence and reports truncation, not a backtick error", () => {
	const truncated = '```json\n{"notes": [{"key": "k", "title": "t';
	assert.throws(
		() => extractJson(truncated),
		(error: unknown) => {
			assert.ok(error instanceof JsonExtractError);
			assert.equal(error.truncated, true);
			assert.match(error.message, /truncated|unterminated/i);
			assert.doesNotMatch(error.message, /`/); // the misleading backtick parse error must be gone
			return true;
		},
	);
});

test("extractJson parses a closed fenced block", () => {
	assert.deepEqual(extractJson('```json\n{"a": 1, "b": [2, 3]}\n```'), { a: 1, b: [2, 3] });
});

test("extractJson keeps valid JSON whose value contains a triple-backtick fence", () => {
	const payload = JSON.stringify({ body: "```python\nprint(1)\n```" });
	assert.deepEqual(extractJson(payload), { body: "```python\nprint(1)\n```" });
});

test("extractJson parses a fenced block whose string value contains a triple-backtick fence", () => {
	const payload = JSON.stringify({ body: "```python\nprint(1)\n```" });
	assert.deepEqual(extractJson(`\`\`\`json\n${payload}\n\`\`\``), { body: "```python\nprint(1)\n```" });
});

test("completeJson raises JsonTruncatedError immediately without burning the retry budget", async () => {
	let calls = 0;
	await assert.rejects(
		() =>
			completeJson(() => {
				calls++;
				return '```json\n{"notes": [{"key": "k"';
			}),
		(error: unknown) => {
			assert.ok(error instanceof JsonTruncatedError);
			return true;
		},
	);
	assert.equal(calls, 1); // truncation is deterministic — re-asking the same prompt cannot help
});

test("completeJson retries a stochastic malformation up to the attempt budget then fails loud", async () => {
	let calls = 0;
	await assert.rejects(
		() =>
			completeJson(() => {
				calls++;
				return '{"notes": [{"title": "he said "hi""}]}'; // unescaped quote, structurally balanced
			}),
		/model returned invalid JSON in 3 attempts/,
	);
	assert.equal(calls, 3);
});

test("completeJson returns parsed JSON on a valid reply", async () => {
	const result = await completeJson<{ ok: boolean }>(() => '{"ok": true}');
	assert.equal(result.ok, true);
});

test("config loads shallow YAML overrides over defaults", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-config-"));
	const configPath = join(root, "config.yaml");
	await writeFile(
		configPath,
		[
			"llm:",
			"  base_url: https://relay.example/v1",
			"  model_fast: cheap-model",
			"cadence:",
			"  synthesize_stale_after_days: 3",
			"  synthesize_after_new_notes: 5",
			"  digest_after_unreviewed: 2",
			"hands:",
			"  enabled: true",
			"  desktop_enabled: true",
			"  desktop_allowed_apps: notepad.exe, calculatorapp.exe",
			"  desktop_tier: 2",
			"  desktop_action_timeout_s: 12",
			"  desktop_driver_binary: C:/Tools/cua-driver.exe",
			"",
		].join("\n"),
		"utf8",
	);

	const config = loadConfig(configPath);

	assert.equal(config.llm.baseUrl, "https://relay.example/v1");
	assert.equal(config.llm.modelFast, "cheap-model");
	assert.equal(config.llm.modelStrong, "deepseek-v4-pro");
	assert.equal(config.llm.apiKeyEnv, "HER_LLM_API_KEY");
	assert.equal(config.cadence.synthesizeStaleAfterDays, 3);
	assert.equal(config.cadence.synthesizeAfterNewNotes, 5);
	assert.equal(config.cadence.digestAfterUnreviewed, 2);
	assert.equal(config.hands.enabled, true);
	assert.equal(config.hands.desktopEnabled, true);
	assert.equal(config.hands.desktopAllowedApps, "notepad.exe, calculatorapp.exe");
	assert.equal(config.hands.desktopDeniedApps, "");
	assert.equal(config.hands.desktopTier, 2);
	assert.equal(config.hands.desktopMaxActionsPerTask, 30);
	assert.equal(config.hands.desktopActionTimeoutS, 12);
	assert.equal(config.hands.desktopDriverBinary, "C:/Tools/cua-driver.exe");
});

test("renderConfig round-trips hands defaults", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-config-render-"));
	const configPath = join(root, "config.yaml");
	await writeFile(configPath, renderConfig(), "utf8");

	assert.deepEqual(loadConfig(configPath), DEFAULT_CONFIG);
});

test("validateMemoryProvenance accepts her-acted", () => {
	assert.equal(validateMemoryProvenance("her-acted"), "her-acted");
});
test("FakeModel records calls and strong flag", async () => {
	const model = new FakeModel("ok");
	assert.equal(await model.complete("hello", { strong: true }), "ok");
	assert.deepEqual(model.calls, [{ prompt: "hello", strong: true }]);
});

test("OpenAICompatibleModel uses fast or strong configured model", async () => {
	const requests: Array<{ body: Record<string, unknown>; authorization: string | null }> = [];
	const fetcher = (async (_input, init) => {
		requests.push({
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
			authorization: init?.headers instanceof Headers ? init.headers.get("authorization") : null,
		});
		return new Response(JSON.stringify({ choices: [{ message: { content: "model reply" } }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	const model = new OpenAICompatibleModel(
		{
			llm: {
				baseUrl: "https://relay.example/v1",
				modelFast: "fast-model",
				modelStrong: "strong-model",
				apiKeyEnv: "HER_TEST_KEY",
			},
			cadence: {
				consolidate: "daily",
				synthesize: "weekly",
				synthesizeStaleAfterDays: 10,
				synthesizeAfterNewNotes: 8,
				digestAfterUnreviewed: 3,
			},
			hands: DEFAULT_CONFIG.hands,
		},
		{ HER_TEST_KEY: "secret" },
		fetcher,
	);

	assert.equal(await model.complete("prompt"), "model reply");
	assert.equal(await model.complete("prompt", { strong: true }), "model reply");
	assert.equal(requests[0].body.model, "fast-model");
	assert.equal(requests[1].body.model, "strong-model");
	assert.equal(requests[0].authorization, "Bearer secret");
});

test("embedding search ranks docs through an OpenAI-compatible embeddings endpoint", async () => {
	const requests: Array<{ authorization: string | null; body: Record<string, unknown>; url: string }> = [];
	const fetcher = (async (input, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
		requests.push({
			authorization: init?.headers instanceof Headers ? init.headers.get("authorization") : null,
			body: body as Record<string, unknown>,
			url: String(input),
		});
		const data = (body.input ?? []).map((text) => ({
			embedding: text.includes("latent") || text.includes("unspoken") ? [1, 0] : [0, 1],
		}));
		return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	const search = createEmbeddingSearch(
		{
			HER_EMBEDDINGS_API_KEY: "embed-key",
			HER_EMBEDDINGS_BASE_URL: "https://embeddings.example/v1",
			HER_EMBEDDINGS_MODEL: "embed-model",
		},
		fetcher,
	);

	const hits = await search?.(
		"unspoken association",
		[
			{ id: "semantic/literal", kind: "semantic", path: "literal.md", text: "literal exact words" },
			{ id: "world/latent", kind: "world", path: "latent.md", text: "latent concept" },
		],
		1,
	);

	assert.equal(hits?.[0]?.id, "world/latent");
	assert.equal(requests[0].url, "https://embeddings.example/v1/embeddings");
	assert.equal(requests[0].authorization, "Bearer embed-key");
	assert.equal(requests[0].body.model, "embed-model");
	assert.deepEqual(requests[0].body.input, [
		"unspoken association",
		"id: semantic/literal\nkind: semantic\nliteral exact words",
		"id: world/latent\nkind: world\nlatent concept",
	]);
});

// --- G-234 compiled-truth slice: merge-rewrite + Timeline + fail-safe ------------------------
// These drive the PUBLIC consolidate() over a temp store with a prompt-recording scripted model,
// so upsertNote's new behavior is observed end-to-end (no private-symbol imports). The merge call
// is the model call whose prompt carries "EXISTING NOTE:" (mergeNotePrompt); all others are the
// consolidate call. See docs/specs/2026-08-10-g234-compiled-truth-slice.md.

async function g234Store(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g234-"));
	await initStore(root);
	return root;
}

async function writeRawEpisode(store: string, ts: string, id: string, body: string): Promise<void> {
	await writeText(
		join(store, "episodic", "raw", `${ts}--${id}.md`),
		["---", `id: ${id}`, `timestamp: ${ts}`, "project: her", "---", "", body, ""].join("\n"),
	);
}

function scriptedModel(replies: { consolidate: string; merge?: string; mergeThrows?: boolean }): {
	calls: Array<{ prompt: string }>;
	complete(prompt: string): string;
} {
	const calls: Array<{ prompt: string }> = [];
	return {
		calls,
		complete(prompt: string): string {
			calls.push({ prompt });
			if (prompt.includes("EXISTING NOTE:")) {
				if (replies.mergeThrows) throw new Error("merge model unavailable (test)");
				return replies.merge ?? "";
			}
			return replies.consolidate;
		},
	};
}

function timelineLines(body: string): string[] {
	return body.split(/\r?\n/).filter((line) => /^- \*\*\d{4}-\d{2}-\d{2}\*\*/.test(line));
}

async function seedSemanticNote(store: string, key: string, lines: string[]): Promise<void> {
	await writeText(join(store, "semantic", `${key}.md`), lines.join("\n"));
}

test("G-234 upsert merges into an existing note: merge prompt sees the old body, merge output is persisted (no blind overwrite)", async () => {
	const store = await g234Store();
	await seedSemanticNote(store, "compiled-fact", [
		"---",
		"key: compiled-fact",
		"type: concept",
		"tier: summarizable",
		"created: 2026-08-01",
		"updated: 2026-08-01",
		"sources:",
		"  - ep-old",
		"---",
		"",
		"# compiled-fact",
		"",
		"OLD KNOWLEDGE: Fei prefers neutral black-white-grey palettes.",
		"",
		"## Relations",
		"- confirms: [[design-taste]]",
		"",
	]);
	await writeRawEpisode(store, "2026-08-10T0001", "ep-new", "Fei also mentioned frosted glass.");

	const model = scriptedModel({
		consolidate: JSON.stringify({
			notes: [
				{
					key: "compiled-fact",
					type: "concept",
					content: "RAW-NEW: Fei likes frosted glass.",
					sources: ["ep-new"],
				},
			],
		}),
		merge: JSON.stringify({
			content: "MERGED: Fei prefers neutral palettes and frosted glass.",
			change: "added frosted-glass preference",
		}),
	});

	await new Memory(store, model).consolidate();

	const mergeCall = model.calls.find((call) => call.prompt.includes("EXISTING NOTE:"));
	assert.ok(mergeCall, "a merge model call must happen for an existing key");
	assert.match(mergeCall.prompt, /OLD KNOWLEDGE/, "merge prompt must carry the old note body (no more blind writing)");

	const body = (await readText(join(store, "semantic", "compiled-fact.md"))) ?? "";
	assert.match(body, /MERGED: Fei prefers neutral palettes and frosted glass\./, "merge output must be persisted");
	assert.doesNotMatch(body, /RAW-NEW/, "raw new content must NOT blind-overwrite the note body");
});

test("G-234 merge change-summary lands as a self-contained Timeline entry with source ids", async () => {
	const store = await g234Store();
	await seedSemanticNote(store, "topic-note", [
		"---",
		"key: topic-note",
		"type: concept",
		"tier: summarizable",
		"created: 2026-08-01",
		"updated: 2026-08-01",
		"---",
		"",
		"# topic-note",
		"",
		"Body v0.",
		"",
	]);
	await writeRawEpisode(store, "2026-08-10T0002", "ep-42", "new evidence");

	const model = scriptedModel({
		consolidate: JSON.stringify({ notes: [{ key: "topic-note", content: "ignored raw", sources: ["ep-42"] }] }),
		merge: JSON.stringify({ content: "Body v1.", change: "recorded the frosted-glass turn" }),
	});
	await new Memory(store, model).consolidate();

	const body = (await readText(join(store, "semantic", "topic-note.md"))) ?? "";
	assert.match(body, /\n## Timeline\n/, "a Timeline section must exist");
	const lines = timelineLines(body);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^- \*\*\d{4}-\d{2}-\d{2}\*\* \| recorded the frosted-glass turn \| src: ep-42$/);
});

test("G-234 upsert preserves pre-existing Timeline entries verbatim and appends the new one", async () => {
	const store = await g234Store();
	const seededEntry = "- **2026-08-01** | seeded compiled-truth change | src: ep-seed";
	await seedSemanticNote(store, "legacy", [
		"---",
		"key: legacy",
		"type: concept",
		"tier: summarizable",
		"created: 2026-08-01",
		"updated: 2026-08-01",
		"---",
		"",
		"# legacy",
		"",
		"Legacy body.",
		"",
		"## Timeline",
		seededEntry,
		"",
	]);
	await writeRawEpisode(store, "2026-08-10T0003", "ep-2", "update");

	const model = scriptedModel({
		consolidate: JSON.stringify({ notes: [{ key: "legacy", content: "x", sources: ["ep-2"] }] }),
		merge: JSON.stringify({ content: "Legacy body, updated.", change: "second change" }),
	});
	await new Memory(store, model).consolidate();

	const body = (await readText(join(store, "semantic", "legacy.md"))) ?? "";
	assert.ok(body.includes(seededEntry), "the pre-existing Timeline entry must remain byte-for-byte");
	assert.equal(timelineLines(body).length, 2, "old entry kept + one appended");
});

test("G-234 Timeline is append-only across successive consolidations (grows, never drops entries)", async () => {
	const store = await g234Store();
	const model = scriptedModel({
		consolidate: JSON.stringify({
			notes: [{ key: "arc", content: "First body.", change: "created arc", sources: ["ep-a"] }],
		}),
		merge: JSON.stringify({ content: "Merged arc body.", change: "merged update" }),
	});
	const memory = new Memory(store, model);

	// round 1: key is new (miss) -> body from content, Timeline entry #1 from note.change
	await writeRawEpisode(store, "2026-08-10T0004", "ep-a", "first");
	await memory.consolidate();
	const firstLines = timelineLines((await readText(join(store, "semantic", "arc.md"))) ?? "");
	assert.equal(firstLines.length, 1);

	// round 2: key now exists (hit) -> merge rewrite, Timeline entry #2 appended
	await writeRawEpisode(store, "2026-08-10T0005", "ep-b", "second");
	await memory.consolidate();
	const secondLines = timelineLines((await readText(join(store, "semantic", "arc.md"))) ?? "");
	assert.equal(secondLines.length, 2, "Timeline grew by one; nothing removed");
	assert.ok(secondLines.includes(firstLines[0]), "round-1 Timeline entry survives the round-2 merge rewrite");
});

test("G-234 fail-safe: a failed merge keeps the old body (never blind-overwrites) and records a pending Timeline entry", async () => {
	const store = await g234Store();
	await seedSemanticNote(store, "durable", [
		"---",
		"key: durable",
		"type: concept",
		"tier: summarizable",
		"created: 2026-08-01",
		"updated: 2026-08-01",
		"---",
		"",
		"# durable",
		"",
		"IMPORTANT OLD FACT that must survive.",
		"",
	]);
	await writeRawEpisode(store, "2026-08-10T0006", "ep-x", "conflicting new info");

	const model = scriptedModel({
		consolidate: JSON.stringify({ notes: [{ key: "durable", content: "BLIND NEW BODY", sources: ["ep-x"] }] }),
		mergeThrows: true,
	});
	const result = await new Memory(store, model).consolidate();

	const body = (await readText(join(store, "semantic", "durable.md"))) ?? "";
	assert.match(body, /IMPORTANT OLD FACT that must survive\./, "old body must be preserved on merge failure");
	assert.doesNotMatch(body, /BLIND NEW BODY/, "must never fall back to a blind overwrite with the raw new content");
	const lines = timelineLines(body);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /merge failed/i);
	assert.match(lines[0], /pending/i);
	assert.match(lines[0], /ep-x/);
	assert.equal(result.notesTouched, 1, "a single failed note must not abort the whole batch");
});

// --- G-234 follow-up: unwedge the queue when a single episode's output still truncates -----------
// A dense turn can make consolidate's reply overflow the model's default output ceiling even at batch
// size 1. Throwing there froze the cursor and wedged the whole backlog. The fix: cap notes in the
// prompt (bounded output) and, as a backstop, skip+account+advance instead of throwing.

test("G-234 consolidate skips a single episode whose output still truncates: no throw, cursor advances, audit line recorded", async () => {
	const store = await g234Store();
	await writeRawEpisode(store, "2026-08-10T0007", "trunc-ep", "an information-dense turn");
	// Single-episode batch whose consolidate reply is unterminated JSON — completeJson raises
	// JsonTruncatedError, which at batch size 1 must NOT wedge the queue.
	const model = {
		complete(): string {
			return '{"notes": [{"key": "k", "content": "half';
		},
	};
	const warn = mock.method(console, "warn");
	try {
		const result = await new Memory(store, model).consolidate();
		assert.deepEqual(
			result,
			{ episodes: 0, notesTouched: 0, moments: 0 },
			"consolidate returns cleanly, does not throw",
		);

		const skips = (await readText(join(store, "audit", "consolidate-skips.jsonl"))) ?? "";
		const skipLines = skips.trim().split(/\r?\n/).filter(Boolean);
		assert.equal(skipLines.length, 1, "exactly one skip accounted");
		const entry = JSON.parse(skipLines[0]) as { episode: string; reason: string; response_head: string };
		assert.equal(entry.episode, "trunc-ep");
		assert.equal(entry.reason, "truncated");
		assert.ok(typeof entry.response_head === "string" && entry.response_head.length > 0, "responseHead captured");

		const state = await readJson<{ cursor?: { ts?: string; done_ids?: string[] } }>(
			join(store, ".her", "state.json"),
			{},
		);
		assert.equal(state.cursor?.ts, "2026-08-10T0007", "cursor advanced past the skipped episode");
		assert.ok(state.cursor?.done_ids?.includes("trunc-ep"), "skipped episode recorded in cursor done_ids");

		assert.ok(
			warn.mock.calls.some((call) => String(call.arguments[0]).includes("trunc-ep")),
			"a fail-loud console.warn names the skipped episode",
		);
	} finally {
		warn.mock.restore();
	}
});

test("G-234 consolidatePrompt caps note count to bound output and folds (not drops) secondary material", () => {
	const prompt = consolidatePrompt("[ep] text", []);
	assert.match(prompt, /at most 10 notes/i, "an explicit notes cap must be present");
	assert.match(prompt, /fold|merge/i, "secondary points are folded into fewer notes, not dropped");
});

// --- G-235: chunk the single super-fat episode instead of dropping it whole ----------------------
// When one episode's distilled output still truncates at batch size 1, its content is split by
// recursive halving; pieces that fit are distilled through the normal path, and pieces that still
// truncate at/below the char floor (or fall past the per-episode attempt budget) are QUARANTINED —
// full content preserved under <store>/.her/quarantine/, never silently dropped. The env overrides
// pin the char ceiling/floor/budget so the trees are small and deterministic in the test.

async function withChunkEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	const prev: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(overrides)) {
		prev[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await fn();
	} finally {
		for (const [key, value] of Object.entries(prev)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function readQuarantine(store: string): Promise<Array<{ name: string; raw: string; body: string }>> {
	let names: string[];
	try {
		names = (await readdir(join(store, ".her", "quarantine"))).filter((name) => name.endsWith(".md")).sort();
	} catch {
		return [];
	}
	const out: Array<{ name: string; raw: string; body: string }> = [];
	for (const name of names) {
		const raw = await readFile(join(store, ".her", "quarantine", name), "utf8");
		// frontmatter shape: `---\n<meta>\n---\n<body>\n`; the closer is the only `\n---\n`.
		const parts = raw.split("\n---\n");
		const body = parts.length > 1 ? parts.slice(1).join("\n---\n").replace(/\n$/, "") : raw;
		out.push({ name, raw, body });
	}
	return out;
}

test("G-235 fat episode is chunked and every segment's content is distilled (no quarantine, cursor advances)", async () => {
	await withChunkEnv({ HER_CONSOLIDATE_EPISODE_CHARS: "800", HER_CONSOLIDATE_CHUNK_FLOOR_CHARS: "200" }, async () => {
		const store = await g234Store();
		// 8 distinct ~200-char lines, each tagged with a unique SEG0N token at its start.
		const lines = Array.from({ length: 8 }, (_, i) => `SEG0${i + 1} ${"x".repeat(193)}`);
		await writeRawEpisode(store, "2026-08-11T0001", "fat-ep", lines.join("\n"));

		// Large chunk -> truncated JSON; small-enough chunk -> one note per SEG token it contains.
		const model = {
			complete(prompt: string): string {
				if (prompt.includes("EXISTING NOTE:")) return "";
				const chunk = prompt.slice(prompt.indexOf("EPISODES:\n") + "EPISODES:\n".length);
				if (chunk.length > 500) return '{"notes": [{"key": "k", "content": "half';
				const tokens = [...chunk.matchAll(/SEG0\d/g)].map((match) => match[0].toLowerCase());
				return JSON.stringify({
					notes: tokens.map((token) => ({
						key: token,
						type: "concept",
						content: `distilled ${token}`,
						sources: ["fat-ep"],
					})),
				});
			},
		};

		await new Memory(store, model).consolidate();

		const noteFiles = new Set((await readdir(join(store, "semantic"))).filter((name) => name.endsWith(".md")));
		for (let i = 1; i <= 8; i++) {
			assert.ok(noteFiles.has(`seg0${i}.md`), `segment carrying SEG0${i} was distilled into its own note`);
		}
		assert.equal((await readQuarantine(store)).length, 0, "nothing quarantined — every segment fit once split");

		const state = await readJson<{ cursor?: { ts?: string; done_ids?: string[] } }>(
			join(store, ".her", "state.json"),
			{},
		);
		assert.equal(state.cursor?.ts, "2026-08-11T0001", "cursor advanced past the chunked episode");
		assert.ok(state.cursor?.done_ids?.includes("fat-ep"), "chunked episode recorded in cursor done_ids");
	});
});

test("G-235 a bottomed-out segment is QUARANTINED with full content preserved; cursor advances, audit + log recorded", async () => {
	await withChunkEnv({ HER_CONSOLIDATE_EPISODE_CHARS: "800", HER_CONSOLIDATE_CHUNK_FLOOR_CHARS: "200" }, async () => {
		const store = await g234Store();
		const body = `HEAD ${"a".repeat(280)}ZZMARKERZZ${"b".repeat(300)} TAIL`; // ~600 chars, single line
		await writeRawEpisode(store, "2026-08-11T0002", "dense-ep", body);
		const model = { complete: (): string => '{"notes": [{"key": "k", "content": "unterminated' }; // always truncated
		const warn = mock.method(console, "warn");
		try {
			const result = await new Memory(store, model).consolidate();
			assert.deepEqual(result, { episodes: 0, notesTouched: 0, moments: 0 }, "no throw; the queue keeps draining");

			const quarantine = await readQuarantine(store);
			assert.ok(quarantine.length >= 1, "at least one quarantine file written");
			assert.equal(
				quarantine.reduce((sum, file) => sum + file.body.length, 0),
				body.length,
				"quarantined segments preserve the episode content byte-for-byte (nothing lost)",
			);
			assert.equal(
				quarantine.filter((file) => file.body.includes("ZZMARKERZZ")).length,
				1,
				"the unique marker survives intact in exactly one segment",
			);
			for (const file of quarantine)
				assert.match(file.raw, /reason: truncated/, "each quarantine file records why it was isolated");

			const skips = (await readText(join(store, "audit", "consolidate-skips.jsonl"))) ?? "";
			const skipLines = skips.trim().split(/\r?\n/).filter(Boolean);
			assert.equal(skipLines.length, quarantine.length, "one audit line per quarantined segment");
			assert.equal((JSON.parse(skipLines[0]) as { episode: string }).episode, "dense-ep");

			assert.ok(
				warn.mock.calls.some((call) => /QUARANTINED/.test(String(call.arguments[0]))),
				"a loud QUARANTINED warning is emitted",
			);

			const state = await readJson<{ cursor?: { ts?: string; done_ids?: string[] } }>(
				join(store, ".her", "state.json"),
				{},
			);
			assert.equal(state.cursor?.ts, "2026-08-11T0002", "cursor advanced past the fully-quarantined episode");
			assert.ok(state.cursor?.done_ids?.includes("dense-ep"));
		} finally {
			warn.mock.restore();
		}
	});
});

test("G-235 a non-truncation hard failure during chunking applies nothing and leaves the cursor frozen", async () => {
	await withChunkEnv({ HER_CONSOLIDATE_EPISODE_CHARS: "800", HER_CONSOLIDATE_CHUNK_FLOOR_CHARS: "200" }, async () => {
		const store = await g234Store();
		await writeRawEpisode(store, "2026-08-11T0003", "crash-ep", `HEAD ${"c".repeat(390)} TAIL`); // ~400 chars, <= ceil
		let calls = 0;
		const model = {
			complete(): string {
				calls++;
				if (calls === 1) return '{"notes": [{"key": "k", "content": "half'; // batch=1 truncates -> enter chunking
				throw new Error("model crashed mid-chunk (test)"); // first chunk attempt hard-fails
			},
		};
		await assert.rejects(new Memory(store, model).consolidate(), /model crashed mid-chunk/);

		const state = await readJson<{ cursor?: unknown }>(join(store, ".her", "state.json"), {});
		assert.equal(state.cursor, null, "cursor did NOT advance on a hard failure (stays at the init null)");
		assert.equal((await readQuarantine(store)).length, 0, "nothing quarantined on a hard failure");
		assert.equal(
			(await readdir(join(store, "semantic"))).filter((name) => name.endsWith(".md")).length,
			0,
			"no notes written on a hard failure",
		);
		assert.equal(await readText(join(store, "audit", "consolidate-skips.jsonl")), undefined, "nothing accounted");
	});
});

test("G-235 chunking terminates on a single huge line with no newlines (convergence) and loses no content", async () => {
	await withChunkEnv({ HER_CONSOLIDATE_EPISODE_CHARS: "800", HER_CONSOLIDATE_CHUNK_FLOOR_CHARS: "200" }, async () => {
		const store = await g234Store();
		const body = "Z".repeat(2000); // single line, no newline — forces the char-midpoint split path
		await writeRawEpisode(store, "2026-08-11T0005", "line-ep", body);
		const model = { complete: (): string => '{"notes": [{"unterminated' }; // always truncated
		// If the recursion did not strictly shrink each step, this would infinite-loop / stack-overflow
		// instead of returning — so simply completing is the convergence proof.
		const result = await new Memory(store, model).consolidate();
		assert.deepEqual(result, { episodes: 0, notesTouched: 0, moments: 0 });
		const quarantine = await readQuarantine(store);
		assert.ok(quarantine.length > 0, "the indigestible single line was quarantined, not looped on");
		assert.equal(
			quarantine.reduce((sum, file) => sum + file.body.length, 0),
			body.length,
			"single-line char-splitting still preserves every byte across quarantine files",
		);
		const state = await readJson<{ cursor?: { ts?: string } }>(join(store, ".her", "state.json"), {});
		assert.equal(state.cursor?.ts, "2026-08-11T0005", "cursor advanced (episode fully handled)");
	});
});

test("G-235 chunking honors the per-episode attempt budget: bounds model calls and quarantines the remainder", async () => {
	await withChunkEnv(
		{
			HER_CONSOLIDATE_EPISODE_CHARS: "800",
			HER_CONSOLIDATE_CHUNK_FLOOR_CHARS: "200",
			HER_CONSOLIDATE_CHUNK_MAX_ATTEMPTS: "3",
		},
		async () => {
			const store = await g234Store();
			await writeRawEpisode(store, "2026-08-11T0006", "budget-ep", "Q".repeat(2000));
			let calls = 0;
			const model = {
				complete(): string {
					calls++;
					return '{"notes": [{"half'; // always truncated
				},
			};
			await new Memory(store, model).consolidate();
			// 1 main-loop batch=1 attempt + at most 3 chunk attempts = <= 4 calls; no unbounded fan-out.
			assert.ok(calls <= 4, `chunking spent at most budget-many model calls, got ${calls}`);
			const quarantine = await readQuarantine(store);
			assert.ok(
				quarantine.some((file) => /reason: attempt-budget/.test(file.raw)),
				"the un-attempted remainder is quarantined under the budget reason",
			);
			assert.equal(
				quarantine.reduce((sum, file) => sum + file.body.length, 0),
				2000,
				"budget-capped quarantine still preserves all content",
			);
			const state = await readJson<{ cursor?: { ts?: string } }>(join(store, ".her", "state.json"), {});
			assert.equal(state.cursor?.ts, "2026-08-11T0006", "cursor advances even when the budget caps chunking");
		},
	);
});

test("completeJson exhausts malformed attempts with JsonMalformedError and preserves responseHead", async () => {
	const malformed = '{"notes":[{"key":"bad","content":"he said "oops""}]}';
	let calls = 0;
	await assert.rejects(
		() =>
			completeJson(() => {
				calls++;
				return malformed;
			}),
		(error: unknown) => {
			assert.ok(error instanceof JsonMalformedError);
			assert.equal(error.responseHead, malformed);
			assert.match(error.message, /model returned invalid JSON in 3 attempts/);
			return true;
		},
	);
	assert.equal(calls, 3);
	await assert.rejects(
		() => completeJson(() => '{"a": 1, "b": ['),
		(error: unknown) => error instanceof JsonTruncatedError,
	);
});

test("malformed fat-episode chunk is quarantined while sibling chunks are digested", async () => {
	await withChunkEnv({ HER_CONSOLIDATE_EPISODE_CHARS: "800", HER_CONSOLIDATE_CHUNK_FLOOR_CHARS: "200" }, async () => {
		const store = await g234Store();
		const body = `BADMARK ${"a".repeat(260)}\nGOODMARK ${"b".repeat(260)}`;
		await writeRawEpisode(store, "2026-08-11T0010", "malformed-fat", body);
		const malformed = '{"notes":[{"key":"bad","content":"he said "oops""}]}';
		let calls = 0;
		const model = {
			complete(prompt: string): string {
				if (prompt.includes("EXISTING NOTE:")) return JSON.stringify({ content: "merged", change: "merged" });
				if (calls++ === 0) return '{"notes":[{"key":"k","content":"half';
				if (prompt.includes("BADMARK")) return malformed;
				return JSON.stringify({
					notes: [{ key: "goodmark", type: "concept", content: "good sibling", sources: ["malformed-fat"] }],
				});
			},
		};
		await new Memory(store, model).consolidate();
		const quarantine = await readQuarantine(store);
		const malformedFile = quarantine.find(
			(file) => /reason: malformed/.test(file.raw) && file.body.includes("BADMARK"),
		);
		assert.ok(malformedFile, "malformed chunk is quarantined");
		assert.equal(
			body.slice(0, malformedFile.body.length),
			malformedFile.body,
			"quarantined chunk content is byte-preserved",
		);
		const skips = ((await readText(join(store, "audit", "consolidate-skips.jsonl"))) ?? "")
			.split(/\r?\n/)
			.filter(Boolean);
		assert.ok(skips.some((line) => (JSON.parse(line) as { reason?: string }).reason === "malformed"));
		const state = await readJson<{ cursor?: { ts?: string; done_ids?: string[] } }>(
			join(store, ".her", "state.json"),
			{},
		);
		assert.equal(state.cursor?.ts, "2026-08-11T0010");
		assert.ok(state.cursor?.done_ids?.includes("malformed-fat"));
	});
});

test("consolidate skips a batch-one malformed response and advances with malformed audit", async () => {
	const store = await g234Store();
	await writeRawEpisode(store, "2026-08-11T0011", "malformed-single", "random malformed output");
	const malformed = '{"notes":[{"key":"bad","content":"he said "oops""}]}';
	const model = { complete: (): string => malformed };
	await assert.doesNotReject(() => new Memory(store, model).consolidate());
	const lines = ((await readText(join(store, "audit", "consolidate-skips.jsonl"))) ?? "")
		.trim()
		.split(/\r?\n/)
		.filter(Boolean);
	assert.equal(lines.length, 1);
	assert.equal((JSON.parse(lines[0]) as { reason?: string }).reason, "malformed");
	const state = await readJson<{ cursor?: { ts?: string; done_ids?: string[] } }>(
		join(store, ".her", "state.json"),
		{},
	);
	assert.equal(state.cursor?.ts, "2026-08-11T0011");
	assert.ok(state.cursor?.done_ids?.includes("malformed-single"));
});

test("consolidate still propagates infrastructure errors and leaves cursor frozen", async () => {
	const store = await g234Store();
	await writeRawEpisode(store, "2026-08-11T0012", "infra-error", "must not advance");
	const model = {
		complete: (): string => {
			throw new Error("ECONNRESET");
		},
	};
	await assert.rejects(() => new Memory(store, model).consolidate(), /ECONNRESET/);
	const state = await readJson<{ cursor?: unknown }>(join(store, ".her", "state.json"), {});
	assert.equal(state.cursor, null);
	assert.equal(await readText(join(store, "audit", "consolidate-skips.jsonl")), undefined);
});
