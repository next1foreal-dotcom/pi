import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/her-core/config.ts";
import { FakeModel, OpenAICompatibleModel } from "../src/her-core/model.ts";
import { consolidatePrompt, summaryPrompt, surfacePrompt, synthesizePrompt } from "../src/her-core/prompts.ts";

test("prompts preserve Python memory operation contracts", () => {
	assert.match(summaryPrompt("raw session"), /exactly these fields/);
	assert.match(summaryPrompt("raw session"), /- what:/);
	assert.match(consolidatePrompt("[episode] text", ["existing-key"]), /TYPED units/);
	assert.match(
		consolidatePrompt("[episode] text", ["existing-key"]),
		/question \| concept \| opinion \| case \| solution/,
	);
	assert.match(synthesizePrompt("current", "notes", "moments", "Fei is the owner."), /GROUND-TRUTH FACTS/);
	assert.match(surfacePrompt("recent", "existing"), /reply with exactly: NONE/);
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
			cadence: { consolidate: "daily", synthesize: "weekly", synthesizeStaleAfterDays: 10 },
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
