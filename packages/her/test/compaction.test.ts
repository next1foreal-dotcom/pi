import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_TRANSCRIPT_BUDGET,
	describeMessages,
	fallbackCompactionSummary,
	renderCompactionPrompt,
	sessionSummaryModel,
	summarizeForCompaction,
} from "../src/compaction.ts";
import { FakeModel } from "../src/her-core/index.ts";
import { createSummaryModel } from "../src/summary-model.ts";

const grounding = {
	context: "Fei values exact verification.",
	facts: "Fei is the human owner.",
	soul: "Samantha stays warm and exact.",
	self: "Samantha is learning to stay grounded.",
	choiceModel: "Prefer reversible moves.",
};

function userMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(text: string, toolName?: string) {
	const content: unknown[] = [{ type: "text", text }];
	if (toolName) content.push({ type: "toolCall", name: toolName, id: "call-1", arguments: { path: "a.ts" } });
	return { role: "assistant", content };
}

function fakeContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		model: undefined,
		modelRegistry: {
			async getApiKeyAndHeaders() {
				return { ok: false, error: "No API key found" };
			},
		},
		...overrides,
	} as unknown as ExtensionContext;
}

test("fallback summary renders a structured outline instead of a raw JSON dump", () => {
	const summary = fallbackCompactionSummary({
		...grounding,
		preparation: {
			messagesToSummarize: [
				userMessage("Fix the compaction chain."),
				assistantMessage("Reading the extension.", "read"),
				{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(900) }] },
			],
			turnPrefixMessages: [userMessage("prefix turn")],
		},
	});

	assert.match(summary, /structured degradation/);
	assert.match(summary, /#1 user \| Fix the compaction chain\./);
	assert.match(summary, /#2 assistant \| calls: read \| Reading the extension\./);
	assert.match(summary, /#3 toolResult \| tool: read \| x+…/);
	assert.match(summary, /## Split-Turn Prefix/);
	// No raw JSON transcript dump: neither serialized keys nor pretty-printed braces.
	assert.doesNotMatch(summary, /"role":/);
	assert.doesNotMatch(summary, /"type": "text"/);
	assert.doesNotMatch(summary, /\{\n\s+"/);
	// Per-message excerpts stay short in the degraded rendering.
	assert.ok(!summary.includes("x".repeat(300)));
});

test("prompt budget drops the oldest messages and keeps the newest", () => {
	const messages = [
		userMessage(`OLDEST-MARKER ${"a".repeat(3000)}`),
		...Array.from({ length: 200 }, (_, index) => userMessage(`filler ${index} ${"b".repeat(3000)}`)),
		userMessage(`NEWEST-MARKER ${"c".repeat(100)}`),
	];

	const prompt = renderCompactionPrompt({ ...grounding, preparation: { messagesToSummarize: messages } });

	assert.ok(
		prompt.length < COMPACTION_TRANSCRIPT_BUDGET * 1.5,
		`prompt should stay near budget, got ${prompt.length}`,
	);
	assert.match(prompt, /NEWEST-MARKER/);
	assert.doesNotMatch(prompt, /OLDEST-MARKER/);
	assert.match(prompt, /older message\(s\) omitted: \d+ user/);
});

test("describeMessages keeps every message when it fits the budget", () => {
	const text = describeMessages([userMessage("one"), assistantMessage("two", "bash")], {
		budget: 10_000,
		perMessage: 200,
	});

	assert.equal(text, "#1 user | one\n#2 assistant | calls: bash | two");
	assert.equal(describeMessages([], { budget: 10_000, perMessage: 200 }), "(none)");
});

test("summary config recognizes DEEPSEEK_API_KEY and HER_LLM_API_KEY", async () => {
	for (const key of ["DEEPSEEK_API_KEY", "HER_LLM_API_KEY"]) {
		const model = createSummaryModel({ [key]: "test-key" } as NodeJS.ProcessEnv);
		assert.ok(model, `${key} should configure a summary model`);

		const requests: Array<{ url: string; body: Record<string, unknown>; auth: string | undefined }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			const headers = init.headers as Record<string, string>;
			requests.push({ url, body: JSON.parse(init.body as string), auth: headers.authorization });
			return {
				ok: true,
				async json() {
					return { choices: [{ message: { content: "summary text" } }] };
				},
			} as unknown as Response;
		}) as unknown as typeof fetch;
		try {
			assert.equal(await model.complete("prompt"), "summary text");
		} finally {
			globalThis.fetch = originalFetch;
		}

		assert.equal(requests[0]?.url, "https://api.deepseek.com/chat/completions");
		assert.equal(requests[0]?.body.model, "deepseek-chat");
		assert.equal(requests[0]?.auth, "Bearer test-key");
	}

	assert.equal(createSummaryModel({} as NodeJS.ProcessEnv), undefined);
});

test("session model is used when the session has one, and reports auth failures", async () => {
	assert.equal(sessionSummaryModel(fakeContext()), undefined);

	const model = sessionSummaryModel(fakeContext({ model: { provider: "anthropic", maxTokens: 8000 } as never }));
	assert.ok(model);
	await assert.rejects(async () => await model.complete("prompt"), /session model auth unavailable: No API key found/);
});

test("summarizeForCompaction prefers the session model, then env model, then the structured fallback", async () => {
	const preparation = { messagesToSummarize: [userMessage("hello")] };

	// Session model is tried first; when it cannot run, the env model catches the fall.
	const afterSessionFailure = await summarizeForCompaction({
		grounding,
		preparation,
		ctx: fakeContext({ model: { provider: "anthropic", maxTokens: 8000 } as never }),
		envModel: new FakeModel("env summary"),
	});
	assert.equal(afterSessionFailure.source, "summary-model");
	assert.equal(afterSessionFailure.summary, "env summary");
	assert.match(afterSessionFailure.errors?.join(" ") ?? "", /session-model: session model auth unavailable/);

	const envOnly = await summarizeForCompaction({
		grounding,
		preparation,
		ctx: fakeContext(),
		envModel: new FakeModel("env summary"),
	});
	assert.equal(envOnly.source, "summary-model");
	assert.equal(envOnly.summary, "env summary");
	assert.equal(envOnly.errors, undefined);

	const noModel = await summarizeForCompaction({ grounding, preparation, ctx: fakeContext() });
	assert.equal(noModel.source, "structured-fallback");
	assert.match(noModel.summary, /structured degradation/);
	assert.match(noModel.summary, /#1 user \| hello/);
});
