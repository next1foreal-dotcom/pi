import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { governedTools } from "../src/lib/governed-tools.ts";
import { type PreviewStillToolDeps, registerPreviewStillTools } from "../src/preview/still-tools.ts";

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

function stillHarness(deps: PreviewStillToolDeps) {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerPreviewStillTools(pi, deps);
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

test("governedTools lists her_preview_still as non-destructive", () => {
	assert.equal(governedTools.her_preview_still?.destructive, false);
});

test("her_preview_still posts workspaceId and reports the minted path", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: true, path: "references/preview-01.png" }), { status: 200 }),
	);
	const tools = stillHarness({ fetchImpl, workspaceId: "ws-from-env", uiBase: "http://127.0.0.1:4321" });
	const { text, details } = await run(tools.get("her_preview_still"), {});
	assert.match(text, /references\/preview-01\.png/);
	assert.equal(details.ok, true);
	assert.equal(fetchImpl.calls.length, 1);
	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:4321/api/design/preview-still");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { workspaceId: "ws-from-env" });
});

test("her_preview_still prefers an explicit workspaceId over the env default", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: true, path: "references/preview-01.png" }), { status: 200 }),
	);
	const tools = stillHarness({ fetchImpl, workspaceId: "ws-env" });
	await run(tools.get("her_preview_still"), { workspaceId: "ws-arg" });
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { workspaceId: "ws-arg" });
});

test("her_preview_still treats a skipped still as skip, not a crash", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, skipped: true, reason: "no-chromium" }), { status: 200 }),
	);
	const tools = stillHarness({ fetchImpl, workspaceId: "ws1" });
	const { text, details } = await run(tools.get("her_preview_still"), {});
	assert.match(text, /skipped/);
	assert.match(text, /no-chromium/);
	assert.equal(details.skipped, true);
});

test("her_preview_still refuses to invent a workspaceId", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = stillHarness({ fetchImpl });
	const { text, details } = await run(tools.get("her_preview_still"), {});
	assert.match(text, /Missing workspaceId/);
	assert.equal(details.ok, false);
	assert.equal(fetchImpl.calls.length, 0);
});
