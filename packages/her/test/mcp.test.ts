import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type ConnectorProblem, loadConnectors, registerMcpTools } from "../src/mcp/tools.ts";

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

function mcpHarness(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerMcpTools(pi);
	return tools;
}

interface ToolCallResult {
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
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
}

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>, cwd: string): Promise<string> {
	return (await runFull(tool, params, cwd)).text;
}

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
			{ slug: "http-unsupported", label: "HTTP Connector", type: "http", command: "node", args: [] },
		],
	});
	const tools = mcpHarness();

	const text = await run(tools.get("her_mcp_list"), {}, repoRoot);

	assert.match(text, /leaky（Leaky Connector）：坏配置，密钥必须走环境变量。/);
	assert.match(text, /http-unsupported（HTTP Connector）：坏配置，v1 只支持 stdio connector。/);
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
