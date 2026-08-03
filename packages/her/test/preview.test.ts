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

function readResponse(overrides: Record<string, unknown> = {}) {
	return new Response(
		JSON.stringify({
			ok: true,
			url: "https://example.com/",
			title: "Example Domain",
			generation: 7,
			refCount: 1,
			truncated: false,
			tree: '- link "More information..." [ref=s7e5]',
			...overrides,
		}),
		{ status: 200 },
	);
}

test("browser_read_page posts maxChars to agent-read and hands back the tree with its refs", async () => {
	const fetchImpl = fakeFetch(() => readResponse());
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_read_page"), { maxChars: 5000 });

	assert.equal(fetchImpl.calls.length, 1);
	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-read");
	assert.equal(fetchImpl.calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { maxChars: 5000 });
	assert.match(text, /https:\/\/example\.com\//);
	assert.match(text, /Example Domain/);
	assert.match(text, /\[ref=s7e5\]/);
	// The refs are only usable through browser_act, so the read says so.
	assert.match(text, /browser_act/);
});

test("browser_read_page with no maxChars sends an empty body so the host's default cap applies", async () => {
	const fetchImpl = fakeFetch(() => readResponse());
	const tools = previewHarness({ fetchImpl });

	await run(tools.get("browser_read_page"), {});

	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), {});
});

test("browser_read_page announces truncation so a partial tree is never read as the whole page", async () => {
	const fetchImpl = fakeFetch(() =>
		readResponse({ truncated: true, tree: '- link "a" [ref=s7e5]\n[truncated: 22 of 900 chars shown]' }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_read_page"), {});

	assert.match(text, /truncat/i);
	assert.match(text, /maxChars/);
});

test("browser_read_page reports a read failure instead of throwing", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, error: "browser not started" }), { status: 500 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_read_page"), {});

	assert.match(text, /browser not started/);
});

test("browser_act posts {ref, action} to agent-act and confirms what was applied", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: true, ref: "s7e5", action: "click" }), { status: 200 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_act"), { ref: "s7e5", action: "click" });

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-act");
	assert.equal(fetchImpl.calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { ref: "s7e5", action: "click" });
	assert.match(text, /s7e5/);
	assert.match(text, /click/);
	// read → act → read again: the act tells her to re-read for evidence.
	assert.match(text, /browser_read_page/);
});

test("browser_act sends text for a type action", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: true, ref: "s7e5", action: "type" }), { status: 200 }),
	);
	const tools = previewHarness({ fetchImpl });

	await run(tools.get("browser_act"), { ref: "s7e5", action: "type", text: "hello" });

	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { ref: "s7e5", action: "type", text: "hello" });
});

test("browser_act keeps an empty text (clear the field) instead of dropping it from the body", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: true, ref: "s7e5", action: "type" }), { status: 200 }),
	);
	const tools = previewHarness({ fetchImpl });

	await run(tools.get("browser_act"), { ref: "s7e5", action: "type", text: "" });

	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { ref: "s7e5", action: "type", text: "" });
});

test("browser_act passes a 409 control-owner-denied through verbatim and tells her to wait, not retry", async () => {
	const fetchImpl = fakeFetch(
		() =>
			new Response(JSON.stringify({ ok: false, error: "control-owner-denied", message: "control is with human" }), {
				status: 409,
			}),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_act"), { ref: "s7e5", action: "click" });

	assert.match(text, /control-owner-denied/);
	assert.match(text, /Fei/);
	assert.match(text, /hand.*back|handback/i);
	// The gate is a guardrail, not a failure to hammer at.
	assert.match(text, /not a (bug|failure)|do not retry|don't retry|wait/i);
});

test("browser_act passes a 410 stale-ref through verbatim and tells her to read the page again", async () => {
	const fetchImpl = fakeFetch(
		() =>
			new Response(
				JSON.stringify({ ok: false, error: "stale-ref", message: 'ref "s6e5" is from an earlier read' }),
				{ status: 410 },
			),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_act"), { ref: "s6e5", action: "click" });

	assert.match(text, /stale-ref/);
	assert.match(text, /s6e5/);
	assert.match(text, /browser_read_page/);
});

test("browser_act passes a 404 unknown-ref through with the host's own message", async () => {
	const fetchImpl = fakeFetch(
		() =>
			new Response(JSON.stringify({ ok: false, error: "unknown-ref", message: "no element for that ref" }), {
				status: 404,
			}),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_act"), { ref: "s7e99", action: "click" });

	assert.match(text, /unknown-ref/);
	assert.match(text, /no element for that ref/);
	assert.match(text, /browser_read_page/);
});

test("browser_act passes a 400 invalid-ref through and points at where refs come from", async () => {
	const fetchImpl = fakeFetch(
		() =>
			new Response(JSON.stringify({ ok: false, error: "invalid-ref", message: '"nope" is not a ref' }), {
				status: 400,
			}),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_act"), { ref: "nope", action: "click" });

	assert.match(text, /invalid-ref/);
	assert.match(text, /browser_read_page/);
});

test("browser_read_page and browser_act report a connection-refused error naming the UI base, no throw", async () => {
	const fetchImpl = fakeFetch(() => {
		throw new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), { code: "ECONNREFUSED" }),
		});
	});
	const tools = previewHarness({ fetchImpl });

	const readText = await run(tools.get("browser_read_page"), {});
	const actText = await run(tools.get("browser_act"), { ref: "s7e5", action: "click" });

	assert.match(readText, /127\.0\.0\.1:3000/);
	assert.match(readText, /connection refused/i);
	assert.match(actText, /connection refused/i);
});

test("browser_read_page and browser_act time out instead of hanging forever", async () => {
	const fetchImpl = neverRespondingFetch();
	const tools = previewHarness({ fetchImpl, timeoutMs: 30 });

	const readText = await run(tools.get("browser_read_page"), {});
	const actText = await run(tools.get("browser_act"), { ref: "s7e5", action: "click" });

	assert.match(readText, /timeout|did not respond/i);
	assert.match(actText, /timeout|did not respond/i);
});

test("browser driving tools name the discipline skill for credential/payment/agreement fields", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	const readDescription = tools.get("browser_read_page")?.description ?? "";
	const actDescription = tools.get("browser_act")?.description ?? "";

	assert.match(actDescription, /browser-discipline/);
	assert.match(actDescription, /credential|password/i);
	assert.match(actDescription, /Fei/);
	assert.match(readDescription, /browser_act/);
	// The wheel handover is Fei's move by design — she gets no takeover/handback tool.
	assert.match(actDescription, /takeover|hand.*back|handback/i);
});

test("browser driving tools are registered as non-destructive governed tools", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("browser_read_page"));
	assert.ok(tools.has("browser_act"));
	assert.equal(governedTools.browser_read_page?.destructive, false);
	assert.equal(governedTools.browser_act?.destructive, false);
});

test("she is given no takeover or handback tool — the wheel handover stays Fei's move", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.equal(tools.has("browser_takeover"), false);
	assert.equal(tools.has("browser_handback"), false);
	assert.equal(governedTools.browser_takeover, undefined);
	assert.equal(governedTools.browser_handback, undefined);
});

test("artifact_publish posts the source path and reports the slug on 200 {ok:true, slug, seq}", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: true, slug: "demo-a1b2c3d4", seq: 1 }), { status: 200 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("artifact_publish"), { path: "D:/artifacts/demo.html" });

	assert.match(text, /已发布到作品面板: demo-a1b2c3d4/);
	assert.equal(fetchImpl.calls.length, 1);
	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/preview/artifact");
	assert.equal(fetchImpl.calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { path: "D:/artifacts/demo.html" });
});

test("artifact_publish reports a human-readable prompt when HER_ARTIFACTS_DIR is not configured (500)", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, error: "artifacts_dir_not_configured" }), { status: 500 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("artifact_publish"), { path: "D:/artifacts/demo.html" });

	assert.match(text, /HER_MEMORY_DIR|HER_ARTIFACTS_DIR/);
	assert.match(text, /Fei/);
});

test("artifact_publish passes through the original error text on 400", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: "bad_path" }), { status: 400 }));
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("artifact_publish"), { path: "relative/path.html" });

	assert.match(text, /bad_path/);
});

test("artifact_publish reports a clear connection-refused error including UI_BASE, no throw", async () => {
	const fetchImpl = fakeFetch(() => {
		throw new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), { code: "ECONNREFUSED" }),
		});
	});
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("artifact_publish"), { path: "D:/artifacts/demo.html" });

	assert.match(text, /127\.0\.0\.1:3000/);
	assert.match(text, /connection refused/i);
});

test("artifact_publish reports the LAN/token limitation on 401, no throw", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("artifact_publish"), { path: "D:/artifacts/demo.html" });

	assert.match(text, /LAN/);
	assert.match(text, /token/i);
});

test("artifact_publish times out and returns a timeout error instead of hanging forever", async () => {
	const fetchImpl = neverRespondingFetch();
	const tools = previewHarness({ fetchImpl, timeoutMs: 30 });

	const text = await run(tools.get("artifact_publish"), { path: "D:/artifacts/demo.html" });

	assert.match(text, /timeout|did not respond/i);
});

test("artifact_publish reports a non-JSON response with a clear error instead of throwing", async () => {
	const fetchImpl = fakeFetch(() => new Response("<html>not json</html>", { status: 200 }));
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("artifact_publish"), { path: "D:/artifacts/demo.html" });

	assert.match(text, /non-JSON/i);
});

test("artifact_publish is registered as a destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("artifact_publish"));
	assert.equal(governedTools.artifact_publish?.destructive, true);
});
