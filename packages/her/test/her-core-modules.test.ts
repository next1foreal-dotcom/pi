import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { DEFAULT_CONFIG, loadConfig, renderConfig } from "../src/her-core/config.ts";
import { createEmbeddingSearch } from "../src/her-core/embedding-search.ts";
import {
	completeJson,
	extractJson,
	JsonExtractError,
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
