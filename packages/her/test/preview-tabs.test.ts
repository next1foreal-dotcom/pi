import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TObject } from "typebox";
import { governedTools } from "../src/lib/governed-tools.ts";
import { registerPreviewTools } from "../src/preview/tools.ts";

function harness(reply: Record<string, unknown> = { ok: true }) {
	const tools = new Map<string, ToolDefinition>();
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerPreviewTools(pi, {
		fetchImpl: async (input, init) => {
			calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
			return Response.json(reply);
		},
	});
	async function run(name: string, params: Record<string, unknown> = {}) {
		const tool = tools.get(name);
		assert.ok(tool, `${name} must be registered`);
		return tool.execute("test", params, undefined, undefined, undefined as never);
	}
	return { tools, calls, run };
}

const cases: Array<[string, Record<string, unknown>]> = [
	["browser_navigate", { url: "https://example.com" }],
	["browser_read_page", {}],
	["browser_act", { ref: "ref_2", action: "click" }],
	["browser_find", { query: "Example" }],
	["browser_get_text", {}],
	["browser_console", {}],
	["browser_network", { requestId: "req-1" }],
	["browser_screenshot", {}],
	["browser_computer", { act: { action: "wait", duration: 1 } }],
	["browser_form_input", { ref: "ref_3", value: false }],
	["browser_eval", { code: "document.title" }],
	["browser_viewport", { preset: "mobile" }],
	["browser_history", { direction: "back" }],
];
for (const [name, input] of cases) {
	test(`${name} exposes tabId and sends it without dropping other input`, async () => {
		const h = harness();
		const schema = h.tools.get(name)?.parameters;
		assert.ok((schema as TObject).properties.tabId, "model must be able to supply tabId");
		await h.run(name, { ...input, tabId: "tab-b" });
		assert.deepEqual(h.calls[0].body, { ...input, tabId: "tab-b" });
		await h.run(name, input);
		assert.deepEqual(h.calls[1].body, input, "omitted tabId keeps active-tab semantics");
	});
}
for (const [action, input, reply] of [
	[
		"context",
		{},
		{ ok: true, activeTabId: "a", tabs: [{ id: "a", title: "Example", url: "https://example.com", isActive: true }] },
	],
	["create", { url: "https://example.com", foreground: false }, { ok: true, tabId: "b", activeTabId: "a" }],
	["select", { tabId: "b" }, { ok: true, activeTabId: "b" }],
	["close", { tabId: "b" }, { ok: true, closed: true, activeTabId: "a" }],
] as const) {
	test(`browser_tabs_${action} calls the tabs route and returns tab identities`, async () => {
		const h = harness(reply);
		const name = `browser_tabs_${action}`;
		assert.deepEqual(governedTools[name], { destructive: false });
		const result = await h.run(name, input);
		assert.deepEqual(h.calls, [{ path: "/api/browser/tabs", body: { action, ...input } }]);
		assert.equal(result.content[0].type, "text");
		if (result.content[0].type === "text") assert.deepEqual(JSON.parse(result.content[0].text), reply);
	});
}
test("tabs are batchable and a denied switch stops before any follow-up read", async () => {
	const h = harness({ ok: false, reason: "control-owner-denied" });
	const result = await h.run("browser_batch", {
		actions: [
			{ name: "browser_tabs_select", input: { tabId: "b" } },
			{ name: "browser_read_page", input: { tabId: "b" } },
		],
	});
	assert.equal(h.calls.length, 1);
	if (result.content[0].type === "text") assert.match(result.content[0].text, /control-owner-denied/);
});
test("missing tab reason is preserved and batch does not continue", async () => {
	const h = harness({ ok: false, reason: "no-such-tab", message: "Unknown tab: b" });
	const result = await h.run("browser_batch", {
		actions: [
			{ name: "browser_tabs_select", input: { tabId: "b" } },
			{ name: "browser_get_text", input: { tabId: "b" } },
		],
	});
	assert.equal(h.calls.length, 1);
	if (result.content[0].type === "text") assert.match(result.content[0].text, /no-such-tab.*Unknown tab: b/);
});
test("batch carries tabId to each step and returns tab context", async () => {
	const h = harness({ ok: true, activeTabId: "a", tabs: [] });
	const result = await h.run("browser_batch", {
		actions: [{ name: "browser_read_page", input: { tabId: "b" } }, { name: "browser_tabs_context" }],
	});
	assert.equal(h.calls.length, 2);
	assert.equal(h.calls[0].body.tabId, "b");
	if (result.content[0].type === "text") assert.match(result.content[0].text, /activeTabId/);
});
