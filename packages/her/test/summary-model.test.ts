import assert from "node:assert/strict";
import test from "node:test";
import { invokeCompletion } from "../src/her-core/index.ts";
import { completeJson, JsonTruncatedError } from "../src/her-core/memory-utils.ts";
import { createSummaryModel } from "../src/summary-model.ts";

const SUMMARY_ENV = {
	HER_SUMMARY_BASE_URL: "https://summary.example/v1",
	HER_SUMMARY_MODEL: "summary-test",
	HER_SUMMARY_API_KEY: "test-key",
} as NodeJS.ProcessEnv;

function summaryModel() {
	const model = createSummaryModel(SUMMARY_ENV);
	assert.ok(model, "explicit HER_SUMMARY_* env should configure a summary model");
	return model;
}

type ProviderReply = {
	content?: unknown;
	finish_reason?: string | null;
	model?: string;
	omitFinishReason?: boolean;
	usage?: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number };
};

async function withStubbedFetch<T>(
	reply: ProviderReply,
	run: (requests: Array<{ body: Record<string, unknown> }>) => Promise<T>,
): Promise<T> {
	const requests: Array<{ body: Record<string, unknown> }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		requests.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
		const choice: Record<string, unknown> = {
			message: { content: reply.content ?? '{"ok":true}' },
		};
		if (!reply.omitFinishReason) choice.finish_reason = reply.finish_reason ?? "stop";
		return {
			ok: true,
			async json() {
				return {
					choices: [choice],
					...(reply.model ? { model: reply.model } : {}),
					...(reply.usage ? { usage: reply.usage } : {}),
				};
			},
		} as unknown as Response;
	}) as unknown as typeof fetch;
	try {
		return await run(requests);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

test("complete and completeWithMeta send caller maxTokens as max_tokens", async () => {
	const model = summaryModel();
	await withStubbedFetch({ content: "ok" }, async (requests) => {
		assert.equal(await model.complete("prompt", { maxTokens: 8192 }), "ok");
		assert.ok(model.completeWithMeta, "summary model must expose completeWithMeta");
		assert.equal((await model.completeWithMeta("prompt", { maxTokens: 8192 })).text, "ok");
		assert.equal(requests[0]?.body.max_tokens, 8192);
		assert.equal(requests[1]?.body.max_tokens, 8192);
	});
});

test("omitting maxTokens still sends the 700 default on both call paths", async () => {
	const model = summaryModel();
	await withStubbedFetch({ content: "ok" }, async (requests) => {
		assert.equal(await model.complete("prompt"), "ok");
		assert.ok(model.completeWithMeta);
		assert.equal((await model.completeWithMeta("prompt")).text, "ok");
		assert.equal(requests[0]?.body.max_tokens, 700);
		assert.equal(requests[1]?.body.max_tokens, 700);
	});
});

test("invokeCompletion surfaces provider finish_reason=length", async () => {
	const model = summaryModel();
	await withStubbedFetch({ content: '{"ok":true}', finish_reason: "length" }, async () => {
		const result = await invokeCompletion(model, "prompt");
		assert.equal(result.finishReason, "length");
	});
});

test("invokeCompletion surfaces provider usage unchanged", async () => {
	const usage = { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 };
	const model = summaryModel();
	await withStubbedFetch({ content: '{"ok":true}', usage }, async () => {
		const result = await invokeCompletion(model, "prompt");
		assert.deepEqual(result.usage, usage);
	});
});

test("completeJson throws JsonTruncatedError when summary model reports finish_reason=length", async () => {
	const model = summaryModel();
	await withStubbedFetch({ content: '{"ok":true}', finish_reason: "length" }, async () => {
		await assert.rejects(
			() => completeJson(() => invokeCompletion(model, "prompt")),
			(error: unknown) => {
				assert.ok(error instanceof JsonTruncatedError);
				assert.match(error.message, /finish_reason=length/);
				return true;
			},
		);
	});
});

test("empty content still throws the existing empty-content error", async () => {
	const model = summaryModel();
	await withStubbedFetch({ content: "   " }, async () => {
		await assert.rejects(async () => await model.complete("prompt"), /summary model returned empty content/);
	});
});

test("missing finish_reason does not throw and leaves finishReason undefined", async () => {
	const model = summaryModel();
	await withStubbedFetch({ content: '{"ok":true}', omitFinishReason: true }, async () => {
		const result = await invokeCompletion(model, "prompt");
		assert.equal(result.finishReason, undefined);
		assert.equal(result.text, '{"ok":true}');
	});
});
