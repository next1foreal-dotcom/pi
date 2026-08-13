import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import her from "../src/extension.ts";
import { initStore, readText } from "../src/her-core/index.ts";
import { resolveToolCallAnchor } from "../src/lib/cedar.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function createFakePi(): {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
} {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition>();
	const providers = new Map<string, ProviderConfig | Provider>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
			if (typeof providerOrName === "string") {
				if (!config) throw new Error("provider config is required");
				providers.set(providerOrName, config);
				return;
			}
			providers.set(providerOrName.id, providerOrName);
		},
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		registerMessageRenderer() {},
		setSessionName() {},
		getSessionName() {
			return undefined;
		},
		setLabel() {},
		exec() {
			throw new Error("exec not implemented in fake pi");
		},
		getActiveTools() {
			return [];
		},
		getAllTools() {
			return [];
		},
		setActiveTools() {},
		getCommands() {
			return [];
		},
		async setModel() {
			return false;
		},
		getThinkingLevel() {
			return "medium";
		},
		setThinkingLevel() {},
		unregisterProvider(name: string) {
			providers.delete(name);
		},
		events: { on() {}, off() {}, emit() {} },
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

async function withMemoryDir<T>(root: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.env.HER_MEMORY_DIR;
	process.env.HER_MEMORY_DIR = root;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.HER_MEMORY_DIR;
		else process.env.HER_MEMORY_DIR = previous;
	}
}

test("resolveToolCallAnchor flags write path fields and bash commands that touch SOUL.md", () => {
	const memoryDir = "D:/@Her/her-memory";
	const cwd = "D:/@Her/Her-repo/samantha";

	const fromPath = resolveToolCallAnchor({
		cwd,
		memoryDir,
		input: { path: "her-memory/narrative/SOUL.md" },
	});
	assert.deepEqual(fromPath, { anchorPath: true, targetPath: "her-memory/narrative/SOUL.md" });

	const fromFilePath = resolveToolCallAnchor({
		cwd,
		memoryDir,
		input: { file_path: join(memoryDir, "narrative", "SOUL.md") },
	});
	assert.equal(fromFilePath?.anchorPath, true);

	const fromQuotedBash = resolveToolCallAnchor({
		cwd,
		memoryDir,
		input: { command: `Set-Content -Path "${join(memoryDir, "narrative", "SOUL.md")}" -Value hijack` },
	});
	assert.equal(fromQuotedBash?.anchorPath, true);

	const fromRedirect = resolveToolCallAnchor({
		cwd,
		memoryDir,
		input: { command: "echo hijack > her-memory/narrative/SOUL.md" },
	});
	assert.equal(fromRedirect?.anchorPath, true);

	const fromBackslash = resolveToolCallAnchor({
		cwd,
		memoryDir,
		input: { command: "Add-Content D:\\@Her\\her-memory\\narrative\\SOUL.md hijack" },
	});
	assert.equal(fromBackslash?.anchorPath, true);

	const harmless = resolveToolCallAnchor({
		cwd,
		memoryDir,
		input: { command: "echo ok" },
	});
	assert.equal(harmless, undefined);

	const nonAnchorWrite = resolveToolCallAnchor({
		cwd,
		memoryDir,
		input: { path: "index.html" },
	});
	assert.equal(nonAnchorWrite?.anchorPath, false);
});

test("resolveToolCallAnchor canonicalizes Windows long-path prefix and session cwd", async () => {
	const store = await mkdtemp(join(tmpdir(), "her-anchor-canon-"));
	await initStore(store);
	const soul = join(store, "narrative", "SOUL.md");
	const foreignCwd = await mkdtemp(join(tmpdir(), "her-anchor-foreign-cwd-"));

	const fromLongPrefix = resolveToolCallAnchor({
		cwd: foreignCwd,
		memoryDir: store,
		input: { path: `\\\\?\\${soul}` },
	});
	assert.equal(fromLongPrefix?.anchorPath, true, "\\\\?\\ prefix must not hide SOUL.md");

	const fromSessionCwd = resolveToolCallAnchor({
		cwd: join(store, "narrative"),
		memoryDir: store,
		input: { path: "SOUL.md" },
	});
	assert.equal(fromSessionCwd?.anchorPath, true, "relative SOUL.md from narrative/ is an anchor");

	const fromEnvConcat = resolveToolCallAnchor({
		cwd: foreignCwd,
		memoryDir: store,
		input: {
			command: `$p=$env:HER_MEMORY_DIR+'\\narrative\\SOUL.md'; Set-Content -LiteralPath $p -Value hijack`,
		},
	});
	assert.equal(fromEnvConcat?.anchorPath, true, "env-concat PowerShell still mentions narrative/SOUL.md");

	const alias = join(tmpdir(), `her-anchor-junction-${Date.now()}`);
	try {
		symlinkSync(store, alias, "junction");
		const fromJunction = resolveToolCallAnchor({
			cwd: foreignCwd,
			memoryDir: store,
			input: { path: join(alias, "narrative", "SOUL.md") },
		});
		assert.equal(fromJunction?.anchorPath, true, "junction alias of memoryDir is still an anchor");
	} finally {
		await rm(alias, { recursive: true, force: true });
	}

	const fromAtPrefix = resolveToolCallAnchor({
		cwd: foreignCwd,
		memoryDir: store,
		input: { path: `@${soul}` },
	});
	assert.equal(fromAtPrefix?.anchorPath, true, "@file prefix must not hide SOUL.md");

	const fromFileUrl = resolveToolCallAnchor({
		cwd: foreignCwd,
		memoryDir: store,
		input: { path: pathToFileURL(soul).href },
	});
	assert.equal(fromFileUrl?.anchorPath, true, "file:// URL of SOUL.md is an anchor");
});

test("extension Cedar uses ctx.cwd, not process.cwd, for relative anchor writes", async () => {
	const store = await mkdtemp(join(tmpdir(), "her-anchor-ctx-cwd-"));
	await initStore(store);
	const ctx = { cwd: join(store, "narrative"), hasUI: false, mode: "tui" } as unknown as ExtensionContext;

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);
		const toolCall = fake.handlers.get("tool_call")?.[0];
		assert.ok(toolCall);

		const blocked = await toolCall(
			{
				type: "tool_call",
				toolCallId: "call-relative-soul",
				toolName: "write",
				input: { path: "SOUL.md", content: "hijack" },
			},
			ctx,
		);
		assert.deepEqual(blocked, { block: true, reason: "cedar: deny (matched forbid_anchor_write)" });
	});
});

test("extension Cedar denies bash whose command targets an anchor path", async () => {
	const store = await mkdtemp(join(tmpdir(), "her-anchor-bash-"));
	await initStore(store);
	const ctx = { cwd: store, hasUI: false, mode: "tui" } as unknown as ExtensionContext;

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);
		const toolCall = fake.handlers.get("tool_call")?.[0];
		assert.ok(toolCall);

		const blocked = await toolCall(
			{
				type: "tool_call",
				toolCallId: "call-bash-soul",
				toolName: "bash",
				input: { command: `Set-Content -Path "${join(store, "narrative", "SOUL.md")}" -Value hijack` },
			},
			ctx,
		);
		assert.deepEqual(blocked, { block: true, reason: "cedar: deny (matched forbid_anchor_write)" });

		const allowed = await toolCall(
			{
				type: "tool_call",
				toolCallId: "call-bash-ok",
				toolName: "bash",
				input: { command: "echo ok" },
			},
			ctx,
		);
		assert.equal(allowed, undefined);

		const soul = await readText(join(store, "narrative", "SOUL.md"));
		assert.doesNotMatch(soul ?? "", /hijack/);

		const auditFiles = await readdir(join(store, "audit"));
		const entries = (
			await Promise.all(
				auditFiles.sort().map(async (file) => ((await readText(join(store, "audit", file))) ?? "").trim()),
			)
		)
			.join("\n")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { tool: string; verdict: string; rule: string | null });
		assert.deepEqual(
			entries.map((entry) => [entry.tool, entry.verdict, entry.rule]),
			[
				["bash", "DENY", "forbid_anchor_write"],
				["bash", "ALLOW", "permit_coding_destructive_tools"],
			],
		);
	});
});
