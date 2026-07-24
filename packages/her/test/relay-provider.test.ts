import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRelayProviderTools } from "../src/providers-relay/tools.ts";

function mockPi(): { api: ExtensionAPI; tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }> } {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const api = {
		registerTool(def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.set(def.name, { execute: def.execute });
		},
	} as unknown as ExtensionAPI;
	return { api, tools };
}

async function run(
	tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined,
	args: Record<string, unknown>,
) {
	assert.ok(tool);
	const result = (await tool.execute("call-1", args, undefined, undefined, undefined)) as {
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
	};
	const text = result.content[0]?.text ?? "";
	return { text, details: result.details };
}

test("her_upsert_relay_provider reports success on 200 ok", async () => {
	const { api, tools } = mockPi();
	registerRelayProviderTools(api, {
		fetchImpl: async () =>
			new Response(
				JSON.stringify({
					ok: true,
					id: "tu-zi",
					resolvedBaseUrl: "https://api.tu-zi.com/v1",
					modelsTotal: 3,
					favorited: ["gpt-4o-mini"],
					smoke: { ok: true, modelId: "gpt-4o-mini", latencyMs: 120 },
					menuUpdated: true,
				}),
				{ status: 200 },
			),
	});

	const { text, details } = await run(tools.get("her_upsert_relay_provider"), {
		name: "兔子",
		baseUrl: "https://api.tu-zi.com",
		apiKey: "sk-test",
	});

	assert.match(text, /saved as tu-zi/);
	assert.match(text, /Live smoke OK/);
	assert.equal(details.ok, true);
});

test("her_upsert_relay_provider surfaces probe failure", async () => {
	const { api, tools } = mockPi();
	registerRelayProviderTools(api, {
		fetchImpl: async () =>
			new Response(JSON.stringify({ ok: false, stage: "probe", error: "unauthorized" }), { status: 502 }),
	});

	const { text } = await run(tools.get("her_upsert_relay_provider"), {
		name: "Bad",
		baseUrl: "https://bad.example",
		apiKey: "sk-x",
	});

	assert.match(text, /\[probe\]/);
	assert.match(text, /unauthorized/);
});

test("her_upsert_relay_provider is registered", () => {
	const { api, tools } = mockPi();
	registerRelayProviderTools(api);
	assert.ok(tools.has("her_upsert_relay_provider"));
});
