import assert from "node:assert/strict";
import test from "node:test";
import * as policy from "../src/growth-experiment/model.ts";
import { DEFAULT_CONFIG } from "../src/her-core/config.ts";
import { OpenAICompatibleModel } from "../src/her-core/model.ts";

test("no policy leaves existing caller behavior unchanged", () => {
	assert.deepEqual(policy.growthCompletionOptions(512, undefined), { maxTokens: 512 });
});
test("approved policy never overrides max tokens or cancellation", () => {
	const controller = new AbortController();
	const source = Object.freeze({ thinking: "disabled", responseFormat: "json_object", requireComplete: true });
	const result = policy.growthCompletionOptions(512, source, controller.signal);
	assert.deepEqual(result, { ...source, maxTokens: 512, signal: controller.signal });
	assert.equal(Object.keys(source).length, 3);
});
for (const value of [
	null,
	[],
	"disabled",
	true,
	{ model: "other" },
	{ maxTokens: 100000 },
	{ signal: null },
	{ extra_body: { tools: [] } },
	{ thinking: "disabled", reasoningEffort: "high" },
]) {
	test(`malformed or authority-expanding policy rejected: ${JSON.stringify(value)}`, () => {
		assert.throws(
			() => policy.growthCompletionOptions(512, value),
			/growth model requestOptions|unsupported growth model option|disabled thinking/,
		);
	});
}
test("policy-selected strict completion runs through real adapter, no retry", async () => {
	let calls = 0;
	let request: unknown;
	const cfg = {
		...DEFAULT_CONFIG,
		llm: { baseUrl: "https://fixture.invalid", modelFast: "fixture", modelStrong: "fixture", apiKeyEnv: "TEST_KEY" },
	};
	const model = new OpenAICompatibleModel(cfg, { TEST_KEY: "fixture-only" }, async (_url, init) => {
		calls++;
		request = JSON.parse(String(init?.body));
		return new Response(
			JSON.stringify({
				model: "fixture",
				choices: [{ finish_reason: "length", message: { content: '{"answer":1}' } }],
				usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
			}),
		);
	});
	await assert.rejects(
		model.complete(
			"JSON",
			policy.growthCompletionOptions(512, { thinking: "enabled", reasoningEffort: "low", requireComplete: true }),
		),
		/incomplete_response/,
	);
	assert.equal(calls, 1);
	assert.equal((request as { reasoning_effort: string }).reasoning_effort, "low");
	assert.deepEqual(model.lastCompletion?.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
});
