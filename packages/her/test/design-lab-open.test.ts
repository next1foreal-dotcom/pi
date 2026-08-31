import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import net from "node:net";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { governedTools } from "../src/extension.ts";
import {
	buildDesignLabBat,
	DEFAULT_STUDIO_UI_BASE_URL,
	DESIGN_LAB_PORT,
	DESIGN_LAB_URL,
	nestedStartArgs,
	probeListeningPort,
	resolveStudioUiBase,
} from "../src/preview/design-lab-open.ts";
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

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown> = {}) {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
}

function listenEphemeral(): Promise<{ port: number; close: () => Promise<void> }> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			resolve({
				port,
				close: () =>
					new Promise((closeResolve, closeReject) => {
						server.close((error) => (error ? closeReject(error) : closeResolve()));
					}),
			});
		});
	});
}

test("buildDesignLabBat writes pnpm -C <abs> dev with stdout/err redirected to the log", () => {
	const bat = buildDesignLabBat("D:\\lab", "D:\\logs\\lab.log");
	assert.match(bat, /pnpm -C "D:\\lab" dev/);
	assert.match(bat, /> "D:\\logs\\lab\.log" 2>&1/);
});

test("nestedStartArgs is cmd /c start empty-title /min bat (detached nested start)", () => {
	assert.deepEqual(nestedStartArgs("C:\\tmp\\lab.bat"), {
		command: "cmd",
		args: ["/c", "start", "", "/min", "C:\\tmp\\lab.bat"],
	});
});

test("resolveStudioUiBase reads HER_UI_BASE_URL and defaults to 4321 when env is missing", () => {
	assert.equal(resolveStudioUiBase({}), DEFAULT_STUDIO_UI_BASE_URL);
	assert.equal(DEFAULT_STUDIO_UI_BASE_URL, "http://127.0.0.1:4321");
	assert.equal(resolveStudioUiBase({ HER_UI_BASE_URL: "http://127.0.0.1:9999" }), "http://127.0.0.1:9999");
	assert.equal(resolveStudioUiBase({ HER_UI_BASE_URL: "  " }), DEFAULT_STUDIO_UI_BASE_URL);
});

test("probeListeningPort is a real TCP connect, true only while a socket is accepted", async () => {
	const listening = await listenEphemeral();
	try {
		assert.equal(await probeListeningPort(listening.port), true);
	} finally {
		await listening.close();
	}
	assert.equal(await probeListeningPort(listening.port), false);
});

test("design_lab_open is registered as a no-arg non-destructive governed tool", () => {
	const tools = previewHarness({ fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });
	assert.ok(tools.has("design_lab_open"));
	assert.equal(governedTools.design_lab_open?.destructive, false);
	assert.deepEqual(tools.get("design_lab_open")?.parameters, { type: "object", properties: {} });
});

test("already-listening reuses the server, skips start, navigates 5180 through the control-owner gate", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	let starts = 0;
	const tools = previewHarness({
		fetchImpl,
		designLab: {
			labPath: "D:\\lab",
			probe: async () => true,
			writeAndStart: async () => {
				starts += 1;
			},
		},
	});

	const { text, details } = await run(tools.get("design_lab_open"));

	assert.equal(starts, 0);
	assert.equal(details.status, "already-running");
	assert.match(text, /already-running|already listening/i);
	assert.equal(fetchImpl.calls.length, 1);
	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:4321/api/browser/agent-navigate");
	assert.equal(fetchImpl.calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { url: DESIGN_LAB_URL });
	assert.equal(DESIGN_LAB_PORT, 5180);
	assert.equal(DESIGN_LAB_URL, "http://localhost:5180");
});

test("not listening starts via nested bat then reports opened after the port is actually listening", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	let listening = false;
	const starts: Array<{ batContents: string; command: string; args: string[] }> = [];
	const tools = previewHarness({
		fetchImpl,
		designLab: {
			labPath: "D:\\lab",
			packageExists: true,
			waitMs: 200,
			pollMs: 5,
			probe: async () => listening,
			writeAndStart: async (input) => {
				starts.push({ batContents: input.batContents, command: input.command, args: input.args });
				listening = true;
			},
		},
	});

	const { text, details } = await run(tools.get("design_lab_open"));

	assert.equal(starts.length, 1);
	assert.match(starts[0].batContents, /pnpm -C "D:\\lab" dev/);
	assert.match(starts[0].batContents, /2>&1/);
	assert.equal(starts[0].command, "cmd");
	assert.deepEqual(starts[0].args.slice(0, 4), ["/c", "start", "", "/min"]);
	assert.equal(details.status, "opened");
	assert.match(text, /opened/i);
	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:4321/api/browser/agent-navigate");
	assert.deepEqual(JSON.parse(String(fetchImpl.calls[0].init.body)), { url: "http://localhost:5180" });
});

test("port never listening is failed with a reason and does not navigate (Ready-in-a-log is not green)", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	let t = 0;
	const tools = previewHarness({
		fetchImpl,
		designLab: {
			labPath: "D:\\lab",
			packageExists: true,
			waitMs: 40,
			pollMs: 10,
			now: () => t,
			sleep: async (ms) => {
				t += ms;
			},
			probe: async () => false,
			writeAndStart: async () => {},
		},
	});

	const { text, details } = await run(tools.get("design_lab_open"));

	assert.equal(details.status, "failed");
	assert.match(text, /failed/i);
	assert.match(text, /5180|listen|timeout/i);
	assert.equal(fetchImpl.calls.length, 0);
});

test("start throw is failed with the reason and does not navigate", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const tools = previewHarness({
		fetchImpl,
		designLab: {
			labPath: "D:\\lab",
			packageExists: true,
			probe: async () => false,
			writeAndStart: async () => {
				throw new Error("spawn EPERM");
			},
		},
	});

	const { text, details } = await run(tools.get("design_lab_open"));

	assert.equal(details.status, "failed");
	assert.match(text, /spawn EPERM/);
	assert.equal(fetchImpl.calls.length, 0);
});

test("missing lab package when the port is down fails closed without a half-started spawn", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	let starts = 0;
	const tools = previewHarness({
		fetchImpl,
		designLab: {
			labPath: "D:\\definitely-not-a-design-lab-package",
			packageExists: false,
			probe: async () => false,
			writeAndStart: async () => {
				starts += 1;
			},
		},
	});

	const { text, details } = await run(tools.get("design_lab_open"));

	assert.equal(starts, 0);
	assert.equal(details.status, "failed");
	assert.match(text, /not found|missing/i);
	assert.equal(fetchImpl.calls.length, 0);
});

test("HER_UI_BASE_URL override is the navigate base; missing env does not fall back to 3000", async () => {
	const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	const previous = process.env.HER_UI_BASE_URL;
	process.env.HER_UI_BASE_URL = "http://127.0.0.1:7777";
	try {
		const tools = previewHarness({
			fetchImpl,
			designLab: { probe: async () => true, writeAndStart: async () => {} },
		});
		await run(tools.get("design_lab_open"));
	} finally {
		if (previous === undefined) delete process.env.HER_UI_BASE_URL;
		else process.env.HER_UI_BASE_URL = previous;
	}
	assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:7777/api/browser/agent-navigate");
});

test("control-owner-denied uses the same handback wording as browser_navigate", async () => {
	const fetchImpl = fakeFetch(
		() => new Response(JSON.stringify({ ok: false, error: "control-owner-denied" }), { status: 409 }),
	);
	const tools = previewHarness({
		fetchImpl,
		designLab: { probe: async () => true, writeAndStart: async () => {} },
	});

	const denied = await run(tools.get("design_lab_open"));
	const navigateDenied = await run(tools.get("browser_navigate"), { url: "https://example.com" });

	assert.match(denied.text, /Fei/);
	assert.match(denied.text, /hand.*back|handback/i);
	assert.equal(denied.details.status, "failed");
	assert.equal(denied.text, navigateDenied.text);
});

test("navigate connection-refused is failed naming the Studio base, no throw", async () => {
	const fetchImpl = fakeFetch(() => {
		throw new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4321"), { code: "ECONNREFUSED" }),
		});
	});
	const tools = previewHarness({
		fetchImpl,
		designLab: { probe: async () => true, writeAndStart: async () => {} },
	});

	const { text, details } = await run(tools.get("design_lab_open"));
	assert.equal(details.status, "failed");
	assert.match(text, /127\.0\.0\.1:4321/);
	assert.match(text, /connection refused/i);
});
