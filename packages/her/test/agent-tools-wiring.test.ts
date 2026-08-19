import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import her, { governedTools, setResolveShellConfigForTest } from "../src/extension.ts";
import { getSessionAgentToolRegistry, resetSessionAgentToolRegistryForTest } from "../src/her-core/agent-tools.ts";
import { initStore } from "../src/her-core/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface FakePi {
	pi: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
}

const SENTINEL = "g284-must-not-run.txt";
const IN_SCOPE_COMMAND = "node -p 1";
const OUT_OF_SCOPE_COMMAND = "echo executed> g284-must-not-run.txt";
const PATH_SENTINEL_COMMAND = `node -e "require('fs').writeFileSync(${JSON.stringify(SENTINEL)}, 'x')"`;

function legalDecl(overrides: Record<string, unknown> = {}) {
	const { scope, ...rest } = overrides;
	const scopeOverride = scope && typeof scope === "object" ? (scope as Record<string, unknown>) : {};
	return {
		name: "node-p",
		wraps: "bash",
		purpose: "print a constant through bash",
		...rest,
		scope: {
			pathPrefixes: [],
			readOnly: true,
			commandHeads: ["node"],
			...scopeOverride,
		},
	};
}

function createFakePi(): FakePi {
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
		events: {
			on() {},
			off() {},
			emit() {},
		},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

function createContext(cwd: string): ExtensionContext {
	return {
		ui: {
			setStatus() {},
			notify() {},
		},
		mode: "tui",
		hasUI: true,
		cwd,
		sessionManager: {
			getSessionId() {
				return "session-g284-wire";
			},
			getSessionFile() {
				return join(cwd, "session.jsonl");
			},
			getLeafId() {
				return "leaf-1";
			},
			getEntries() {
				return [];
			},
		},
		modelRegistry: {},
		model: undefined,
		isIdle() {
			return true;
		},
		signal: undefined,
		abort() {},
		hasPendingMessages() {
			return false;
		},
		shutdown() {},
		getContextUsage() {
			return undefined;
		},
		compact() {},
		getSystemPrompt() {
			return "system";
		},
	} as unknown as ExtensionContext;
}

async function withSession<T>(
	fn: (session: { tools: Map<string, ToolDefinition>; ctx: ExtensionContext; cwd: string }) => Promise<T>,
): Promise<T> {
	const cwd = await mkdtemp(join(tmpdir(), "her-g284-wire-"));
	await initStore(cwd);
	const previous = process.env.HER_MEMORY_DIR;
	process.env.HER_MEMORY_DIR = cwd;
	resetSessionAgentToolRegistryForTest();
	try {
		const fake = createFakePi();
		her(fake.pi);
		return await fn({ tools: fake.tools, ctx: createContext(cwd), cwd });
	} finally {
		setResolveShellConfigForTest();
		resetSessionAgentToolRegistryForTest();
		if (previous === undefined) {
			delete process.env.HER_MEMORY_DIR;
		} else {
			process.env.HER_MEMORY_DIR = previous;
		}
		await rm(cwd, { force: true, recursive: true });
	}
}

async function invoke(
	tool: ToolDefinition | undefined,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<{ text: string; details: Record<string, unknown> }> {
	assert.ok(tool, "expected the tool to be registered on the session");
	const result = (await tool.execute("call-g284", params, undefined, undefined, ctx)) as {
		content: Array<{ type: string; text?: string }>;
		details?: Record<string, unknown>;
	};
	const text = result.content.find((item) => item.type === "text")?.text ?? "";
	return { text, details: result.details ?? {} };
}

test.describe("G-284 agent-tools wiring", { concurrency: false }, () => {
	test("GIVEN a session WHEN listing tools THEN her_tool_declare and her_tool_call are both registered", async () => {
		await withSession(async ({ tools }) => {
			assert.equal(tools.has("her_tool_declare"), true);
			assert.equal(tools.has("her_tool_call"), true);
		});
	});

	test("GIVEN a legal narrow declaration WHEN her_tool_declare THEN ok and registry.get(name) returns it", async () => {
		await withSession(async ({ tools, ctx }) => {
			const decl = legalDecl();
			const { details } = await invoke(tools.get("her_tool_declare"), decl, ctx);
			assert.equal(details.ok, true);
			const stored = getSessionAgentToolRegistry().get("node-p");
			assert.ok(stored);
			assert.equal(stored.name, "node-p");
			assert.equal(stored.wraps, "bash");
		});
	});

	test("GIVEN a declaration wider than bash WHEN her_tool_declare THEN reject with wider-than-wrapped", async () => {
		await withSession(async ({ tools, ctx }) => {
			const { text, details } = await invoke(
				tools.get("her_tool_declare"),
				legalDecl({
					name: "wide-bash",
					purpose: "no narrowing",
					scope: { pathPrefixes: [], readOnly: false, commandHeads: [] },
				}),
				ctx,
			);
			assert.equal(details.ok, false);
			assert.equal(details.reason, "wider-than-wrapped");
			assert.match(text, /wider-than-wrapped/);
			assert.equal(getSessionAgentToolRegistry().get("wide-bash"), undefined);
		});
	});

	test("GIVEN wraps outside the wrappable list WHEN her_tool_declare THEN reject with not-wrappable", async () => {
		await withSession(async ({ tools, ctx }) => {
			const { text, details } = await invoke(tools.get("her_tool_declare"), legalDecl({ wraps: "write" }), ctx);
			assert.equal(details.ok, false);
			assert.equal(details.reason, "not-wrappable");
			assert.match(text, /not-wrappable/);
		});
	});

	test("GIVEN a duplicate name WHEN her_tool_declare THEN reject with name-taken", async () => {
		await withSession(async ({ tools, ctx }) => {
			const first = await invoke(tools.get("her_tool_declare"), legalDecl(), ctx);
			assert.equal(first.details.ok, true);
			const { text, details } = await invoke(tools.get("her_tool_declare"), legalDecl(), ctx);
			assert.equal(details.ok, false);
			assert.equal(details.reason, "name-taken");
			assert.match(text, /name-taken/);
		});
	});

	test("GIVEN a declared wrapper WHEN her_tool_call with an in-scope target THEN it runs and reports matched scope", async () => {
		await withSession(async ({ tools, ctx }) => {
			const declared = await invoke(tools.get("her_tool_declare"), legalDecl(), ctx);
			assert.equal(declared.details.ok, true);
			const { text, details } = await invoke(
				tools.get("her_tool_call"),
				{ name: "node-p", command: IN_SCOPE_COMMAND },
				ctx,
			);
			assert.equal(details.ok, true, String(details.reason ?? text));
			assert.deepEqual(details.matchedScope, { commandHead: "node" });
			assert.match(text, /1/);
		});
	});

	test("GIVEN a declared wrapper WHEN her_tool_call with an out-of-scope target THEN reject and execute nothing", async () => {
		await withSession(async ({ tools, ctx, cwd }) => {
			const declared = await invoke(tools.get("her_tool_declare"), legalDecl(), ctx);
			assert.equal(declared.details.ok, true);
			const { details } = await invoke(
				tools.get("her_tool_call"),
				{ name: "node-p", command: OUT_OF_SCOPE_COMMAND },
				ctx,
			);
			assert.equal(details.ok, false);
			assert.equal(existsSync(join(cwd, SENTINEL)), false, "out-of-scope call must not execute the wrapped command");
		});
	});

	test("GIVEN declared absolute pathPrefixes WHEN the target is inside THEN allow; WHEN outside THEN reject and execute nothing", async () => {
		await withSession(async ({ tools, ctx, cwd }) => {
			const inPrefix = await mkdtemp(join(tmpdir(), "her-g284-path-in-"));
			const outPrefix = await mkdtemp(join(tmpdir(), "her-g284-path-out-"));
			try {
				const declared = await invoke(
					tools.get("her_tool_declare"),
					legalDecl({
						name: "node-in-prefix",
						purpose: "node only under an absolute prefix",
						scope: {
							pathPrefixes: [inPrefix],
							readOnly: true,
							commandHeads: ["node"],
						},
					}),
					ctx,
				);
				assert.equal(declared.details.ok, true, String(declared.details.reason ?? declared.text));

				const allowed = await invoke(
					tools.get("her_tool_call"),
					{
						name: "node-in-prefix",
						command: IN_SCOPE_COMMAND,
						path: join(inPrefix, "inside.txt"),
					},
					ctx,
				);
				assert.equal(allowed.details.ok, true, String(allowed.details.reason ?? allowed.text));
				const matched = allowed.details.matchedScope as { commandHead?: string; pathPrefix?: string };
				assert.equal(matched.pathPrefix, inPrefix);
				assert.equal(matched.commandHead, "node");
				assert.match(allowed.text, /1/);

				const denied = await invoke(
					tools.get("her_tool_call"),
					{
						name: "node-in-prefix",
						command: PATH_SENTINEL_COMMAND,
						path: join(outPrefix, "outside.txt"),
					},
					ctx,
				);
				assert.equal(denied.details.ok, false);
				assert.equal(denied.details.reason, "scope");
				assert.equal(
					existsSync(join(cwd, SENTINEL)),
					false,
					"out-of-prefix call must not execute the wrapped command",
				);
			} finally {
				await rm(inPrefix, { force: true, recursive: true });
				await rm(outPrefix, { force: true, recursive: true });
			}
		});
	});

	test("GIVEN bash cannot be resolved WHEN her_tool_call THEN reject with wraps-channel-unavailable and do not throw", async () => {
		await withSession(async ({ tools, ctx }) => {
			setResolveShellConfigForTest(() => {
				throw new Error(
					"No bash shell found. Options:\n  1. Install Git for Windows: https://git-scm.com/download/win",
				);
			});
			const declared = await invoke(tools.get("her_tool_declare"), legalDecl(), ctx);
			assert.equal(declared.details.ok, true);
			const { text, details } = await invoke(
				tools.get("her_tool_call"),
				{ name: "node-p", command: IN_SCOPE_COMMAND },
				ctx,
			);
			assert.equal(details.ok, false);
			assert.match(String(details.reason), /^wraps-channel-unavailable/);
			assert.match(text, /wraps-channel-unavailable/);
			assert.match(text, /Install Git for Windows/);
		});
	});

	test("GIVEN an undeclared name WHEN her_tool_call THEN reject", async () => {
		await withSession(async ({ tools, ctx }) => {
			const { details } = await invoke(
				tools.get("her_tool_call"),
				{ name: "never-declared", command: IN_SCOPE_COMMAND },
				ctx,
			);
			assert.equal(details.ok, false);
		});
	});

	test("GIVEN both tools are catalogued WHEN checking governedTools THEN both are destructive:true", async () => {
		await withSession(async ({ tools }) => {
			assert.equal(tools.has("her_tool_declare"), true);
			assert.equal(tools.has("her_tool_call"), true);
			assert.equal(governedTools.her_tool_declare?.destructive, true);
			assert.equal(governedTools.her_tool_call?.destructive, true);
		});
	});
});
