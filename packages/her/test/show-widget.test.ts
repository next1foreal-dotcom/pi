import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { governedTools } from "../src/extension.ts";
import { registerShowWidgetTools, type ShowWidgetToolDeps } from "../src/show-widget/tools.ts";

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

function showWidgetHarness(deps: ShowWidgetToolDeps) {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerShowWidgetTools(pi, deps);
	return tools;
}

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ type: string; text: string }>;
	};
	return result.content[0]?.text ?? "";
}

test("her_show_widget posts html+title+focus and reports success on 200 {ok:true}", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = showWidgetHarness({ fetchImpl });

	const text = await run(tools.get("her_show_widget"), {
		html: "<svg><rect/></svg>",
		title: "Flow",
		focus: true,
	});

	assert.match(text, /Flow/);
	assert.match(text, /widget view/i);
	assert.equal(fetchImpl.calls.length, 1);
	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3000/api/preview/widget");
	assert.equal(fetchImpl.calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), {
		html: "<svg><rect/></svg>",
		title: "Flow",
		focus: true,
	});
});

test("her_show_widget defaults focus to false when omitted", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = showWidgetHarness({ fetchImpl });

	await run(tools.get("her_show_widget"), { html: "<p>hi</p>" });

	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), {
		html: "<p>hi</p>",
		focus: false,
	});
});

test("her_show_widget with html:null sends {html:null} and reports cleared (clear semantics)", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = showWidgetHarness({ fetchImpl });

	const text = await run(tools.get("her_show_widget"), { html: null });

	assert.match(text, /clear/i);
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { html: null, focus: false });
});

test("her_show_widget maps a 400 too-large to a friendly, actionable message", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: "too-large" }), { status: 400 }));
	const tools = showWidgetHarness({ fetchImpl });

	const text = await run(tools.get("her_show_widget"), { html: "<p>big</p>" });

	assert.match(text, /256KB|too large|exceeds/i);
});

test("her_show_widget passes through the original error text on 400", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, error: "not-a-string" }), { status: 400 }),
	);
	const tools = showWidgetHarness({ fetchImpl });

	const text = await run(tools.get("her_show_widget"), { html: "<p>x</p>" });

	assert.match(text, /not-a-string/);
});

test("her_show_widget reports a clear connection-refused error including UI_BASE, no throw", async () => {
	const fetchImpl = fakeFetch(() => {
		throw new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), { code: "ECONNREFUSED" }),
		});
	});
	const tools = showWidgetHarness({ fetchImpl });

	const text = await run(tools.get("her_show_widget"), { html: "<p>x</p>" });

	assert.match(text, /127\.0\.0\.1:3000/);
	assert.match(text, /connection refused/i);
});

test("her_show_widget reports the LAN/token limitation on 401, no throw", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 }),
	);
	const tools = showWidgetHarness({ fetchImpl });

	const text = await run(tools.get("her_show_widget"), { html: "<p>x</p>" });

	assert.match(text, /LAN/);
	assert.match(text, /token/i);
});

test("HER_UI_BASE_URL env override sends the request to the overridden base", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = showWidgetHarness({ fetchImpl });
	const previous = process.env.HER_UI_BASE_URL;
	process.env.HER_UI_BASE_URL = "http://127.0.0.1:9999";

	try {
		await run(tools.get("her_show_widget"), { html: "<p>x</p>" });
	} finally {
		if (previous === undefined) delete process.env.HER_UI_BASE_URL;
		else process.env.HER_UI_BASE_URL = previous;
	}

	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:9999/api/preview/widget");
});

test("a hung fetch times out and returns a timeout error instead of hanging forever", async () => {
	const fetchImpl = neverRespondingFetch();
	const tools = showWidgetHarness({ fetchImpl, timeoutMs: 30 });

	const text = await run(tools.get("her_show_widget"), { html: "<p>x</p>" });

	assert.match(text, /timeout|did not respond/i);
});

test("a non-JSON response reports a clear error instead of throwing", async () => {
	const fetchImpl = fakeFetch(() => new Response("<html>not json</html>", { status: 200 }));
	const tools = showWidgetHarness({ fetchImpl });

	const text = await run(tools.get("her_show_widget"), { html: "<p>x</p>" });

	assert.match(text, /non-JSON/i);
});

test("a 500 response reports a clear error instead of throwing", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: "internal" }), { status: 500 }));
	const tools = showWidgetHarness({ fetchImpl });

	const text = await run(tools.get("her_show_widget"), { html: "<p>x</p>" });

	assert.match(text, /500/);
	assert.match(text, /internal/);
});

test("her_show_widget is registered as a non-destructive governed tool", () => {
	const tools = showWidgetHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });

	assert.ok(tools.has("her_show_widget"));
	assert.equal(governedTools.her_show_widget?.destructive, false);
});
