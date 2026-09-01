import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type ConnectorProblem, loadConnectors, registerMcpTools, renderToolContent } from "../src/mcp/tools.ts";

const SERVER_FILESYSTEM_BIN = join(
	process.cwd(),
	"node_modules",
	"@modelcontextprotocol",
	"server-filesystem",
	"dist",
	"index.js",
);
const hasServerFilesystem = existsSync(SERVER_FILESYSTEM_BIN);
const serverFilesystemSkipReason =
	"@modelcontextprotocol/server-filesystem (devDependency) is not installed under node_modules; " +
	"run `npm install --workspace packages/her` before this integration smoke can run.";

function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "her-mcp-"));
}

async function writeManifest(repoRoot: string, manifest: unknown): Promise<void> {
	await mkdir(join(repoRoot, ".her"), { recursive: true });
	await writeFile(join(repoRoot, ".her", "connectors.json"), JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * registerMcpTools also subscribes to events now (the startup status report),
 * so the stand-in has to offer `on` — captured rather than dropped, so a test
 * can drive a handler instead of only proving registration did not throw.
 */
/** Loose stand-in for an extension event handler; the tests drive them by hand. */
type ExtHandler = (event: unknown, ctx?: unknown) => unknown;

function mcpHarnessFull(): { tools: Map<string, ToolDefinition>; handlers: Map<string, ExtHandler[]> } {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, ExtHandler[]>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: ExtHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	registerMcpTools(pi);
	return { tools, handlers };
}

function mcpHarness(): Map<string, ToolDefinition> {
	return mcpHarnessFull().tools;
}

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface ToolCallResult {
	content: ToolContent[];
	details: Record<string, unknown>;
	text: string;
}

async function runFull(
	tool: ToolDefinition | undefined,
	params: Record<string, unknown>,
	cwd: string,
): Promise<ToolCallResult> {
	assert.ok(tool, "tool not registered");
	const ctx = { cwd } as unknown as ExtensionContext;
	const result = (await tool.execute("call-1", params, undefined, undefined, ctx)) as {
		content: ToolContent[];
		details?: Record<string, unknown>;
	};
	const text = result.content
		.filter((item): item is Extract<ToolContent, { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	return { content: result.content, text, details: result.details ?? {} };
}

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>, cwd: string): Promise<string> {
	return (await runFull(tool, params, cwd)).text;
}

test("renderToolContent preserves text behavior and the empty fallback", () => {
	assert.deepEqual(
		renderToolContent([
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		]),
		[{ type: "text", text: "first\nsecond" }],
	);
	assert.deepEqual(renderToolContent([]), [{ type: "text", text: "（外接服务未返回文本）" }]);
});

test("renderToolContent passes through valid images and defaults invalid mime types", () => {
	assert.deepEqual(
		renderToolContent([
			{ type: "image", data: "AAAA" },
			{ type: "image", data: "AAAA", mimeType: "text/plain" },
		]),
		[
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		],
	);
});

test("renderToolContent puts text before images regardless of input order", () => {
	assert.deepEqual(
		renderToolContent([
			{ type: "image", data: "AAAA", mimeType: "image/jpeg" },
			{ type: "text", text: "caption" },
		]),
		[
			{ type: "text", text: "caption" },
			{ type: "image", data: "AAAA", mimeType: "image/jpeg" },
		],
	);
});

test("renderToolContent degrades invalid image base64 without throwing", () => {
	assert.deepEqual(renderToolContent([{ type: "image", data: "not base64!" }]), [
		{ type: "text", text: "[image:invalid]" },
	]);
});

test("renderToolContent skips an oversized image with a text explanation", () => {
	const data = "A".repeat(Math.ceil((8 * 1024 * 1024 * 4) / 3) + 1);
	const rendered = renderToolContent([{ type: "image", data }]);
	assert.equal(rendered.length, 1);
	assert.equal(rendered[0]?.type, "text");
	if (rendered[0]?.type !== "text") return;
	assert.match(rendered[0].text, /^图片过大，.+ MB，已略过$/);
});

test("renderToolContent passes at most four images and reports the remainder", () => {
	const rendered = renderToolContent(new Array(6).fill({ type: "image", data: "AAAA" }));
	assert.equal(rendered.filter((item) => item.type === "image").length, 4);
	assert.equal(rendered[0]?.type, "text");
	if (rendered[0]?.type !== "text") return;
	assert.equal(rendered[0].text, "已略过 2 张图片");
});

test("renderToolContent degrades non-image non-text blocks to their type placeholder", () => {
	assert.deepEqual(renderToolContent([{ type: "audio", data: "AAAA" }]), [{ type: "text", text: "[audio]" }]);
});
/** Poll process.kill(pid, 0) so a slow Windows teardown doesn't produce a false failure (mirrors the G-51 spike). */
async function assertProcessExited(pid: number | undefined): Promise<void> {
	assert.ok(pid, "expected a pid to be captured for this call");
	for (let attempt = 0; attempt < 15; attempt++) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			assert.equal((error as NodeJS.ErrnoException).code, "ESRCH", `expected process ${pid} to be gone`);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	assert.fail(`process ${pid} did not exit within the polling window`);
}

test("her_mcp_list reports 'not configured' without throwing when .her/connectors.json is missing", async () => {
	const repoRoot = await tempRoot();
	const tools = mcpHarness();

	const text = await run(tools.get("her_mcp_list"), {}, repoRoot);

	assert.match(text, /未配置任何外接/);
});

test("her_mcp_call also reports 'not configured' without throwing when the manifest is missing", async () => {
	const repoRoot = await tempRoot();
	const tools = mcpHarness();

	const text = await run(tools.get("her_mcp_call"), { connector: "filesystem", tool: "list_directory" }, repoRoot);

	assert.match(text, /未配置任何外接/);
});

test("loadConnectors rejects a plaintext-secret-looking env value but keeps loading the other connectors", async () => {
	const repoRoot = await tempRoot();
	await writeManifest(repoRoot, {
		version: 1,
		connectors: [
			{
				slug: "leaky",
				label: "Leaky Connector",
				type: "stdio",
				command: "node",
				args: [],
				env: { TOKEN: "hardcoded-plaintext-not-a-var-reference-1234567890" },
			},
			{ slug: "clean", label: "Clean Connector", type: "stdio", command: "node", args: [] },
		],
	});

	const loaded = await loadConnectors(repoRoot, {});

	assert.equal(loaded.kind, "loaded");
	if (loaded.kind !== "loaded") return;
	const leaky = loaded.connectors.find((connector) => connector.slug === "leaky") as ConnectorProblem | undefined;
	const clean = loaded.connectors.find((connector) => connector.slug === "clean");
	assert.equal(leaky?.status, "invalid");
	assert.match(leaky?.reason ?? "", /密钥必须走环境变量/);
	assert.equal(clean?.status, "ready");
});

test("her_mcp_list surfaces two independent per-connector problems through the tool, without crashing", async () => {
	// Both entries are invalid at the config-validation stage (before any process would be spawned), so this stays a
	// fast unit-level check of per-connector isolation. The real-connect success/failure paths are covered separately
	// by the integration-smoke tests below; loadConnectors' own "other entries keep loading" behavior is covered by
	// the dedicated loadConnectors test above.
	const repoRoot = await tempRoot();
	await writeManifest(repoRoot, {
		version: 1,
		connectors: [
			{
				slug: "leaky",
				label: "Leaky Connector",
				type: "stdio",
				command: "node",
				args: [],
				env: { TOKEN: "hardcoded-plaintext-not-a-var-reference-1234567890" },
			},
			// Was "http is unsupported"; http is supported now, so the second
			// problem is a genuinely malformed http entry — one with no url.
			{ slug: "http-nourl", label: "HTTP Connector", type: "http" },
		],
	});
	const tools = mcpHarness();

	const text = await run(tools.get("her_mcp_list"), {}, repoRoot);

	assert.match(text, /leaky（Leaky Connector）：坏配置，密钥必须走环境变量。/);
	assert.match(text, /http-nourl（HTTP Connector）：坏配置，url 不能为空。/);
});

test("http connector: resolves $VAR headers and reports ready", async () => {
	const repoRoot = await tempRoot();
	await writeManifest(repoRoot, {
		version: 1,
		connectors: [
			{
				slug: "github",
				label: "GitHub",
				type: "http",
				url: "https://api.example.com/mcp/",
				headers: { Authorization: "$HER_TEST_GH_TOKEN" },
			},
		],
	});

	const loaded = await loadConnectors(repoRoot, { HER_TEST_GH_TOKEN: "Bearer secret-token" });

	assert.equal(loaded.kind, "loaded");
	if (loaded.kind !== "loaded") return;
	const [connector] = loaded.connectors;
	assert.equal(connector.status, "ready");
	if (connector.status !== "ready") return;
	assert.equal(connector.transport, "http");
	if (connector.transport !== "http") return;
	assert.equal(connector.url, "https://api.example.com/mcp/");
	assert.equal(connector.headers.Authorization, "Bearer secret-token");
	// The token must be registered for redaction, or it can leak through an error.
	assert.ok(connector.secrets.includes("Bearer secret-token"));
});

test("http connector: a literal header value is refused, same as env", async () => {
	const repoRoot = await tempRoot();
	await writeManifest(repoRoot, {
		version: 1,
		connectors: [
			{
				slug: "leaky-http",
				label: "Leaky HTTP",
				type: "http",
				url: "https://api.example.com/mcp/",
				headers: { Authorization: "Bearer ghp-hardcoded-token-value-1234567890" },
			},
		],
	});

	const loaded = await loadConnectors(repoRoot, {});

	assert.equal(loaded.kind, "loaded");
	if (loaded.kind !== "loaded") return;
	assert.equal(loaded.connectors[0].status, "invalid");
	assert.match((loaded.connectors[0] as { reason: string }).reason, /密钥必须走环境变量/);
});

test("http connector: names the unset env var instead of connecting without it", async () => {
	const repoRoot = await tempRoot();
	await writeManifest(repoRoot, {
		version: 1,
		connectors: [
			{
				slug: "github",
				label: "GitHub",
				type: "http",
				url: "https://api.example.com/mcp/",
				headers: { Authorization: "$HER_TEST_ABSENT_TOKEN" },
			},
		],
	});

	const loaded = await loadConnectors(repoRoot, {});

	assert.equal(loaded.kind, "loaded");
	if (loaded.kind !== "loaded") return;
	assert.equal(loaded.connectors[0].status, "missing_credentials");
	assert.match((loaded.connectors[0] as { reason: string }).reason, /HER_TEST_ABSENT_TOKEN/);
});

test("http connector: plaintext http is refused off-machine, allowed on loopback", async () => {
	// Both sides: a rule that only ever rejects is the same bug as one that
	// only ever accepts. A token in an Authorization header over plain http to
	// a remote host is the token on the wire.
	const repoRoot = await tempRoot();
	await writeManifest(repoRoot, {
		version: 1,
		connectors: [
			{ slug: "remote-plain", label: "Remote plaintext", type: "http", url: "http://api.example.com/mcp/" },
			{ slug: "loopback", label: "Loopback", type: "http", url: "http://127.0.0.1:9000/mcp/" },
		],
	});

	const loaded = await loadConnectors(repoRoot, {});

	assert.equal(loaded.kind, "loaded");
	if (loaded.kind !== "loaded") return;
	assert.equal(loaded.connectors[0].status, "invalid");
	assert.match((loaded.connectors[0] as { reason: string }).reason, /必须是 https/);
	assert.equal(loaded.connectors[1].status, "ready");
});

test("loadConnectors marks a connector missing_credentials and names the unset env var, without crashing", async () => {
	const repoRoot = await tempRoot();
	await writeManifest(repoRoot, {
		version: 1,
		connectors: [
			{
				slug: "needs-token",
				label: "Needs Token",
				type: "stdio",
				command: "node",
				args: [],
				env: { TOKEN: "$HER_CONNECTOR_TEST_TOKEN" },
			},
		],
	});
	delete process.env.HER_CONNECTOR_TEST_TOKEN;

	const loaded = await loadConnectors(repoRoot, {});

	assert.equal(loaded.kind, "loaded");
	if (loaded.kind !== "loaded") return;
	const connector = loaded.connectors[0] as ConnectorProblem;
	assert.equal(connector.status, "missing_credentials");
	assert.match(connector.reason, /HER_CONNECTOR_TEST_TOKEN/);
});

test("her_mcp_list reports missing_credentials with the env var name through the tool, without throwing", async () => {
	const repoRoot = await tempRoot();
	await writeManifest(repoRoot, {
		version: 1,
		connectors: [
			{
				slug: "needs-token",
				label: "Needs Token",
				type: "stdio",
				command: "node",
				args: [],
				env: { TOKEN: "$HER_CONNECTOR_TEST_TOKEN" },
			},
		],
	});
	delete process.env.HER_CONNECTOR_TEST_TOKEN;
	const tools = mcpHarness();

	const text = await run(tools.get("her_mcp_list"), {}, repoRoot);

	assert.match(text, /缺凭据/);
	assert.match(text, /HER_CONNECTOR_TEST_TOKEN/);
});

test("loadConnectors reports a clear error for malformed manifest JSON", async () => {
	const repoRoot = await tempRoot();
	await mkdir(join(repoRoot, ".her"), { recursive: true });
	await writeFile(join(repoRoot, ".her", "connectors.json"), "{ this is not json", "utf8");

	const loaded = await loadConnectors(repoRoot, {});

	assert.equal(loaded.kind, "manifest_error");
	if (loaded.kind !== "manifest_error") return;
	assert.match(loaded.message, /JSON/);
});

test("her_mcp_list surfaces the malformed-JSON error through the tool instead of throwing", async () => {
	const repoRoot = await tempRoot();
	await mkdir(join(repoRoot, ".her"), { recursive: true });
	await writeFile(join(repoRoot, ".her", "connectors.json"), "{ this is not json", "utf8");
	const tools = mcpHarness();

	const text = await run(tools.get("her_mcp_list"), {}, repoRoot);

	assert.match(text, /JSON/);
});

test("loadConnectors reports a clear error for an unsupported manifest version", async () => {
	const repoRoot = await tempRoot();
	await writeManifest(repoRoot, { version: 99, connectors: [] });

	const loaded = await loadConnectors(repoRoot, {});

	assert.equal(loaded.kind, "manifest_error");
	if (loaded.kind !== "manifest_error") return;
	assert.match(loaded.message, /version/i);
	assert.match(loaded.message, /99/);
});

test(
	"integration smoke: her_mcp_call against a real server-filesystem lists real file names and exits its child process",
	{ skip: hasServerFilesystem ? false : serverFilesystemSkipReason },
	async () => {
		const repoRoot = await tempRoot();
		const targetDir = await tempRoot();
		await writeFile(join(targetDir, "alpha.txt"), "alpha", "utf8");
		await writeFile(join(targetDir, "beta.md"), "# beta", "utf8");
		await writeManifest(repoRoot, {
			version: 1,
			connectors: [
				{
					slug: "filesystem",
					label: "本地文件目录",
					type: "stdio",
					command: process.execPath,
					args: [SERVER_FILESYSTEM_BIN, targetDir],
				},
			],
		});
		const tools = mcpHarness();

		const listed = await runFull(
			tools.get("her_mcp_call"),
			{ connector: "filesystem", tool: "list_directory", params: { path: targetDir } },
			repoRoot,
		);

		assert.match(listed.text, /alpha\.txt/);
		assert.match(listed.text, /beta\.md/);
		await assertProcessExited(listed.details.pid as number | undefined);
	},
);

test(
	"integration smoke: her_mcp_call against a real server-filesystem fails clean for an unknown tool and still exits",
	{ skip: hasServerFilesystem ? false : serverFilesystemSkipReason },
	async () => {
		const repoRoot = await tempRoot();
		const targetDir = await tempRoot();
		await writeManifest(repoRoot, {
			version: 1,
			connectors: [
				{
					slug: "filesystem",
					label: "本地文件目录",
					type: "stdio",
					command: process.execPath,
					args: [SERVER_FILESYSTEM_BIN, targetDir],
				},
			],
		});
		const tools = mcpHarness();

		const missing = await runFull(
			tools.get("her_mcp_call"),
			{ connector: "filesystem", tool: "does_not_exist" },
			repoRoot,
		);

		assert.match(missing.text, /不存在工具/);
		await assertProcessExited(missing.details.pid as number | undefined);
	},
);

test("her_mcp_call reports a human error for an unknown connector slug, without throwing", async () => {
	const repoRoot = await tempRoot();
	await writeManifest(repoRoot, {
		version: 1,
		connectors: [{ slug: "clean", label: "Clean Connector", type: "stdio", command: "node", args: [] }],
	});
	const tools = mcpHarness();

	const text = await run(tools.get("her_mcp_call"), { connector: "does-not-exist", tool: "whatever" }, repoRoot);

	assert.match(text, /未找到外接服务/);
});

/**
 * The transport seam, live. Mocks cannot prove a transport works: the failure
 * mode that matters here is silent — headers not actually reaching the server
 * turns every real connector into an unexplained 401. So this stands up a real
 * MCP server over streamable HTTP on loopback and drives the whole path.
 */
test("integration smoke: an http connector really lists and calls tools, and its headers arrive", async () => {
	const { createServer } = await import("node:http");
	const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
	const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
	const { z } = await import("zod");

	const AUTH = "Bearer seam-token-must-not-leak";
	let sawAuth: string | undefined;

	// Stateless mode wants a fresh server + transport per request.
	const httpServer = createServer((rq, rs) => {
		if (rq.headers.authorization) sawAuth = rq.headers.authorization;
		let body = "";
		rq.on("data", (c) => {
			body += c;
		});
		rq.on("end", async () => {
			let parsed: unknown;
			try {
				parsed = body ? JSON.parse(body) : undefined;
			} catch {
				parsed = undefined;
			}
			const mcp = new McpServer({ name: "seam-test", version: "1.0.0" });
			mcp.registerTool(
				"echo",
				{ description: "echo back", inputSchema: { text: z.string() } },
				async ({ text }: { text: string }) => ({ content: [{ type: "text" as const, text: `echoed:${text}` }] }),
			);
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			rs.on("close", () => void transport.close().catch(() => undefined));
			try {
				await mcp.connect(transport);
				await transport.handleRequest(rq, rs, parsed);
			} catch {
				if (!rs.headersSent) rs.writeHead(500).end();
			}
		});
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const { port } = httpServer.address() as { port: number };

	try {
		const repoRoot = await tempRoot();
		await writeManifest(repoRoot, {
			version: 1,
			connectors: [
				{
					slug: "seam",
					label: "Seam",
					type: "http",
					url: `http://127.0.0.1:${port}/mcp`,
					headers: { Authorization: "$HER_TEST_SEAM_TOKEN" },
				},
			],
		});
		const tools = mcpHarness();
		const previous = process.env.HER_TEST_SEAM_TOKEN;
		process.env.HER_TEST_SEAM_TOKEN = AUTH;
		try {
			const listed = await run(tools.get("her_mcp_list"), {}, repoRoot);
			assert.match(listed, /seam/);

			const called = await run(
				tools.get("her_mcp_call"),
				{ connector: "seam", tool: "echo", params: { text: "hello-from-her" } },
				repoRoot,
			);
			assert.match(called, /echoed:hello-from-her/);
			// The header must actually go out; a dropped one reads as a 401.
			assert.equal(sawAuth, AUTH);
			// And the token must never appear in what the tool hands back.
			assert.equal(called.includes(AUTH), false);
		} finally {
			if (previous === undefined) delete process.env.HER_TEST_SEAM_TOKEN;
			else process.env.HER_TEST_SEAM_TOKEN = previous;
		}
	} finally {
		await new Promise<void>((resolve) => httpServer.close(() => resolve()));
	}
});

/**
 * Remote tools as first-class tools — the gap against Claude Code, which
 * surfaces every connected server's tools directly instead of making you ask
 * a generic caller what exists.
 */
test("integration smoke: refresh caches a live server's tools, and they register as mcp__slug__tool", async () => {
	const { createServer } = await import("node:http");
	const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
	const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
	const { z } = await import("zod");
	const { readToolCacheSync, toolNameFor } = await import("../src/mcp/registry.ts");
	const { registerCachedRemoteTools } = await import("../src/mcp/tools.ts");

	const httpServer = createServer((rq, rs) => {
		let body = "";
		rq.on("data", (c) => {
			body += c;
		});
		rq.on("end", async () => {
			let parsed: unknown;
			try {
				parsed = body ? JSON.parse(body) : undefined;
			} catch {
				parsed = undefined;
			}
			const mcp = new McpServer({ name: "reg-test", version: "1.0.0" });
			mcp.registerTool(
				"echo",
				{ description: "echo back", inputSchema: { text: z.string() } },
				async ({ text }: { text: string }) => ({ content: [{ type: "text" as const, text: `echoed:${text}` }] }),
			);
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			rs.on("close", () => void transport.close().catch(() => undefined));
			try {
				await mcp.connect(transport);
				await transport.handleRequest(rq, rs, parsed);
			} catch {
				if (!rs.headersSent) rs.writeHead(500).end();
			}
		});
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const { port } = httpServer.address() as { port: number };

	try {
		const repoRoot = await tempRoot();
		await writeManifest(repoRoot, {
			version: 1,
			connectors: [{ slug: "seam", label: "Seam", type: "http", url: `http://127.0.0.1:${port}/mcp` }],
		});

		// Nothing is cached yet, so nothing registers — she has no remote tools.
		const before = mcpHarness();
		registerCachedRemoteTools({ registerTool: (t: ToolDefinition) => before.set(t.name, t) } as never, repoRoot);
		assert.equal(before.has(toolNameFor("seam", "echo")), false, "no cache means no remote tools");

		const refreshed = await run(mcpHarness().get("her_mcp_refresh"), {}, repoRoot);
		assert.match(refreshed, /seam：1 个工具/);
		// It must say the tools are not live until the next start; claiming
		// otherwise would have her reach for a tool that is not registered.
		assert.match(refreshed, /下次启动/);

		const cache = readToolCacheSync(repoRoot);
		assert.equal(cache.connectors.length, 1);
		assert.equal(cache.connectors[0].tools[0].name, "echo");
		assert.ok(cache.connectors[0].tools[0].inputSchema, "the remote schema is cached, not re-invented");

		// Now registration finds it, and the first-class tool really calls out.
		const after = new Map<string, ToolDefinition>();
		registerCachedRemoteTools({ registerTool: (t: ToolDefinition) => after.set(t.name, t) } as never, repoRoot);
		const direct = after.get(toolNameFor("seam", "echo"));
		assert.ok(direct, "the remote tool must be registered under mcp__seam__echo");
		assert.match(direct?.description ?? "", /外接 Seam/, "she should see where a tool came from");

		const called = await run(direct, { text: "hello-from-her" }, repoRoot);
		assert.match(called, /echoed:hello-from-her/);
	} finally {
		await new Promise<void>((resolve) => httpServer.close(() => resolve()));
	}
});

test("the startup report names what is wrong, and says nothing when nothing is", async () => {
	const { buildReport, renderReport, probeAll, EMPTY_REPORT, isEmptyReport } = await import("../src/mcp/status.ts");

	const ready = (slug: string) => ({
		slug,
		label: slug.toUpperCase(),
		status: "ready" as const,
		transport: "http" as const,
		url: "https://example.com/mcp",
		headers: {},
		secrets: [],
	});

	// Nothing wrong → no note at all. A banner that speaks every session
	// teaches her to ignore it, which is worse than not having one.
	const clean = buildReport([ready("a")], new Map(), new Set(["a"]));
	assert.equal(isEmptyReport(clean), true);
	assert.equal(renderReport(clean), null);
	assert.equal(renderReport(EMPTY_REPORT), null);

	// Unreachable, missing credentials, and discovered-but-not-cached are
	// three different problems with three different fixes.
	const report = buildReport(
		[
			ready("down"),
			ready("fresh"),
			{ slug: "nokey", label: "NoKey", status: "missing_credentials", reason: "缺少凭据环境变量：X" },
		],
		new Map([["down", "connect ECONNREFUSED"]]),
		new Set([]),
	);
	assert.deepEqual(
		report.unreachable.map((f) => f.slug),
		["down"],
	);
	assert.deepEqual(
		report.missingCredentials.map((f) => f.slug),
		["nokey"],
	);
	assert.deepEqual(
		report.undiscovered.map((f) => f.slug),
		["fresh"],
	);

	const text = renderReport(report) ?? "";
	assert.match(text, /down（DOWN）连不上：connect ECONNREFUSED/);
	assert.match(text, /缺少凭据环境变量：X/);
	assert.match(text, /her_mcp_refresh/);

	// A probe that throws must not take the report down with it.
	const failures = await probeAll([ready("boom")], async () => {
		throw new Error("kaboom");
	});
	assert.equal(failures.get("boom"), "kaboom");
});

test("integration smoke: a dead connector really reaches her context, once", async () => {
	const { createServer } = await import("node:http");
	// A port that nothing is listening on: bind one, learn the number, release it.
	const probeServer = createServer(() => {});
	await new Promise<void>((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
	const { port: deadPort } = probeServer.address() as { port: number };
	await new Promise<void>((resolve) => probeServer.close(() => resolve()));

	const repoRoot = await tempRoot();
	await writeManifest(repoRoot, {
		version: 1,
		connectors: [{ slug: "dead", label: "没人在听", type: "http", url: `http://127.0.0.1:${deadPort}/mcp` }],
	});

	const { handlers } = mcpHarnessFull();
	const onSessionStart = handlers.get("session_start")?.[0];
	const onContext = handlers.get("context")?.[0];
	assert.ok(onSessionStart, "registerMcpTools must subscribe to session_start");
	assert.ok(onContext, "registerMcpTools must subscribe to context");

	// Before the probe there is nothing to say — the note must not appear
	// merely because a connector is configured.
	assert.equal(onContext?.({ type: "context", messages: [] }), undefined);

	await onSessionStart?.({ type: "session_start" }, { cwd: repoRoot });

	const injected = onContext?.({ type: "context", messages: [] }) as { messages: unknown[] } | undefined;
	assert.ok(injected, "a broken connector must produce a note");
	assert.equal(injected?.messages.length, 1);
	const note = (injected?.messages[0] as { content: string }).content;
	assert.match(note, /dead（没人在听）连不上/);

	// Once. A banner on every request is a banner she learns to skip.
	assert.equal(onContext?.({ type: "context", messages: [] }), undefined);
});
