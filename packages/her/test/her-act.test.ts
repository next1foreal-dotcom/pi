import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { governedTools } from "../src/extension.ts";
import { type HerActToolDeps, registerHerActTools } from "../src/her-actions/tools.ts";

type FetchCall = { url: string; method: string; body?: string };

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

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function collectTools(deps: HerActToolDeps = {}): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(def: ToolDefinition) {
			tools.set(def.name, def);
		},
	} as ExtensionAPI;
	registerHerActTools(pi, deps);
	return tools;
}

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
	assert.ok(tool);
	const result = (await tool.execute("t1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
}

test("governedTools lists her_act as non-destructive", () => {
	assert.equal(governedTools.her_act?.destructive, false);
});

test("her_act returns server-channel result without polling UI receipt", async () => {
	const fetchImpl = routedFetch((call) => {
		if (call.method === "GET" && call.url.endsWith("/api/her/actions")) {
			return json({
				ok: true,
				actions: [{ action: "task.list", channel: "server" }],
			});
		}
		if (call.method === "POST" && call.url.endsWith("/api/her/actions")) {
			return json({
				ok: true,
				channel: "server",
				action: "task.list",
				result: { configured: true, tasks: [{ id: "t1" }] },
			});
		}
		return json({ ok: false }, 404);
	});
	const tools = collectTools({ fetchImpl, idFactory: () => "fixed-id" });
	const { details } = await run(tools.get("her_act"), { action: "task.list", params: {} });
	assert.equal(details.ok, true);
	assert.equal(details.channel, "server");
	assert.equal(
		fetchImpl.calls.some((c) => c.url.includes("/api/ui/action")),
		false,
	);
});

test("her_act rejects unknown actions from live catalog", async () => {
	const fetchImpl = routedFetch((call) => {
		if (call.method === "GET") {
			return json({ ok: true, actions: [{ action: "task.list", channel: "server" }] });
		}
		return json({ ok: false }, 500);
	});
	const tools = collectTools({ fetchImpl });
	const { text, details } = await run(tools.get("her_act"), { action: "teleport", params: {} });
	assert.equal(details.ok, false);
	assert.match(text, /Unknown Her action/);
});

test("her_act polls UI receipt for ui-channel actions", async () => {
	let polls = 0;
	const fetchImpl = routedFetch((call) => {
		if (call.method === "GET" && call.url.endsWith("/api/her/actions")) {
			return json({
				ok: true,
				actions: [{ action: "set_output_view", channel: "ui" }],
			});
		}
		if (call.method === "POST" && call.url.endsWith("/api/her/actions")) {
			return json({ ok: true, channel: "ui", action: "set_output_view", id: "fixed-id", pending: true });
		}
		if (call.url.includes("/api/ui/action?id=")) {
			polls += 1;
			if (polls < 2) return json({ ok: true, settled: false });
			return json({
				ok: true,
				settled: true,
				receipt: {
					ok: true,
					state: { mode: "code", outputView: "preview", sidebarCollapsed: false, drawer: null },
				},
			});
		}
		return json({ ok: false }, 404);
	});
	const tools = collectTools({
		fetchImpl,
		idFactory: () => "fixed-id",
		sleep: async () => undefined,
	});
	const { details } = await run(tools.get("her_act"), {
		action: "set_output_view",
		params: { view: "preview" },
	});
	assert.equal(details.ok, true);
	assert.equal(details.channel, "ui");
	assert.ok(polls >= 2);
});
