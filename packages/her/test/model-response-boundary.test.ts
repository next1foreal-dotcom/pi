import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { HerConfig } from "../src/her-core/config.ts";
import * as api from "../src/her-core/model.ts";

const usage = { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 };
const cfg = (url = "https://provider.invalid"): HerConfig => ({
	llm: { baseUrl: url, modelFast: "fixture-model", modelStrong: "fixture-strong", apiKeyEnv: "TEST_KEY" },
	cadence: {
		consolidate: "daily",
		synthesize: "weekly",
		synthesizeStaleAfterDays: 10,
		synthesizeAfterNewNotes: 8,
		digestAfterUnreviewed: 3,
	},
	hands: {
		enabled: false,
		desktopEnabled: false,
		desktopAllowedApps: "",
		desktopDeniedApps: "",
		desktopTier: 1,
		desktopMaxActionsPerTask: 1,
		desktopActionTimeoutS: 1,
		desktopDriverBinary: "fixture",
	},
});
const body = (content: unknown = '{"answer":42}', finish: unknown = "stop", reasoning: unknown = undefined) => ({
	id: "response-fixture-1",
	model: "fixture-model",
	usage,
	choices: [{ finish_reason: finish, message: { content, reasoning_content: reasoning } }],
});
function modelFor(payload: unknown, status = 200) {
	const requests: RequestInit[] = [];
	const model = new api.OpenAICompatibleModel(cfg(), { TEST_KEY: "fixture-only" }, async (_url, init) => {
		requests.push(init ?? {});
		return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
	});
	return { model, requests };
}
async function rejection(promise: Promise<unknown>, code: string) {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof Error, "must reject, not produce usable text");
	assert.equal((caught as Error & { code?: string }).code, code);
	return caught as api.CompletionResponseError;
}

test("ordinary response stays usable and carries bounded diagnostics", async () => {
	const { model } = modelFor(body("  answer \n"));
	const r = await model.completeWithMeta("test", { requireComplete: true });
	assert.equal(r.text, "answer");
	assert.deepEqual(r.usage, usage);
	assert.equal(r.diagnostics?.responseId, "response-fixture-1");
	assert.equal(r.diagnostics?.contentBytes, 10);
	assert.equal(r.diagnostics?.reasoningBytes, 0);
});
test("reasoning-only length never becomes an answer and never retries", async () => {
	const secretText = "private-reasoning-fixture-do-not-log";
	const { model, requests } = modelFor(body("", "length", secretText));
	const error = await rejection(model.completeWithMeta("test"), "reasoning_only_length");
	assert.deepEqual(error.meta.usage, usage);
	assert.equal(error.meta.diagnostics?.reasoningBytes, Buffer.byteLength(secretText));
	assert.equal(error.meta.finishReason, "length");
	assert.ok(!JSON.stringify(error).includes(secretText));
	assert.ok(!error.message.includes(secretText));
	assert.equal(requests.length, 1);
});
test("reasoning-only stop is distinct from length exhaustion", async () => {
	const { model } = modelFor(body(null, "stop", "thinking fixture"));
	await rejection(model.completeWithMeta("test"), "reasoning_only");
});
test("empty stop response retains the legacy message and fresh usage", async () => {
	const { model } = modelFor(body("", "stop"));
	const e = await rejection(model.completeWithMeta("test"), "empty_content");
	assert.match(e.message, /model returned empty content/);
	assert.deepEqual(e.meta.usage, usage);
});
test("whitespace is empty, not a method", async () => {
	await rejection(modelFor(body(" \n\t", "stop")).model.complete("test"), "empty_content");
});
test("missing choices keep measured usage but refuse output", async () => {
	const { model } = modelFor({ id: "r", model: "fixture-model", usage, choices: [] });
	const e = await rejection(model.completeWithMeta("test"), "missing_choice");
	assert.deepEqual(e.meta.usage, usage);
});
test("non-string content is not stringified into an answer", async () => {
	await rejection(modelFor(body({ answer: 42 })).model.complete("test"), "invalid_content");
});
for (const invalid of [null, [], 3, { choices: {} }]) {
	test(`malformed envelope is classified: ${JSON.stringify(invalid)}`, async () => {
		await rejection(modelFor(invalid).model.complete("test"), "invalid_response");
	});
}
test("valid-looking JSON stopped by length is refused in strict mode", async () => {
	await rejection(
		modelFor(body('{"ok":true}', "length")).model.complete("test", { requireComplete: true }),
		"incomplete_response",
	);
});
test("default callers still receive nonempty length output for their own handling", async () => {
	const r = await modelFor(body("partial", "length")).model.completeWithMeta("test");
	assert.equal(r.text, "partial");
	assert.equal(r.finishReason, "length");
});
for (const finish of ["tool_calls", "content_filter", null]) {
	test(`strict mode rejects non-final finish reason ${finish}`, async () => {
		await rejection(
			modelFor(body("answer", finish)).model.complete("test", { requireComplete: true }),
			"incomplete_response",
		);
	});
}
test("explicit owner-selected generation policy reaches the wire", async () => {
	const { model, requests } = modelFor(body());
	await model.complete("Return JSON", {
		maxTokens: 800,
		thinking: "disabled",
		responseFormat: "json_object",
		requireComplete: true,
	});
	const sent = JSON.parse(String(requests[0].body));
	assert.deepEqual(sent.thinking, { type: "disabled" });
	assert.deepEqual(sent.response_format, { type: "json_object" });
	assert.equal(sent.max_tokens, 800);
	assert.equal(sent.requireComplete, undefined);
	assert.equal(requests[0].redirect, "error");
});
test("default request does not silently change thinking or format", async () => {
	const { model, requests } = modelFor(body());
	await model.complete("test");
	const sent = JSON.parse(String(requests[0].body));
	assert.equal(sent.thinking, undefined);
	assert.equal(sent.reasoning_effort, undefined);
	assert.equal(sent.response_format, undefined);
});
test("explicit enabled low effort is sent unchanged", async () => {
	const { model, requests } = modelFor(body());
	await model.complete("test", { thinking: "enabled", reasoningEffort: "low" });
	assert.equal(JSON.parse(String(requests[0].body)).reasoning_effort, "low");
});
for (const invalid of [
	{ thinking: "magic" },
	{ reasoningEffort: "magic" },
	{ responseFormat: "xml" },
	{ thinking: "disabled", reasoningEffort: "high" },
	{ maxTokens: 0 },
	{ maxTokens: 1.5 },
	{ maxTokens: Infinity },
	{ requireComplete: "yes" },
]) {
	test(`invalid options rejected before network: ${JSON.stringify(invalid)}`, async () => {
		const { model, requests } = modelFor(body());
		await assert.rejects(model.complete("test", invalid as api.CompletionOptions));
		assert.equal(requests.length, 0);
	});
}
test("HTTP error after previous success cannot retain previous usage", async () => {
	let n = 0;
	const model = new api.OpenAICompatibleModel(cfg(), { TEST_KEY: "fixture-only" }, async () => {
		n++;
		return n === 1 ? new Response(JSON.stringify(body())) : new Response("private error fixture", { status: 429 });
	});
	await model.complete("one");
	const e = await rejection(model.complete("two"), "http_error");
	assert.equal(e.meta.usage, undefined);
	assert.equal(e.meta.diagnostics?.httpStatus, 429);
	assert.equal(model.lastCompletion?.usage, undefined);
	assert.ok(!e.message.includes("private error"));
	assert.equal(n, 2);
});
test("malformed JSON is not retried or logged as a body", async () => {
	let n = 0;
	const model = new api.OpenAICompatibleModel(cfg(), { TEST_KEY: "fixture-only" }, async () => {
		n++;
		return new Response("private malformed JSON fixture", { status: 200 });
	});
	const e = await rejection(model.complete("test"), "invalid_json");
	assert.equal(n, 1);
	assert.equal(e.meta.usage, undefined);
	assert.ok(!e.message.includes("private malformed"));
});
test("transport failure clears old usage and preserves existing transport error", async () => {
	const fail = new Error("offline fixture");
	const model = new api.OpenAICompatibleModel(cfg(), { TEST_KEY: "fixture-only" }, async () => {
		throw fail;
	});
	model.lastCompletion = { usage, model: "old" };
	await assert.rejects(model.complete("test"), (e) => e === fail);
	assert.equal(model.lastCompletion, undefined);
});
test("typed error metadata cannot be replaced by another request", async () => {
	const { model } = modelFor(body("", "stop"));
	const e = await rejection(model.complete("test"), "empty_content");
	model.lastCompletion = { model: "another-request", usage: { total_tokens: 999 } };
	assert.equal(e.meta.model, "fixture-model");
	assert.deepEqual(e.meta.usage, usage);
	assert.ok(Object.isFrozen(e.meta));
	assert.ok(Object.isFrozen(e.meta.usage));
});
test("unsafe response id is omitted, not echoed in diagnostics", async () => {
	const payload = { ...body("", "stop"), id: "private data\nattack" };
	const e = await rejection(modelFor(payload).model.complete("test"), "empty_content");
	assert.equal(e.meta.diagnostics?.responseId, undefined);
	assert.ok(!e.message.includes("attack"));
});
test("missing model identity is identified, not silently reported as observed", async () => {
	const payload = { ...body(), model: undefined };
	const r = await modelFor(payload).model.completeWithMeta("test");
	assert.equal(r.model, "fixture-model");
	assert.equal(r.diagnostics?.modelIdentity, "requested-fallback");
});
test("bad token counts never enter sanitized usage as billable observations", async () => {
	const r = await modelFor({
		...body(),
		usage: { prompt_tokens: -1, completion_tokens: 1.5, total_tokens: "3" },
	}).model.completeWithMeta("test");
	assert.equal(r.usage, undefined);
	assert.equal(r.diagnostics?.usageStatus, "invalid");
});
test("inconsistent totals remain evidence of invalid usage, not reconciled cost", async () => {
	const r = await modelFor({
		...body(),
		usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 13 },
	}).model.completeWithMeta("test");
	assert.equal(r.diagnostics?.usageStatus, "invalid");
	assert.equal(r.usage?.total_tokens, undefined);
});
test("partial usage stays partial and missing usage stays missing", async () => {
	const partial = await modelFor({ ...body(), usage: { completion_tokens: 7 } }).model.completeWithMeta("test");
	assert.deepEqual(partial.usage, { completion_tokens: 7 });
	assert.equal(partial.diagnostics?.usageStatus, "partial");
	const missing = await modelFor({ ...body(), usage: undefined }).model.completeWithMeta("test");
	assert.equal(missing.usage, undefined);
	assert.equal(missing.diagnostics?.usageStatus, "missing");
});
test("invokeCompletion preserves diagnostics without raw reasoning text", async () => {
	const { model } = modelFor(body("answer", "stop", "hidden fixture"));
	const r = await api.invokeCompletion(model, "test");
	assert.deepEqual(model.lastCompletion?.diagnostics, r.diagnostics);
	assert.equal(model.lastCompletion?.diagnostics?.reasoningBytes, 14);
	assert.ok(!JSON.stringify(model.lastCompletion).includes("hidden fixture"));
});
test("request/response handling also runs over real loopback HTTP", async () => {
	const requests: Record<string, unknown>[] = [];
	const server = createServer(async (req, res) => {
		const parts: Buffer[] = [];
		for await (const chunk of req) parts.push(Buffer.from(chunk));
		requests.push(JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const addr = server.address();
		assert.ok(addr && typeof addr !== "string");
		const model = new api.OpenAICompatibleModel(cfg(`http://127.0.0.1:${addr.port}`), { TEST_KEY: "fixture-only" });
		const r = await model.completeWithMeta("Return JSON", {
			maxTokens: 64,
			thinking: "disabled",
			requireComplete: true,
		});
		assert.equal(r.text, '{"answer":42}');
		assert.deepEqual(requests[0].thinking, { type: "disabled" });
		assert.equal(r.diagnostics?.usageStatus, "complete");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
	}
});

test("explicit single request never retries even a connection-establishment timeout", async () => {
	let attempts = 0;
	const fail = new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
	const model = new api.OpenAICompatibleModel(cfg(), { TEST_KEY: "fixture-only" }, async (_url, init) => {
		attempts++;
		assert.equal(init?.redirect, "error");
		throw fail;
	});
	await assert.rejects(model.complete("JSON", { maxTokens: 2048, singleRequest: true }), (error) => error === fail);
	assert.equal(attempts, 1);
});
