import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { governedTools } from "../src/extension.ts";
import { registerUiActionTools, type UiActionToolDeps } from "../src/ui-action/tools.ts";

type FetchCall = { url: string; method: string; body?: string };

/** A fake fetch that routes by url+method through a handler and records every call. */
function routedFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
	const calls: FetchCall[] = [];
	const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const call: FetchCall = {
			url: String(input),
			method: (init?.method ?? "GET").toUpperCase(),
			body: init?.body ? String(init.body) : undefined,
		};
		calls.push(call);
		return await handler(call);
	}) as typeof fetch & { calls: FetchCall[] };
	impl.calls = calls;
	return impl;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

const CATALOG = {
	ok: true,
	actions: [
		{
			action: "set_output_view",
			description: "d",
			params: [{ name: "view", type: "enum", values: ["tasks"], required: true }],
		},
		{ action: "toggle_sidebar", description: "d", params: [] },
	],
};

const STATE = { mode: "code", outputView: "tasks", sidebarCollapsed: false, drawer: null };

function harness(deps: UiActionToolDeps) {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerUiActionTools(pi, { sleep: async () => {}, idFactory: () => "fixed-id", ...deps });
	return tools;
}

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
}

// Happy path: validate against the catalog → POST → poll receipt → report ok + state.
test("her_ui_act applies a valid action and returns the ok receipt with the state snapshot", async () => {
	let polls = 0;
	const fetchImpl = routedFetch((call) => {
		if (call.url.endsWith("/api/ui/actions")) return json(CATALOG);
		if (call.url.endsWith("/api/ui/action") && call.method === "POST") return json({ ok: true, id: "fixed-id" });
		if (call.url.includes("/api/ui/action?id=")) {
			polls += 1;
			return polls < 2
				? json({ ok: true, settled: false })
				: json({ ok: true, settled: true, receipt: { ok: true, state: STATE } });
		}
		return json({ ok: false }, 500);
	});
	const tools = harness({ fetchImpl });

	const { text, details } = await run(tools.get("her_ui_act"), {
		action: "set_output_view",
		params: { view: "tasks" },
	});

	assert.match(text, /set_output_view/);
	assert.match(text, /outputView=tasks/);
	assert.equal((details as { ok?: boolean }).ok, true);
	// the POST carried the generated id + action + params
	const post = fetchImpl.calls.find((c) => c.method === "POST");
	assert.deepEqual(JSON.parse(post?.body ?? "{}"), {
		id: "fixed-id",
		action: "set_output_view",
		params: { view: "tasks" },
	});
});

// The tool checks the capability catalog first — an unknown action never POSTs.
test("her_ui_act rejects an action absent from the catalog and never posts it", async () => {
	const fetchImpl = routedFetch((call) => {
		if (call.url.endsWith("/api/ui/actions")) return json(CATALOG);
		return json({ ok: false }, 500);
	});
	const tools = harness({ fetchImpl });

	const { text } = await run(tools.get("her_ui_act"), { action: "teleport", params: {} });

	assert.match(text, /unknown|not.*(available|supported)/i);
	assert.match(text, /set_output_view/); // lists what IS available
	assert.equal(fetchImpl.calls.filter((c) => c.method === "POST").length, 0, "no POST for an unknown action");
});

// Server-side rejection (bad params) is surfaced, not swallowed, and no false success.
test("her_ui_act surfaces a server rejection (bad params) without claiming success", async () => {
	const fetchImpl = routedFetch((call) => {
		if (call.url.endsWith("/api/ui/actions")) return json(CATALOG);
		if (call.method === "POST") return json({ ok: false, error: "invalid-params", detail: "bad view" }, 400);
		return json({ ok: false }, 500);
	});
	const tools = harness({ fetchImpl });

	const { text, details } = await run(tools.get("her_ui_act"), { action: "set_output_view", params: { view: "x" } });

	assert.match(text, /invalid-params|bad view|reject/i);
	assert.notEqual((details as { ok?: boolean }).ok, true);
});

// GIVEN the UI process is not running WHEN her_ui_act runs THEN a clear connection
// error, no false success, well within budget.
test("her_ui_act reports connection-refused when the UI is down, no false success", async () => {
	const fetchImpl = routedFetch(() => {
		throw new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), { code: "ECONNREFUSED" }),
		});
	});
	const tools = harness({ fetchImpl });

	const { text, details } = await run(tools.get("her_ui_act"), { action: "toggle_sidebar" });

	assert.match(text, /connection refused|reach|running/i);
	assert.notEqual((details as { ok?: boolean }).ok, true);
});

// GIVEN a posted action the panel never acks WHEN the receipt poll passes the budget
// THEN a timeout error (never a false success).
test("her_ui_act times out with an error when no ack arrives within the receipt budget", async () => {
	const fetchImpl = routedFetch((call) => {
		if (call.url.endsWith("/api/ui/actions")) return json(CATALOG);
		if (call.method === "POST") return json({ ok: true });
		if (call.url.includes("?id=")) return json({ ok: true, settled: false }); // never settles
		return json({ ok: false }, 500);
	});
	const tools = harness({ fetchImpl, receiptTimeoutMs: 120, pollIntervalMs: 20 });

	const { text, details } = await run(tools.get("her_ui_act"), { action: "toggle_sidebar" });

	assert.match(text, /timeout|did not confirm|no ack/i);
	assert.notEqual((details as { ok?: boolean }).ok, true);
});

// A settled receipt with ok:false is reported as a failure — never dressed as success.
test("her_ui_act reports a settled ok:false receipt as a failure", async () => {
	const fetchImpl = routedFetch((call) => {
		if (call.url.endsWith("/api/ui/actions")) return json(CATALOG);
		if (call.method === "POST") return json({ ok: true });
		if (call.url.includes("?id="))
			return json({ ok: true, settled: true, receipt: { ok: false, error: "panel error" } });
		return json({ ok: false }, 500);
	});
	const tools = harness({ fetchImpl });

	const { text, details } = await run(tools.get("her_ui_act"), { action: "toggle_sidebar" });

	assert.match(text, /fail|panel error/i);
	assert.notEqual((details as { ok?: boolean }).ok, true);
});

test("HER_UI_BASE_URL override routes every request to the overridden base", async () => {
	const fetchImpl = routedFetch((call) => {
		if (call.url.endsWith("/api/ui/actions")) return json(CATALOG);
		if (call.method === "POST") return json({ ok: true });
		if (call.url.includes("?id=")) return json({ ok: true, settled: true, receipt: { ok: true, state: STATE } });
		return json({ ok: false }, 500);
	});
	const tools = harness({ fetchImpl });
	const previous = process.env.HER_UI_BASE_URL;
	process.env.HER_UI_BASE_URL = "http://127.0.0.1:9999";
	try {
		await run(tools.get("her_ui_act"), { action: "toggle_sidebar" });
	} finally {
		if (previous === undefined) delete process.env.HER_UI_BASE_URL;
		else process.env.HER_UI_BASE_URL = previous;
	}
	assert.ok(
		fetchImpl.calls.every((c) => c.url.startsWith("http://127.0.0.1:9999")),
		"all calls hit the override",
	);
});

// Existence test (design test #7): the tool must be in the Cedar governed table or it
// silently bypasses authorization.
test("her_ui_act is registered as a non-destructive governed tool", () => {
	const fetchImpl = routedFetch(() => json(CATALOG));
	const tools = harness({ fetchImpl });
	assert.ok(tools.has("her_ui_act"));
	assert.equal(governedTools.her_ui_act?.destructive, false);
});
