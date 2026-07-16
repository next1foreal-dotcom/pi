import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { governedTools } from "../src/extension.ts";
import { type PreviewToolDeps, registerPreviewTools } from "../src/preview/tools.ts";

type FetchCall = { url: string; init: RequestInit };
type FakeFetch = typeof fetch & { calls: FetchCall[] };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FakeFetch {
	const calls: FetchCall[] = [];
	const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init: init ?? {} });
		return await handler(url, init ?? {});
	}) as FakeFetch;
	impl.calls = calls;
	return impl;
}

function neverRespondingFetch(): FakeFetch {
	const calls: FetchCall[] = [];
	const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return await new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			signal?.addEventListener("abort", () => reject(signal.reason));
		});
	}) as FakeFetch;
	impl.calls = calls;
	return impl;
}

function previewHarness(deps: PreviewToolDeps) {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerPreviewTools(pi, deps);
	return tools;
}

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ type: string; text: string }>;
	};
	return result.content[0]?.text ?? "";
}

test("preview_open_review posts url and reports success on 200 {ok:true}", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("preview_open_review"), { url: "http://localhost:7300/?path=D:/x.md" });

	assert.match(text, /set/i);
	assert.equal(fetchImpl.calls.length, 1);
	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/preview/review");
	assert.equal(fetchImpl.calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { url: "http://localhost:7300/?path=D:/x.md" });
});

test("preview_open_review with no url sends body {url:null} (clear semantics)", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("preview_open_review"), {});

	assert.match(text, /clear/i);
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { url: null });
});

test("preview_open_review passes through the original error text on 400", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, error: "same-hostname-cookie-risk" }), { status: 400 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("preview_open_review"), { url: "http://localhost:3000" });

	assert.match(text, /same-hostname-cookie-risk/);
});

test("preview_open_review reports a clear connection-refused error including UI_BASE, no throw", async () => {
	const fetchImpl = fakeFetch(() => {
		throw new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), { code: "ECONNREFUSED" }),
		});
	});
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("preview_open_review"), { url: "http://localhost:7300" });

	assert.match(text, /127\.0\.0\.1:3000/);
	assert.match(text, /connection refused/i);
});

test("browser_navigate surfaces a handback prompt on 409 control-owner-denied", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, error: "control-owner-denied" }), { status: 409 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_navigate"), { url: "https://example.com" });

	assert.match(text, /Fei/);
	assert.match(text, /hand.*back|handback/i);
});

test("HER_UI_BASE_URL env override sends the request to the overridden base", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = previewHarness({ fetchImpl });
	const previous = process.env.HER_UI_BASE_URL;
	process.env.HER_UI_BASE_URL = "http://127.0.0.1:9999";

	try {
		await run(tools.get("browser_navigate"), { url: "https://example.com" });
	} finally {
		if (previous === undefined) delete process.env.HER_UI_BASE_URL;
		else process.env.HER_UI_BASE_URL = previous;
	}

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:9999/api/browser/agent-navigate");
});

test("a 401 response reports the LAN/token limitation for either tool, no throw", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 }),
	);
	const tools = previewHarness({ fetchImpl });

	const previewText = await run(tools.get("preview_open_review"), { url: "http://localhost:7300" });
	const navigateText = await run(tools.get("browser_navigate"), { url: "https://example.com" });

	assert.match(previewText, /LAN/);
	assert.match(previewText, /token/i);
	assert.match(navigateText, /LAN/);
	assert.match(navigateText, /token/i);
});

test("a hung fetch times out and returns a timeout error instead of hanging forever", async () => {
	const fetchImpl = neverRespondingFetch();
	const tools = previewHarness({ fetchImpl, timeoutMs: 30 });

	const text = await run(tools.get("preview_open_review"), { url: "http://localhost:7300" });

	assert.match(text, /timeout|did not respond/i);
});

test("a non-JSON response reports a clear error instead of throwing", async () => {
	const fetchImpl = fakeFetch(() => new Response("<html>not json</html>", { status: 200 }));
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("preview_open_review"), { url: "http://localhost:7300" });

	assert.match(text, /non-JSON/i);
});

test("a 500 response reports a clear error instead of throwing", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: "internal" }), { status: 500 }));
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("preview_open_review"), { url: "http://localhost:7300" });

	assert.match(text, /500/);
	assert.match(text, /internal/);
});

test("both preview tools are registered as non-destructive governed tools", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("preview_open_review"));
	assert.ok(tools.has("browser_navigate"));
	assert.equal(governedTools.preview_open_review?.destructive, false);
	assert.equal(governedTools.browser_navigate?.destructive, false);
});
