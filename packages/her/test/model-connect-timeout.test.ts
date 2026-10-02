import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/her-core/config.ts";
import { CompletionResponseError, OpenAICompatibleModel } from "../src/her-core/model.ts";
import { createSummaryModel } from "../src/summary-model.ts";

const connectError = () =>
	new TypeError("fetch failed", {
		cause: Object.assign(new Error("connect timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
	});
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));

for (const adapter of ["core", "summary"] as const) {
	test(`${adapter}: bounded connection-only recovery and cancellation`, async (t) => {
		const originalFetch = globalThis.fetch;
		let calls = 0;
		let behavior: typeof fetch = async () => reply();
		const requests: RequestInit[] = [];
		globalThis.fetch = async (url, init) => {
			calls++;
			requests.push(init ?? {});
			return behavior(url, init);
		};
		const model =
			adapter === "core"
				? new OpenAICompatibleModel(DEFAULT_CONFIG, { [DEFAULT_CONFIG.llm.apiKeyEnv]: "test" })
				: createSummaryModel({
						HER_SUMMARY_BASE_URL: "https://example.invalid",
						HER_SUMMARY_MODEL: "test",
						HER_SUMMARY_API_KEY: "test",
					});
		assert.ok(model);
		try {
			await t.test("recovers after two pre-connection failures, preserving request", async () => {
				calls = 0;
				requests.length = 0;
				behavior = async () => {
					if (calls < 3) throw connectError();
					return reply();
				};
				assert.equal(await model.complete("unchanged prompt", { maxTokens: 42 }), "ok");
				assert.equal(calls, 3);
				assert.equal(requests[0].redirect, "error");
				assert.equal(requests[0], requests[1]);
				assert.equal(requests[1], requests[2]);
			});
			await t.test("stops after three attempts and preserves original error", async () => {
				calls = 0;
				const error = connectError();
				behavior = async () => {
					throw error;
				};
				await assert.rejects(
					() => Promise.resolve(model.complete("test")),
					(e) => e === error,
				);
				assert.equal(calls, 3);
			});
			await t.test("never replays ambiguous transport, HTTP, or response-body errors", async () => {
				for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
					calls = 0;
					const error = new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
					behavior = async () => {
						throw error;
					};
					await assert.rejects(
						() => Promise.resolve(model.complete("test")),
						(e) => e === error,
					);
					assert.equal(calls, 1);
				}
				for (const status of [401, 402, 429, 503]) {
					calls = 0;
					behavior = async () => new Response("error", { status });
					await assert.rejects(() => Promise.resolve(model.complete("test")), new RegExp(`HTTP ${status}`));
					assert.equal(calls, 1);
				}
				calls = 0;
				behavior = async () => new Response("invalid json");
				await assert.rejects(
					() => Promise.resolve(model.complete("test")),
					(error) =>
						adapter === "core"
							? error instanceof CompletionResponseError && error.code === "invalid_json"
							: error instanceof SyntaxError,
				);
				assert.equal(calls, 1);
			});
			await t.test("pre-aborted request never starts fetch", async () => {
				calls = 0;
				const reason = new Error("cancelled");
				await assert.rejects(
					() => Promise.resolve(model.complete("test", { signal: AbortSignal.abort(reason) })),
					(e) => e === reason,
				);
				assert.equal(calls, 0);
			});
			await t.test("abort during backoff prevents another attempt", async () => {
				calls = 0;
				const controller = new AbortController();
				behavior = async () => {
					setTimeout(() => controller.abort(), 20);
					throw connectError();
				};
				await assert.rejects(() => Promise.resolve(model.complete("test", { signal: controller.signal })), {
					name: "AbortError",
				});
				assert.equal(calls, 1);
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
}
