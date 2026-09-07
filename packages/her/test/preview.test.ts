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

test("browser_act surfaces Playwright's own diagnosis on a 500 instead of swallowing it", async () => {
	// The host puts the real reason in `message` and only the literal "error" in `error`
	// (docs/browser-agent-endpoints.md), so a generic fallback would drop the diagnosis.
	const fetchImpl = fakeFetch(
		() =>
			new Response(
				JSON.stringify({
					ok: false,
					error: "error",
					message: 'element is not enabled\ncall log: waiting for locator("aria-ref=e5")',
				}),
				{ status: 500 },
			),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_act"), { ref: "s7e5", action: "click" });

	assert.match(text, /element is not enabled/);
	assert.match(text, /call log/);
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

test("the descriptions carry the two contract facts a tool layer can't infer from a happy path", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	const readDescription = tools.get("browser_read_page")?.description ?? "";
	const actDescription = tools.get("browser_act")?.description ?? "";

	// A ref the cap cut away is refused (404 unknown-ref) — truncation is not cosmetic.
	assert.match(readDescription, /truncat/i);
	assert.match(readDescription, /cut|dropped|removed/i);
	// The 409 gate also fires when the browser is paused, not only on a human takeover.
	assert.match(actDescription, /paused/i);
});

test("browser_navigate is on the driving timeout tier, not the 5s panel tier", async () => {
	const fetchImpl = neverRespondingFetch();
	// Panel tier deliberately long, driving tier tiny: a navigate still wired to the
	// panel tier would hang for 5s here instead of giving up in 30ms.
	const tools = previewHarness({ fetchImpl, timeoutMs: 5_000, browserTimeoutMs: 30 });

	const started = Date.now();
	const text = await run(tools.get("browser_navigate"), { url: "https://example.com" });
	const elapsed = Date.now() - started;

	assert.match(text, /timeout|did not respond/i);
	assert.ok(elapsed < 1_000, `navigate should fail on the driving timeout; took ${elapsed}ms`);
});

test("the panel tools stay on the short panel timeout", async () => {
	const fetchImpl = neverRespondingFetch();
	const tools = previewHarness({ fetchImpl, timeoutMs: 30, browserTimeoutMs: 5_000 });

	const started = Date.now();
	const text = await run(tools.get("preview_open_review"), { url: "http://localhost:7300" });
	const elapsed = Date.now() - started;

	assert.match(text, /timeout|did not respond/i);
	assert.ok(elapsed < 1_000, `panel tools should stay on the panel timeout; took ${elapsed}ms`);
});

test("the browser driving tools wait longer than the host's own element timeout", async () => {
	const { BROWSER_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS } = await import("../src/preview/tools.ts");

	// browser-host's REF_ACT_TIMEOUT_MS is 5s — it waits that long for an element to
	// become actionable. A client that also gives up at 5s abandons work the host is
	// still legitimately doing. Reading a large page (ariaSnapshot over the whole tree)
	// likewise runs well past 5s; measured 7.2s on example.com under load.
	assert.ok(BROWSER_REQUEST_TIMEOUT_MS > 5_000, "must outlast the host's 5s element wait");
	assert.ok(BROWSER_REQUEST_TIMEOUT_MS > REQUEST_TIMEOUT_MS);
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

// ── browser_find ─────────────────────────────────────────────────────────────

test("browser_find posts query to agent-find and reports matching refs", async () => {
	const fetchImpl = fakeFetch(
		() =>
			new Response(
				JSON.stringify({
					ok: true,
					generation: 3,
					hits: [{ ref: "ref_1", line: 'button "Submit" [ref_1]' }],
					total: 1,
					truncated: false,
				}),
				{ status: 200 },
			),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_find"), { query: "Submit" });

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-find");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { query: "Submit" });
	assert.match(text, /Submit/);
	assert.match(text, /ref_1/);
});

test("browser_find is registered as a non-destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("browser_find"));
	assert.equal(governedTools.browser_find?.destructive, false);
});

// ── browser_get_text ─────────────────────────────────────────────────────────

test("browser_get_text posts maxChars to agent-page-text and returns the text", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: true, text: "Hello world", truncated: false }), { status: 200 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_get_text"), { maxChars: 1000 });

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-page-text");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { maxChars: 1000 });
	assert.match(text, /Hello world/);
});

test("browser_get_text is registered as a non-destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("browser_get_text"));
	assert.equal(governedTools.browser_get_text?.destructive, false);
});

// ── browser_console ──────────────────────────────────────────────────────────

test("browser_console posts filter to agent-console and reports entries with droppedUnread", async () => {
	const fetchImpl = fakeFetch(
		() =>
			new Response(
				JSON.stringify({
					ok: true,
					entries: [{ level: "error", text: "Uncaught TypeError" }],
					droppedUnread: 5,
					counts: { error: 1 },
				}),
				{ status: 200 },
			),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_console"), { filter: "error" });

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-console");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { filter: "error" });
	assert.match(text, /Uncaught TypeError/);
	assert.match(text, /5 entries were evicted/);
});

test("browser_console is registered as a non-destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("browser_console"));
	assert.equal(governedTools.browser_console?.destructive, false);
});

// ── browser_network ──────────────────────────────────────────────────────────

test("browser_network posts filter to agent-network and reports entries", async () => {
	const fetchImpl = fakeFetch(
		() =>
			new Response(
				JSON.stringify({
					ok: true,
					entries: [{ url: "https://example.com/api", status: 500 }],
					droppedUnread: 0,
					counts: { failed: 1 },
				}),
				{ status: 200 },
			),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_network"), { filter: "failed" });

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-network");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { filter: "failed" });
	assert.match(text, /example\.com/);
});

test("browser_network passes requestId to fetch a specific response body", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: true, body: '{"key":"value"}', base64Encoded: false }), { status: 200 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_network"), { requestId: "req-123" });

	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { requestId: "req-123" });
	assert.match(text, /req-123/);
});

test("browser_network is registered as a non-destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("browser_network"));
	assert.equal(governedTools.browser_network?.destructive, false);
});

// ── browser_screenshot ───────────────────────────────────────────────────────

test("browser_screenshot posts scale to agent-screenshot and reports dimensions and frozen", async () => {
	const fetchImpl = fakeFetch(
		() =>
			new Response(JSON.stringify({ ok: true, base64: "iVBOR...", width: 1280, height: 720, frozen: false }), {
				status: 200,
			}),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_screenshot"), { scale: 0.5 });

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-screenshot");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { scale: 0.5 });
	assert.match(text, /1280x720/);
});

test("browser_screenshot warns when the feed is frozen", async () => {
	const fetchImpl = fakeFetch(
		() =>
			new Response(JSON.stringify({ ok: true, base64: "iVBOR...", width: 800, height: 600, frozen: true }), {
				status: 200,
			}),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_screenshot"), {});

	assert.match(text, /FROZEN/);
	assert.match(text, /stale/i);
});

test("browser_screenshot is registered as a non-destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("browser_screenshot"));
	assert.equal(governedTools.browser_screenshot?.destructive, false);
});

// ── browser_computer ─────────────────────────────────────────────────────────

test("browser_computer posts act and target to agent-computer and reports success", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_computer"), {
		act: { action: "left_click" },
		target: { coordinate: [100, 200] },
	});

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-computer");
	const body = JSON.parse(String(fetchImpl.calls[0].init.body));
	assert.deepEqual(body.act, { action: "left_click" });
	assert.deepEqual(body.target, { coordinate: [100, 200] });
	assert.match(text, /browser_read_page|browser_screenshot/);
});

test("browser_computer surfaces control-owner-denied as a guardrail, not a fault", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, reason: "control-owner-denied" }), { status: 200 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_computer"), { act: { action: "left_click" } });

	assert.match(text, /Fei/);
	assert.match(text, /not a (bug|failure)|do not retry|don't retry|wait/i);
});

test("browser_computer is registered as a non-destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("browser_computer"));
	assert.equal(governedTools.browser_computer?.destructive, false);
});

// ── browser_form_input ───────────────────────────────────────────────────────

test("browser_form_input posts ref and value to agent-form-input and confirms", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true, ref: "ref_3" }), { status: 200 }));
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_form_input"), { ref: "ref_3", value: "hello" });

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-form-input");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { ref: "ref_3", value: "hello" });
	assert.match(text, /ref_3/);
});

test("browser_form_input surfaces control-owner-denied as HTTP 200 guardrail", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, reason: "control-owner-denied" }), { status: 200 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_form_input"), { ref: "ref_1", value: "test" });

	assert.match(text, /Fei/);
	assert.match(text, /not a (bug|failure)|do not retry|don't retry|wait/i);
});

test("browser_form_input is registered as a non-destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("browser_form_input"));
	assert.equal(governedTools.browser_form_input?.destructive, false);
});

// ── browser_eval ─────────────────────────────────────────────────────────────

test("browser_eval posts code to agent-eval and returns the value", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true, value: 42 }), { status: 200 }));
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_eval"), { code: "1 + 41" });

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-eval");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { code: "1 + 41" });
	assert.match(text, /42/);
});

test("browser_eval surfaces control-owner-denied as HTTP 200 guardrail", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, reason: "control-owner-denied" }), { status: 200 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_eval"), { code: "document.title" });

	assert.match(text, /Fei/);
	assert.match(text, /not a (bug|failure)|do not retry|don't retry|wait/i);
});

test("browser_eval is registered as a non-destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("browser_eval"));
	assert.equal(governedTools.browser_eval?.destructive, false);
});

// ── browser_viewport ─────────────────────────────────────────────────────────

test("browser_viewport posts preset to agent-viewport and reports the resulting state", async () => {
	const fetchImpl = fakeFetch(
		() =>
			new Response(
				JSON.stringify({
					ok: true,
					state: { width: 375, height: 812, mobile: true, colorScheme: null },
				}),
				{ status: 200 },
			),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_viewport"), { preset: "mobile" });

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-viewport");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { preset: "mobile" });
	assert.match(text, /375x812/);
	assert.match(text, /mobile/);
});

test("browser_viewport surfaces control-owner-denied as HTTP 200 guardrail", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, reason: "control-owner-denied" }), { status: 200 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_viewport"), { preset: "mobile" });

	assert.match(text, /Fei/);
	assert.match(text, /not a (bug|failure)|do not retry|don't retry|wait/i);
});

test("browser_viewport is registered as a non-destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("browser_viewport"));
	assert.equal(governedTools.browser_viewport?.destructive, false);
});

// ── browser_history ──────────────────────────────────────────────────────────

test("browser_history posts direction to agent-history and reports the new url", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: true, url: "https://example.com/prev" }), { status: 200 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_history"), { direction: "back" });

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-history");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { direction: "back" });
	assert.match(text, /example\.com\/prev/);
	assert.match(text, /browser_read_page/);
});

test("browser_history surfaces control-owner-denied as HTTP 200 guardrail", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, reason: "control-owner-denied" }), { status: 200 }),
	);
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_history"), { direction: "forward" });

	assert.match(text, /Fei/);
	assert.match(text, /not a (bug|failure)|do not retry|don't retry|wait/i);
});

test("browser_history is registered as a non-destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("browser_history"));
	assert.equal(governedTools.browser_history?.destructive, false);
});

// ── browser_batch ────────────────────────────────────────────────────────────

function okJson(body: Record<string, unknown> = { ok: true }) {
	return new Response(JSON.stringify(body), { status: 200 });
}

test("browser_batch runs three successful steps in order", async () => {
	const fetchImpl = fakeFetch((url) => {
		if (url.endsWith("/api/browser/agent-navigate")) return okJson({ ok: true });
		if (url.endsWith("/api/browser/agent-read")) return readResponse();
		if (url.endsWith("/api/browser/agent-act")) return okJson({ ok: true, ref: "s7e5", action: "click" });
		return new Response(JSON.stringify({ ok: false, error: "unexpected path" }), { status: 500 });
	});
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_batch"), {
		actions: [
			{ name: "browser_navigate", input: { url: "https://example.com" } },
			{ name: "browser_read_page", input: {} },
			{ name: "browser_act", input: { ref: "s7e5", action: "click" } },
		],
	});

	assert.equal(fetchImpl.calls.length, 3);
	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-navigate");
	assert.equal(fetchImpl.calls[1].url, "http://127.0.0.1:3000/api/browser/agent-read");
	assert.equal(fetchImpl.calls[2].url, "http://127.0.0.1:3000/api/browser/agent-act");
	assert.match(text, /step 1\/3\s+browser_navigate\s+ok/);
	assert.match(text, /step 2\/3\s+browser_read_page\s+ok/);
	assert.match(text, /step 3\/3\s+browser_act\s+ok/);
});

test("browser_batch stops after the second step fails and never calls the third", async () => {
	const fetchImpl = fakeFetch((url) => {
		if (url.endsWith("/api/browser/agent-navigate")) return okJson({ ok: true });
		if (url.endsWith("/api/browser/agent-read")) {
			return new Response(JSON.stringify({ ok: false, error: "browser not started" }), { status: 500 });
		}
		if (url.endsWith("/api/browser/agent-act")) return okJson({ ok: true, ref: "s7e5", action: "click" });
		return new Response(JSON.stringify({ ok: false, error: "unexpected path" }), { status: 500 });
	});
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_batch"), {
		actions: [
			{ name: "browser_navigate", input: { url: "https://example.com" } },
			{ name: "browser_read_page" },
			{ name: "browser_act", input: { ref: "s7e5", action: "click" } },
		],
	});

	// Stop-on-first-error is the call count, not just an error string in the return.
	assert.equal(fetchImpl.calls.length, 2);
	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/browser/agent-navigate");
	assert.equal(fetchImpl.calls[1].url, "http://127.0.0.1:3000/api/browser/agent-read");
	assert.match(text, /FAILED/);
	assert.match(text, /browser not started/);
	assert.match(text, /browser_act/);
});

test("browser_batch treats a control-owner refusal as a stop, not as a successful step", async () => {
	// The refusal arrives as HTTP 200 — that shape is deliberate at the route layer
	// (a working guardrail is not an outage). So a batch that decided "step ok" from
	// the status code alone would sail straight past Fei taking the wheel and keep
	// driving. This is the one failure mid-batch most likely to actually happen.
	const fetchImpl = fakeFetch((url) => {
		if (url.endsWith("/api/browser/agent-navigate")) return okJson({ ok: true });
		if (url.endsWith("/api/browser/agent-act")) {
			return okJson({ ok: false, reason: "control-owner-denied" });
		}
		if (url.endsWith("/api/browser/agent-read")) return okJson({ ok: true, tree: "" });
		return new Response(JSON.stringify({ ok: false, error: "unexpected path" }), { status: 500 });
	});
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_batch"), {
		actions: [
			{ name: "browser_navigate", input: { url: "https://example.com" } },
			{ name: "browser_act", input: { ref: "ref_5", action: "click" } },
			{ name: "browser_read_page" },
		],
	});

	// The third step must never have been dispatched.
	assert.equal(fetchImpl.calls.length, 2, `batch kept going after a refusal: ${text}`);
	assert.equal(fetchImpl.calls[1].url, "http://127.0.0.1:3000/api/browser/agent-act");
	// And she must be told it was the guardrail, not a fault — otherwise the sane
	// reaction to a "failed" batch is to retry it, which is exactly wrong here.
	assert.match(text, /control|wheel|Fei/i);
});

test("browser_batch rejects nested browser_batch and does not run any step", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_batch"), {
		actions: [
			{ name: "browser_navigate", input: { url: "https://example.com" } },
			{ name: "browser_batch", input: { actions: [] } },
		],
	});

	assert.equal(fetchImpl.calls.length, 0);
	assert.match(text, /nest/i);
});

test("browser_batch rejects an unknown tool name before running any step", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_batch"), {
		actions: [{ name: "browser_navigate", input: { url: "https://example.com" } }, { name: "browser_explode" }],
	});

	assert.equal(fetchImpl.calls.length, 0);
	assert.match(text, /browser_explode/);
	assert.match(text, /unknown/i);
});

test("browser_batch rejects empty actions", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = previewHarness({ fetchImpl });

	const text = await run(tools.get("browser_batch"), { actions: [] });

	assert.equal(fetchImpl.calls.length, 0);
	assert.match(text, /empty/i);
});

test("browser_batch rejects more than 20 steps", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = previewHarness({ fetchImpl });

	const actions = Array.from({ length: 21 }, () => ({ name: "browser_read_page" }));
	const text = await run(tools.get("browser_batch"), { actions });

	assert.equal(fetchImpl.calls.length, 0);
	assert.match(text, /20/);
});

test("browser_batch is registered as a non-destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("browser_batch"));
	assert.equal(governedTools.browser_batch?.destructive, false);
});
