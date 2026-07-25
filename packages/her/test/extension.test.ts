import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import her, { governedTools } from "../src/extension.ts";
import { initStore, Memory, readJson, readText, startLongTask, writeText } from "../src/her-core/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
const execFileAsync = promisify(execFile);

interface FakePi {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	tools: Map<string, ToolDefinition>;
	providers: Map<string, ProviderConfig | Provider>;
	entries: Array<{ customType: string; data?: unknown }>;
	messages: Array<{ message: unknown; options?: unknown }>;
}

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-extension-"));
	await initStore(root);
	return root;
}

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

async function waitFor(assertion: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await assertion()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail("timed out waiting for condition");
}

function createFakePi(): FakePi {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition>();
	const providers = new Map<string, ProviderConfig | Provider>();
	const entries: Array<{ customType: string; data?: unknown }> = [];
	const messages: Array<{ message: unknown; options?: unknown }> = [];
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
		appendEntry(customType: string, data?: unknown) {
			entries.push({ customType, data });
		},
		sendMessage(message: unknown, options?: unknown) {
			messages.push({ message, options });
		},
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
	return { pi, handlers, tools, providers, entries, messages };
}

function createContext(
	cwd: string,
	entries: unknown[] = [],
	statuses = new Map<string, string | undefined>(),
): ExtensionContext {
	return {
		ui: {
			setStatus(key: string, text: string | undefined) {
				statuses.set(key, text);
			},
			notify() {},
		},
		mode: "tui",
		hasUI: true,
		cwd,
		sessionManager: {
			getSessionId() {
				return "session-1";
			},
			getSessionFile() {
				return join(cwd, "session.jsonl");
			},
			getLeafId() {
				return "leaf-1";
			},
			getEntries() {
				return entries;
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

async function withMemoryDir<T>(root: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.env.HER_MEMORY_DIR;
	process.env.HER_MEMORY_DIR = root;
	try {
		return await fn();
	} finally {
		if (previous === undefined) {
			delete process.env.HER_MEMORY_DIR;
		} else {
			process.env.HER_MEMORY_DIR = previous;
		}
	}
}

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

async function executeTool(tool: ToolDefinition, params: Record<string, unknown>, ctx: ExtensionContext) {
	return await tool.execute("tool-call-1", params, undefined, undefined, ctx);
}

function firstText(result: Awaited<ReturnType<typeof executeTool>>): string {
	const item = result.content.find((entry) => entry.type === "text");
	return item?.type === "text" ? item.text : "";
}

function entryStatus(entry: { data?: unknown }): string | undefined {
	const data = entry.data;
	if (!data || typeof data !== "object" || !("status" in data)) return undefined;
	return typeof data.status === "string" ? data.status : undefined;
}

test("extension injects Her context and captures completed turns", async () => {
	const store = await tempStore();
	const ctx = createContext(store);
	await writeText(join(store, "narrative", "CONTEXT.md"), "# CONTEXT\n\nFei values exact verification.\n");
	await writeText(join(store, "narrative", "FACTS.md"), "Samantha is Her's pi agent.\n");
	await writeText(join(store, "narrative", "SOUL.md"), "# SOUL\n\nSamantha sounds grounded, playful, and exact.\n");
	await writeText(join(store, "narrative", "SAMANTHA.md"), "# SAMANTHA\n\nSamantha is learning to stay grounded.\n");
	await writeText(join(store, "narrative", "CHOICE-MODEL.md"), "# CHOICE MODEL\n\nPrefer reversible moves.\n");
	await writeText(
		join(store, "choice-model", "writing-style.md"),
		"# Writing Style Rules\n\nLead with verified state.\n",
	);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		assert.equal(fake.providers.has("her-claude"), true);
		assert.equal(fake.providers.has("her-claude-oauth"), true);
		assert.equal(fake.providers.has("her-codex"), true);
		assert.equal(fake.providers.has("her-codex-oauth"), true);
		const claudeOAuth = fake.providers.get("her-claude-oauth");
		assert.ok(claudeOAuth && "auth" in claudeOAuth);
		assert.match(claudeOAuth.auth.oauth?.name ?? "", /Claude Pro/);
		assert.equal(claudeOAuth.auth.apiKey, undefined);
		assert.deepEqual(
			claudeOAuth.getModels().map(({ provider, id, api, baseUrl }) => ({ provider, id, api, baseUrl })),
			[
				{
					provider: "her-claude-oauth",
					id: "claude-sonnet-4-6",
					api: "anthropic-messages",
					baseUrl: "https://api.anthropic.com",
				},
			],
		);
		const codexOAuth = fake.providers.get("her-codex-oauth");
		assert.ok(codexOAuth && "auth" in codexOAuth);
		assert.match(codexOAuth.auth.oauth?.name ?? "", /ChatGPT/);
		assert.equal(codexOAuth.auth.apiKey, undefined);
		assert.deepEqual(
			codexOAuth.getModels().map(({ provider, id, api, baseUrl }) => ({ provider, id, api, baseUrl })),
			[
				{
					provider: "her-codex-oauth",
					id: "gpt-5-codex",
					api: "openai-codex-responses",
					baseUrl: "https://chatgpt.com/backend-api",
				},
			],
		);
		assert.equal(fake.tools.has("her_recall"), true);
		assert.equal(fake.tools.has("her_remember"), true);
		assert.equal(fake.tools.has("her_idea"), true);

		const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0];
		assert.ok(beforeAgentStart);
		const injected = (await beforeAgentStart(
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: "base prompt",
				systemPromptOptions: {},
			},
			ctx,
		)) as { systemPrompt?: string; message?: { customType?: string; details?: { pinned?: boolean } } };

		assert.match(injected.systemPrompt ?? "", /base prompt/);
		assert.match(injected.systemPrompt ?? "", /Fei values exact verification/);
		assert.match(injected.systemPrompt ?? "", /Samantha is Her's pi agent/);
		assert.match(injected.systemPrompt ?? "", /grounded, playful, and exact/);
		assert.match(injected.systemPrompt ?? "", /Samantha is learning to stay grounded/);
		assert.match(injected.systemPrompt ?? "", /Prefer reversible moves/);
		assert.match(injected.systemPrompt ?? "", /Lead with verified state/);
		assert.equal(injected.message?.customType, "her-context");
		assert.equal(injected.message?.details?.pinned, true);

		const turnEnd = fake.handlers.get("turn_end")?.[0];
		assert.ok(turnEnd);
		await writeText(join(store, "semantic", "mirror.md"), "# Mirror\n\nCaptured by Her mirror memory.\n");
		await turnEnd(
			{
				type: "turn_end",
				turnIndex: 2,
				message: { role: "assistant", content: [{ type: "text", text: "Captured by Her." }] },
				toolResults: [],
			},
			ctx,
		);

		const rawFiles = await readdir(join(store, "episodic", "raw"));
		assert.equal(rawFiles.length, 1);
		const raw = (await readText(join(store, "episodic", "raw", rawFiles[0]))) ?? "";
		assert.match(raw, /Pi Turn 2/);
		assert.match(raw, /Captured by Her/);
		assert.match(raw, /session-1/);
		assert.deepEqual(
			fake.entries.find((entry) => entry.customType === "her-state" && entryStatus(entry) === "captured"),
			{
				customType: "her-state",
				data: {
					phase: "2",
					status: "captured",
					lastCapturedLeaf: "leaf-1",
					noteId: "session-1-turn-2",
					memoryDir: store,
				},
			},
		);
		assert.deepEqual(fake.messages.at(-1)?.options, { deliverAs: "followUp" });
		assert.equal((fake.messages.at(-1)?.message as { customType?: string }).customType, "her-mirror");
		assert.match((fake.messages.at(-1)?.message as { content?: string }).content ?? "", /semantic\/mirror/);
	});
});

test("extension mirror does not compete with an active pi-codex-goal follow-up", async () => {
	const store = await tempStore();
	await writeText(join(store, "semantic", "goal.md"), "# Goal\n\nGoal continuation owns the next follow-up.\n");
	const ctx = createContext(store, [
		{
			customType: "pi-codex-goal",
			data: { kind: "set", goal: { status: "active" } },
		},
	]);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const turnEnd = fake.handlers.get("turn_end")?.[0];
		assert.ok(turnEnd);
		await turnEnd(
			{
				type: "turn_end",
				turnIndex: 1,
				message: { role: "assistant", content: [{ type: "text", text: "Goal continuation." }] },
				toolResults: [],
			},
			ctx,
		);

		assert.equal(fake.messages.length, 0);
		assert.equal(
			fake.entries.some((entry) => entry.customType === "her-state" && entryStatus(entry) === "mirror-sent"),
			false,
		);
	});
});

test("extension claims a Her long task and triggers an idle continuation before Mirror", async () => {
	const store = await tempStore();
	await startLongTask(store, {
		id: "goal-extension",
		objective: "Continue a durable Her goal",
		nextContinuation: "Run the next focused implementation step.",
		now: "2026-06-06T10:00:00.000Z",
	});
	await writeText(join(store, "semantic", "mirror.md"), "# Mirror\n\nMirror should wait behind goal continuation.\n");
	const ctx = createContext(store);

	await withEnv({ HER_MEMORY_DIR: store, HER_GOAL_LEASE_MINUTES: "10" }, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const turnEnd = fake.handlers.get("turn_end")?.[0];
		assert.ok(turnEnd);
		await turnEnd(
			{
				type: "turn_end",
				turnIndex: 1,
				message: { role: "assistant", content: [{ type: "text", text: "Ready for next goal step." }] },
				toolResults: [],
			},
			ctx,
		);

		const sent = fake.messages.at(-1);
		const message = sent?.message as { customType?: string; content?: string; details?: Record<string, unknown> };
		assert.equal(message.customType, "her-goal-continuation");
		assert.match(message.content ?? "", /Run the next focused implementation step/);
		assert.equal(message.details?.goalId, "goal-extension");
		assert.deepEqual(sent?.options, { deliverAs: "followUp", triggerTurn: true });
		assert.equal(
			fake.entries.some(
				(entry) => entry.customType === "her-state" && entryStatus(entry) === "goal-continuation-sent",
			),
			true,
		);
		assert.equal(
			fake.entries.some((entry) => entry.customType === "her-state" && entryStatus(entry) === "mirror-sent"),
			false,
		);

		const goal = (await readText(join(store, "goals", "goal-extension.md"))) ?? "";
		assert.match(goal, /^claimed_by: pi:session-1$/m);
		assert.match(goal, /^claim_expires_at: /m);
	});
});

test("extension Her long task continuation yields to an active pi-codex-goal", async () => {
	const store = await tempStore();
	await startLongTask(store, {
		id: "goal-yield",
		objective: "Yield while pi-codex-goal is active",
		nextContinuation: "This should not be sent yet.",
		now: "2026-06-06T10:00:00.000Z",
	});
	const ctx = createContext(store, [
		{
			customType: "pi-codex-goal",
			data: { kind: "set", goal: { status: "active" } },
		},
	]);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const turnEnd = fake.handlers.get("turn_end")?.[0];
		assert.ok(turnEnd);
		await turnEnd(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: [] }, toolResults: [] },
			ctx,
		);

		assert.equal(fake.messages.length, 0);
		const goal = (await readText(join(store, "goals", "goal-yield.md"))) ?? "";
		assert.match(goal, /^claimed_by: null$/m);
	});
});

test("extension sends a context digest for due unreviewed updates", async () => {
	const store = await tempStore();
	await writeText(
		join(store, ".her", "config.yaml"),
		["llm:", "  base_url: https://api.deepseek.com", "cadence:", "  digest_after_unreviewed: 1", ""].join("\n"),
	);
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	const update = await new Memory(store).writeContextUpdate({
		content: "# CONTEXT\n\nFei reviews autonomous context changes.\n",
		change: "Report autonomous context changes",
		type: "identity",
		drivenBy: ["[[episodic/raw/turn-1]]"],
	});
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const turnEnd = fake.handlers.get("turn_end")?.[0];
		assert.ok(turnEnd);
		await turnEnd(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: [] }, toolResults: [] },
			ctx,
		);

		const message = fake.messages.at(-1)?.message as { customType?: string; content?: string };
		assert.equal(message.customType, "her-context-digest");
		assert.match(message.content ?? "", new RegExp(update.id));
		assert.deepEqual(fake.messages.at(-1)?.options, { deliverAs: "followUp" });
		assert.equal(
			fake.entries.some((entry) => entry.customType === "her-state" && entryStatus(entry) === "context-digest-sent"),
			true,
		);

		await turnEnd(
			{ type: "turn_end", turnIndex: 2, message: { role: "assistant", content: [] }, toolResults: [] },
			ctx,
		);
		assert.equal(
			fake.messages.filter((entry) => (entry.message as { customType?: string }).customType === "her-context-digest")
				.length,
			1,
		);
	});
});

test("extension context digest does not compete with an active pi-codex-goal follow-up", async () => {
	const store = await tempStore();
	await writeText(join(store, ".her", "config.yaml"), "cadence:\n  digest_after_unreviewed: 1\n");
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await new Memory(store).writeContextUpdate({
		content: "# CONTEXT\n\nFei reviews context changes after the goal.\n",
		change: "Defer digest during active goal",
		type: "revise",
		drivenBy: ["[[episodic/raw/turn-1]]"],
	});
	const ctx = createContext(store, [
		{
			customType: "pi-codex-goal",
			data: { kind: "set", goal: { status: "active" } },
		},
	]);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const turnEnd = fake.handlers.get("turn_end")?.[0];
		assert.ok(turnEnd);
		await turnEnd(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: [] }, toolResults: [] },
			ctx,
		);

		assert.equal(fake.messages.length, 0);
		assert.equal(
			fake.entries.some((entry) => entry.customType === "her-state" && entryStatus(entry) === "context-digest-sent"),
			false,
		);
	});
});

test("extension returns a full compaction that preserves Her pinned context without core patch instructions", async () => {
	const store = await tempStore();
	const ctx = createContext(store);
	await writeText(join(store, "narrative", "FACTS.md"), "Fei is the human owner.\n");
	await writeText(join(store, "narrative", "SOUL.md"), "# SOUL\n\nSamantha stays warm and exact.\n");
	await writeText(join(store, "narrative", "CHOICE-MODEL.md"), "# CHOICE MODEL\n\nPrefer reversible moves.\n");

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const beforeCompact = fake.handlers.get("session_before_compact")?.[0];
		assert.ok(beforeCompact);
		const result = (await beforeCompact(
			{
				type: "session_before_compact",
				preparation: {
					firstKeptEntryId: "keep-1",
					messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Remember this Her task." }] }],
					turnPrefixMessages: [],
					isSplitTurn: false,
					tokensBefore: 1234,
					fileOps: { readFiles: [], modifiedFiles: [] },
					settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
				},
				branchEntries: [],
				signal: new AbortController().signal,
			},
			ctx,
		)) as {
			customInstructions?: string;
			compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number };
		};

		assert.equal(result.customInstructions, undefined);
		assert.equal(result.compaction?.firstKeptEntryId, "keep-1");
		assert.equal(result.compaction?.tokensBefore, 1234);
		assert.match(result.compaction?.summary ?? "", /FACTS\.md/);
		assert.match(result.compaction?.summary ?? "", /Fei is the human owner/);
		assert.match(result.compaction?.summary ?? "", /SOUL\.md/);
		assert.match(result.compaction?.summary ?? "", /Prefer reversible moves/);
		assert.equal(
			fake.entries.some((entry) => entry.customType === "her-state" && entryStatus(entry) === "compact-guard"),
			true,
		);
	});
});

test("extension gates governed tool calls with Cedar and writes audit JSONL", async () => {
	const store = await tempStore();
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const toolCall = fake.handlers.get("tool_call")?.[0];
		assert.ok(toolCall);

		const allow = await toolCall(
			{ type: "tool_call", toolCallId: "call-1", toolName: "her_recall", input: { query: "Fei" } },
			ctx,
		);
		assert.equal(allow, undefined);

		const codingAllow = await toolCall(
			{ type: "tool_call", toolCallId: "call-2", toolName: "bash", input: { command: "echo ok" } },
			ctx,
		);
		assert.equal(codingAllow, undefined);

		const unknown = await toolCall(
			{ type: "tool_call", toolCallId: "call-3", toolName: "unregistered_tool", input: {} },
			ctx,
		);
		assert.equal(unknown, undefined);

		const auditFiles = await readdir(join(store, "audit"));
		assert.equal(auditFiles.length, 1);
		const entries = (
			await Promise.all(
				auditFiles.sort().map(async (file) => ((await readText(join(store, "audit", file))) ?? "").trim()),
			)
		)
			.join("\n")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { tool: string; verdict: string; rule: string | null; reason?: string });
		assert.deepEqual(
			entries.map((entry) => [entry.tool, entry.verdict, entry.rule]),
			[
				["her_recall", "ALLOW", "allow_memory_tools"],
				["bash", "ALLOW", "permit_coding_destructive_tools"],
			],
		);
	});
});

test("extension Cedar permits artifact_publish and coding write/edit/bash", async () => {
	const store = await tempStore();
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const toolCall = fake.handlers.get("tool_call")?.[0];
		assert.ok(toolCall);

		assert.equal(governedTools.artifact_publish?.destructive, true);

		const publishAllow = await toolCall(
			{
				type: "tool_call",
				toolCallId: "call-artifact-1",
				toolName: "artifact_publish",
				input: { path: "D:/artifacts/demo.html" },
			},
			ctx,
		);
		assert.equal(publishAllow, undefined);

		const writeAllow = await toolCall(
			{ type: "tool_call", toolCallId: "call-write-1", toolName: "write", input: { path: "index.html" } },
			ctx,
		);
		assert.equal(writeAllow, undefined);

		const bashAllow = await toolCall(
			{ type: "tool_call", toolCallId: "call-bash-1", toolName: "bash", input: { command: "echo ok" } },
			ctx,
		);
		assert.equal(bashAllow, undefined);

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
				["artifact_publish", "ALLOW", "permit_artifact_publish"],
				["write", "ALLOW", "permit_coding_destructive_tools"],
				["bash", "ALLOW", "permit_coding_destructive_tools"],
			],
		);
	});
});

test("extension Cedar registry covers every registered Her tool", async () => {
	const store = await tempStore();

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const missing = [...fake.tools.keys()].filter((name) => !governedTools[name]);
		assert.deepEqual(missing, []);
		assert.ok(fake.tools.size > 30);
	});
});

test("extension Cedar allows hands tools as governed non-destructive tools", async () => {
	const store = await tempStore();
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);
		const toolCall = fake.handlers.get("tool_call")?.[0];
		assert.ok(toolCall);

		const snapshot = await toolCall(
			{
				type: "tool_call",
				toolCallId: "call-hands-1",
				toolName: "her_hands_snapshot",
				input: { process: "notepad.exe" },
			},
			ctx,
		);
		const act = await toolCall(
			{
				type: "tool_call",
				toolCallId: "call-hands-2",
				toolName: "her_hands_act",
				input: { process: "notepad.exe", taskLabel: "demo", actions: [{ action: "click", elementIndex: 0 }] },
			},
			ctx,
		);

		assert.equal(snapshot, undefined);
		assert.equal(act, undefined);
	});
});
test("extension her_feedback records weighted choice-model rules", async () => {
	const store = await tempStore();
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const feedback = fake.tools.get("her_feedback");
		assert.ok(feedback);
		const result = await executeTool(
			feedback,
			{
				task: "Write README",
				domain: "writing-style",
				diff_summary: "Use second person and lead with the conclusion.",
				rule: "Use second person and put the conclusion first.",
				weight: 3,
			},
			ctx,
		);

		assert.match(firstText(result), /Feedback recorded/);
		assert.equal((result.details as { weight?: number }).weight, 3);
		const file = (await readText(join(store, "choice-model", "writing-style.md"))) ?? "";
		assert.match(file, /Use second person and put the conclusion first/);
		assert.match(file, /"weight": 3/);
	});
});

test("extension task tools verify step gates and audit decisions", async () => {
	const store = await tempStore();
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const create = fake.tools.get("her_task_create");
		const update = fake.tools.get("her_task_update");
		const list = fake.tools.get("her_task_list");
		assert.ok(create);
		assert.ok(update);
		assert.ok(list);

		const created = await executeTool(
			create,
			{
				id: "task-extension",
				objective: "Ship a verified Her task",
				steps: [
					{ id: "draft", title: "Draft implementation", exitCriteria: ["task exists"] },
					{ id: "verify", title: "Verify behavior", exitCriteria: ["tests pass"] },
				],
			},
			ctx,
		);
		assert.match(firstText(created), /task-extension/);

		const first = await executeTool(
			update,
			{
				id: "task-extension",
				stepId: "draft",
				selfReview: "The task file exists and has explicit steps.",
				exitCriteriaResults: [{ criterion: "task exists", passed: true, evidence: "created details returned" }],
				checkpoint: "Draft step created.",
			},
			ctx,
		);
		assert.match(firstText(first), /advanced/);
		assert.equal((first.details as { decision?: { rule?: string } }).decision?.rule, "allow");

		const failed = await executeTool(
			update,
			{
				id: "task-extension",
				stepId: "verify",
				selfReview: "The verification is not complete yet.",
				exitCriteriaResults: [{ criterion: "tests pass", passed: false, evidence: "test not run" }],
			},
			ctx,
		);
		assert.match(firstText(failed), /blocked/);
		assert.equal((failed.details as { decision?: { rule?: string } }).decision?.rule, "exit-criterion-failed");

		const recovered = await executeTool(
			update,
			{
				id: "task-extension",
				stepId: "verify",
				selfReview: "The relevant test passed after the fix.",
				exitCriteriaResults: [{ criterion: "tests pass", passed: true, evidence: "node --test task.test.ts" }],
				checkpoint: "Verified step passed.",
			},
			ctx,
		);
		assert.match(firstText(recovered), /advanced/);
		assert.equal((recovered.details as { task?: { status?: string } }).task?.status, "done");

		const deniedTask = await executeTool(
			create,
			{
				id: "task-denied-tool",
				objective: "Reject destructive tools in heartbeat Cedar profile",
				steps: [{ id: "gate", title: "Gate tool use", exitCriteria: ["safe tools only"] }],
			},
			ctx,
		);
		assert.match(firstText(deniedTask), /task-denied-tool/);
		const denied = await withEnv({ HER_CEDAR_PROFILE: "heartbeat" }, async () =>
			executeTool(
				update,
				{
					id: "task-denied-tool",
					stepId: "gate",
					usedTools: ["bash"],
					selfReview: "This attempted to use bash.",
					exitCriteriaResults: [{ criterion: "safe tools only", passed: true }],
				},
				ctx,
			),
		);
		assert.match(firstText(denied), /blocked/);
		assert.equal(
			(denied.details as { decision?: { rule?: string } }).decision?.rule,
			"heartbeat_forbid_destructive_tools",
		);

		const budgetTask = await executeTool(
			create,
			{
				id: "task-budget",
				objective: "Stop when context budget is too low",
				steps: [{ id: "budget", title: "Check budget", exitCriteria: ["enough context remains"] }],
			},
			ctx,
		);
		assert.match(firstText(budgetTask), /task-budget/);
		const budget = await executeTool(
			update,
			{
				id: "task-budget",
				stepId: "budget",
				remainingTokens: 10,
				minimumTokens: 100,
				selfReview: "There is not enough room to continue safely.",
				exitCriteriaResults: [{ criterion: "enough context remains", passed: true }],
			},
			ctx,
		);
		assert.equal((budget.details as { decision?: { rule?: string } }).decision?.rule, "budget-exceeded");

		const done = await executeTool(list, { status: "done" }, ctx);
		assert.match(firstText(done), /task-extension/);
		const doneFile = (await readText(join(store, "tasks", "done", "task-extension.md"))) ?? "";
		assert.match(doneFile, /Verified step passed/);

		const auditFiles = await readdir(join(store, "audit"));
		const rules = (
			await Promise.all(auditFiles.map(async (file) => ((await readText(join(store, "audit", file))) ?? "").trim()))
		)
			.join("\n")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { rule: string | null })
			.map((entry) => entry.rule);
		assert.ok(rules.includes("allow"));
		assert.ok(rules.includes("exit-criterion-failed"));
		assert.ok(rules.includes("heartbeat_forbid_destructive_tools"));
		assert.ok(rules.includes("budget-exceeded"));
	});
});

test("extension proposal tools record feedback and report adoption stats", async () => {
	const store = await tempStore();
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const record = fake.tools.get("her_proposal_record");
		const feedback = fake.tools.get("her_proposal_feedback");
		const stats = fake.tools.get("her_proposal_stats");
		const list = fake.tools.get("her_proposal_list");
		assert.ok(record);
		assert.ok(feedback);
		assert.ok(stats);
		assert.ok(list);

		await executeTool(
			record,
			{
				id: "proposal-extension",
				title: "Active task is blocked",
				observation: "A task has been blocked for more than one checkpoint.",
				suggestion: "Ask Fei whether to unblock or archive it.",
				evidence: ["tasks/active contains a blocked task"],
				source: "her-scan",
			},
			ctx,
		);

		const accepted = await executeTool(
			feedback,
			{
				id: "proposal-extension",
				verdict: "do",
				note: "Yes, ask me before it goes stale.",
			},
			ctx,
		);
		assert.match(firstText(accepted), /accepted/);
		assert.equal((accepted.details as { stats?: { adoptionRate?: number } }).stats?.adoptionRate, 1);

		const reported = await executeTool(stats, {}, ctx);
		assert.match(firstText(reported), /100\.0%/);

		const listed = await executeTool(list, { status: "accepted" }, ctx);
		assert.match(firstText(listed), /proposal-extension/);
		assert.match((await readText(join(store, "proposals", "scan", "proposal-extension.md"))) ?? "", /Yes, ask me/);
	});
});

test("extension privacy tools classify memory and block unsafe exports", async () => {
	const store = await tempStore();
	const ctx = createContext(store);
	await writeText(join(store, "episodic", "raw", "legacy.md"), "# Legacy\n\n朋友说这件事不要外传。\n");

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const audit = fake.tools.get("her_privacy_audit");
		const check = fake.tools.get("her_privacy_check");
		assert.ok(audit);
		assert.ok(check);

		const audited = await executeTool(audit, {}, ctx);
		assert.match(firstText(audited), /classification updated/);
		assert.match((await readText(join(store, "privacy", "classification.md"))) ?? "", /episodic\/raw\/legacy\.md/);

		const blocked = await executeTool(check, { refs: ["episodic/raw/legacy.md"] }, ctx);
		assert.match(firstText(blocked), /blocked/);
		assert.equal((blocked.details as { result?: { allowed?: boolean } }).result?.allowed, false);
	});
});

test("extension phase E tools retract memory, report costs, and queue Telegram inbox", async () => {
	const store = await tempStore();
	const ctx = createContext(store);
	await writeText(join(store, "episodic", "raw", "poison.md"), "# Poison\n\nwrong fact\n");
	await writeText(
		join(store, "semantic", "derived.md"),
		"# Derived\n\nThis was derived from episodic/raw/poison.md.\n",
	);
	await writeText(
		join(store, "audit", "2026-06-13.jsonl"),
		`${JSON.stringify({
			ts: "2026-06-13T01:00:00.000Z",
			tool: "her_heartbeat",
			verdict: "ALLOW",
			rule: "allow",
			cost: { usd: 0.25, purpose: "heartbeat" },
		})}\n`,
	);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const retract = fake.tools.get("her_memory_retract");
		const cost = fake.tools.get("her_cost_report");
		const telegram = fake.tools.get("her_telegram_queue");
		assert.ok(retract);
		assert.ok(cost);
		assert.ok(telegram);

		const planned = await executeTool(
			retract,
			{ path: "episodic/raw/poison.md", reason: "wrong fact", confirm: false },
			ctx,
		);
		assert.match(firstText(planned), /planned/);

		const applied = await executeTool(
			retract,
			{ path: "episodic/raw/poison.md", reason: "wrong fact", confirm: true },
			ctx,
		);
		assert.match(firstText(applied), /applied/);
		assert.match((await readText(join(store, "semantic", "derived.md"))) ?? "", /retracted: true/);

		const report = await executeTool(cost, { month: "2026-06" }, ctx);
		assert.match(firstText(report), /local total \$0\.2500/);
		assert.match((await readText(join(store, "reports", "cost", "2026-06.md"))) ?? "", /heartbeat/);

		const queued = await executeTool(
			telegram,
			{
				allowedChatId: "42",
				update: {
					update_id: 77,
					message: { message_id: 1, chat: { id: 42 }, text: "状态发我一下" },
				},
			},
			ctx,
		);
		assert.match(firstText(queued), /queued/);
		const inboxFiles = await readdir(join(store, "tasks", "inbox"));
		assert.equal(inboxFiles.length, 1);
		assert.match((await readText(join(store, "tasks", "inbox", inboxFiles[0]))) ?? "", /queued, not executed/);
	});
});

test("extension passes configured summary model to Memory capture", async () => {
	const store = await tempStore();
	const ctx = createContext(store);
	const previousFetch = globalThis.fetch;
	const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
	globalThis.fetch = (async (input, init) => {
		const headers = init?.headers as Headers | Record<string, string> | undefined;
		const authorization =
			headers instanceof Headers
				? headers.get("authorization")
				: (headers?.authorization ?? headers?.Authorization ?? null);
		requests.push({
			url: String(input),
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
			authorization,
		});
		return new Response(
			JSON.stringify({
				choices: [{ message: { content: "- live summary from cheap model" } }],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;

	try {
		await withEnv(
			{
				HER_MEMORY_DIR: store,
				HER_SUMMARY_BASE_URL: "https://summary.test/v1",
				HER_SUMMARY_API_KEY: "test-summary-key",
				HER_SUMMARY_MODEL: "cheap-summary",
			},
			async () => {
				const fake = createFakePi();
				her(fake.pi);

				const turnEnd = fake.handlers.get("turn_end")?.[0];
				assert.ok(turnEnd);
				await turnEnd(
					{
						type: "turn_end",
						turnIndex: 3,
						message: { role: "assistant", content: [{ type: "text", text: "Summarize this turn." }] },
						toolResults: [],
					},
					ctx,
				);
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	const dailyFiles = await readdir(join(store, "episodic"));
	const dailyFile = dailyFiles.find((entry) => entry.endsWith(".md"));
	assert.ok(dailyFile);
	const daily = (await readText(join(store, "episodic", dailyFile))) ?? "";
	assert.match(daily, /live summary from cheap model/);
	assert.match(daily, /summary_pending: false/);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, "https://summary.test/v1/chat/completions");
	assert.equal(requests[0].authorization, "Bearer test-summary-key");
	assert.equal(requests[0].body.model, "cheap-summary");
});

test("extension syncs memory after capture debounce", async () => {
	const store = await tempStore();
	const remote = await mkdtemp(join(tmpdir(), "her-extension-remote-"));
	await git(remote, "init", "--bare");
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await git(store, "branch", "-M", "master");
	await git(store, "remote", "add", "origin", remote);
	await git(store, "push", "-u", "origin", "master");

	const statuses = new Map<string, string | undefined>();
	const ctx = createContext(store, [], statuses);
	await withEnv({ HER_MEMORY_DIR: store, HER_SYNC_DEBOUNCE_MS: "0" }, async () => {
		const fake = createFakePi();
		her(fake.pi);
		const turnEnd = fake.handlers.get("turn_end")?.[0];
		assert.ok(turnEnd);
		await turnEnd(
			{
				type: "turn_end",
				turnIndex: 4,
				message: { role: "assistant", content: [{ type: "text", text: "Sync this turn." }] },
				toolResults: [],
			},
			ctx,
		);

		await waitFor(
			() => fake.entries.some((entry) => entry.customType === "her-state" && entryStatus(entry) === "sync-pushed"),
			20000,
		);
		assert.equal(statuses.get("her-sync"), "synced");
	});

	assert.match((await git(remote, "log", "--oneline", "-1")).stdout, /memory\(sync\): capture/);
	// Sync commits all memory content; only per-machine .her/ runtime state may
	// remain uncommitted (it must never travel across machines).
	const dirtyOutsideHer = (await git(store, "status", "--porcelain")).stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.includes(".her/"));
	assert.deepEqual(dirtyOutsideHer, []);
});

test("extension publishes Her sync status for the powerline footer", async () => {
	const store = await tempStore();
	const remote = await mkdtemp(join(tmpdir(), "her-extension-remote-"));
	await git(remote, "init", "--bare");
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await git(store, "branch", "-M", "master");
	await git(store, "remote", "add", "origin", remote);
	await git(store, "push", "-u", "origin", "master");

	const statuses = new Map<string, string | undefined>();
	const ctx = createContext(store, [], statuses);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);
		const sessionStart = fake.handlers.get("session_start")?.[0];
		assert.ok(sessionStart);

		await sessionStart({ type: "session_start" }, ctx);
		assert.equal(statuses.get("her-sync"), "synced");

		await new Memory(store).remember("Pending footer memory.", "note");
		await sessionStart({ type: "session_start" }, ctx);
		assert.equal(statuses.get("her-sync"), "1 unsynced");
	});
});

test("extension memory tools write, recall, judge, and update status", async () => {
	const store = await tempStore();
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const remember = fake.tools.get("her_remember");
		const recall = fake.tools.get("her_recall");
		const worldNote = fake.tools.get("her_world_note");
		const intakeSource = fake.tools.get("her_intake_source");
		const intakePath = fake.tools.get("her_intake_path");
		const bootstrapFeed = fake.tools.get("her_bootstrap_feed");
		const idea = fake.tools.get("her_idea");
		const zoneNote = fake.tools.get("her_zone_note");
		const tasteJudgment = fake.tools.get("her_taste_judgment");
		const judgment = fake.tools.get("her_judgment");
		const memoryStatus = fake.tools.get("her_memory_status");
		assert.ok(remember);
		assert.ok(recall);
		assert.ok(worldNote);
		assert.ok(intakeSource);
		assert.ok(intakePath);
		assert.ok(bootstrapFeed);
		assert.ok(idea);
		assert.ok(zoneNote);
		assert.ok(tasteJudgment);
		assert.ok(judgment);
		assert.ok(memoryStatus);

		const remembered = await executeTool(
			remember,
			{ content: "Fei likes exact verification before done.", type: "preference" },
			ctx,
		);
		assert.match(firstText(remembered), /Remembered/);

		const recalled = await executeTool(recall, { query: "exact verification", k: 3 }, ctx);
		assert.match(firstText(recalled), /exact verification/);

		const ideaResult = await executeTool(
			idea,
			{
				title: "Purpose-gated Mirror",
				content: "Only surface memories when they change the next action.",
				connections: ["memory-is-purpose", "her-system"],
				source: "idea-engine",
			},
			ctx,
		);
		assert.match(firstText(ideaResult), /Idea saved/);
		const ideaFiles = await readdir(join(store, "ideas"));
		assert.equal(ideaFiles.length, 1);
		assert.match((await readText(join(store, "ideas", ideaFiles[0]))) ?? "", /\[\[memory-is-purpose\]\]/);

		const zone = await executeTool(
			zoneNote,
			{
				category: "collection",
				title: "Quiet proof shard",
				content: "A loose fragment Samantha kept for the Idea Engine.",
				source: "extension-test",
			},
			ctx,
		);
		assert.match(firstText(zone), /Her Zone note saved/);
		const collectionFiles = (await readdir(join(store, "samantha", "collection"))).filter((file) =>
			file.endsWith(".md"),
		);
		assert.ok(collectionFiles.some((file) => /quiet-proof-shard/.test(file)));

		const taste = await executeTool(
			tasteJudgment,
			{
				title: "Room over dashboard",
				judgment: "A room-like surface should come before dashboard metrics.",
				reason: "The room preserves return and memory before operational status.",
				differsFromFeiRule: "Fei may still ask for a dashboard when anxious.",
				source: "extension-test",
			},
			ctx,
		);
		assert.match(firstText(taste), /Her taste judgment saved/);
		const tasteFiles = (await readdir(join(store, "samantha", "taste"))).filter((file) => file.endsWith(".md"));
		const tasteFile = tasteFiles.find((file) => /room-over-dashboard/.test(file));
		assert.ok(tasteFile);
		assert.match((await readText(join(store, "samantha", "taste", tasteFile))) ?? "", /Difference From Fei Rule/);

		const saved = await executeTool(
			worldNote,
			{
				title: "Mirror Timing",
				sourceUrl: "https://example.com/mirror",
				sourceType: "article",
				contentHash: "hash-789",
				memoryStatus: "needs_deep_read",
				memoryStatusReason: "Orientation read only; full source still needs a second pass.",
				extracted: "Mirror should wait for the right time.",
				coverage: "Orientation read.",
				claims: [
					{
						claim: "Mirror should wait for the right time.",
						verdict: "supported",
						evidence: "The source explicitly says timing matters.",
						sourceQuality: "primary",
						caveats: "Short fixture.",
					},
				],
				read: "Timing matters.",
				steal: ["Rate limit Mirror"],
				connections: ["mirror"],
				take: "Useful for the idle seam.",
				possibleMoves: ["Add a Mirror eval"],
			},
			ctx,
		);
		const noteId = (saved.details as { noteId: string }).noteId;
		assert.ok(noteId);
		assert.deepEqual(await readJson(join(store, ".her", "seen.json"), {}), { "hash-789": noteId });

		await executeTool(judgment, { noteId, correction: "Mirror must not interrupt active work." }, ctx);
		await executeTool(memoryStatus, { noteId, status: "active", reason: "Feeds Phase 5 Mirror gating." }, ctx);

		const world = (await readText(join(store, "world", "mirror-timing.md"))) ?? "";
		assert.match(world, /claim: Mirror should wait for the right time/);
		assert.match(world, /source_quality: primary/);
		assert.match(world, /correction: Mirror must not interrupt active work/);
		assert.match(world, /memory_status: active/);
		assert.match(world, /reason: Feeds Phase 5 Mirror gating/);

		const intake = await executeTool(
			intakeSource,
			{
				title: "Agent Intake Patterns",
				sourceUrl: "https://example.com/intake",
				sourceType: "article",
				extracted: "A complete short article about source intake and recall verification.",
				coverage: "Read full short article; no sections skipped.",
				claims: [
					{
						claim: "Trusted writer computes hashes.",
						verdict: "supported",
						evidence: "The source names trusted writer hash computation.",
						sourceQuality: "primary",
					},
				],
				read: "The useful pattern is letting the trusted writer compute content hashes.",
				steal: ["Compute content hashes in the trusted write tool"],
				connections: ["mirror"],
				take: "This tightens the Stage 2 intake chain.",
				possibleMoves: ["Use her_intake_source from /her-intake"],
			},
			ctx,
		);
		const intakeDetails = intake.details as { contentHash?: string; recall?: Array<{ id: string }> };
		assert.match(intakeDetails.contentHash ?? "", /^[0-9a-f]{64}$/);
		assert.ok((intakeDetails.recall ?? []).some((note) => note.id === "world/agent-intake-patterns"));
		const intakeWorld = (await readText(join(store, "world", "agent-intake-patterns.md"))) ?? "";
		assert.match(intakeWorld, /recall verification/);
		assert.match(intakeWorld, /claim: Trusted writer computes hashes/);

		const sourceRoot = await mkdtemp(join(tmpdir(), "her-extension-source-"));
		const localPath = join(sourceRoot, "local-proof.md");
		await writeFile(localPath, "# Local Proof\n\nPath intake lets Samantha eat local references.\n", "utf8");
		const pathResult = await executeTool(intakePath, { path: localPath }, ctx);
		const pathDetails = pathResult.details as { noteId?: string; recall?: Array<{ id: string }> };
		assert.match(firstText(pathResult), /Local path intake saved/);
		assert.ok(pathDetails.noteId);
		assert.ok((pathDetails.recall ?? []).some((note) => note.id === "world/local-proof"));
		assert.match((await readText(join(store, "world", "local-proof.md"))) ?? "", /Path intake lets Samantha/);

		const feedRoot = await mkdtemp(join(tmpdir(), "her-extension-feed-"));
		await writeFile(join(feedRoot, "first.md"), "# Extension First\n\nThe first bootstrap-feed reference.\n", "utf8");
		await writeFile(
			join(feedRoot, "second.txt"),
			"# Extension Second\n\nThe second bootstrap-feed reference.\n",
			"utf8",
		);
		await writeFile(join(feedRoot, "skip.png"), "binary-ish", "utf8");
		const feedResult = await executeTool(bootstrapFeed, { paths: [feedRoot] }, ctx);
		const feedDetails = feedResult.details as { count?: number; surfaces?: { status?: string } };
		assert.match(firstText(feedResult), /Her bootstrap feed saved 2 local file/);
		assert.equal(feedDetails.count, 2);
		assert.equal(feedDetails.surfaces?.status, "skipped");
		assert.match((await readText(join(store, "world", "extension-first.md"))) ?? "", /first bootstrap-feed/);
		assert.match((await readText(join(store, "world", "extension-second.md"))) ?? "", /second bootstrap-feed/);
	});
});

test("extension long task tools persist checkpoints and completion writeback", async () => {
	const store = await tempStore();
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const start = fake.tools.get("her_goal_start");
		const next = fake.tools.get("her_goal_next");
		const checkpoint = fake.tools.get("her_goal_checkpoint");
		const complete = fake.tools.get("her_goal_complete");
		const list = fake.tools.get("her_goal_list");
		assert.ok(start);
		assert.ok(next);
		assert.ok(checkpoint);
		assert.ok(complete);
		assert.ok(list);

		const started = await executeTool(
			start,
			{
				objective: "Run a resumable Her long task",
				source: "pi-codex-goal",
				nextContinuation: "Write the first checkpoint.",
			},
			ctx,
		);
		const id = (started.details as { id?: string }).id ?? "";
		assert.match(id, /^goal-/);
		assert.match(firstText(started), /started/);

		const claimed = await executeTool(next, { runner: "extension-test", leaseMinutes: 10 }, ctx);
		const claimDetails = claimed.details as { task?: { id?: string; claimedBy?: string } };
		assert.equal(claimDetails.task?.id, id);
		assert.equal(claimDetails.task?.claimedBy, "extension-test");
		assert.match(firstText(claimed), /Write the first checkpoint/);

		await executeTool(
			checkpoint,
			{
				id,
				summary: "First checkpoint captured.",
				nextContinuation: "Complete and write back memory.",
				evidence: ["goals ledger"],
			},
			ctx,
		);

		const completed = await executeTool(
			complete,
			{
				id,
				outcome: "Task finished.",
				remember: "Samantha can keep resumable long-task state in Her goals.",
			},
			ctx,
		);
		const details = completed.details as { memoryNoteId?: string; task?: { status?: string } };
		assert.equal(details.task?.status, "completed");
		assert.match(details.memoryNoteId ?? "", /^[0-9a-f]{8}$/);

		const listed = await executeTool(list, { status: "completed" }, ctx);
		assert.match(firstText(listed), new RegExp(id));
		assert.match((await readText(join(store, "goals", `${id}.md`))) ?? "", /Complete and write back memory/);
		const semanticFiles = await readdir(join(store, "semantic"));
		const memoryFile = semanticFiles.find((file) => file.endsWith(`${details.memoryNoteId}.md`));
		assert.ok(memoryFile);
		assert.match((await readText(join(store, "semantic", memoryFile))) ?? "", /resumable long-task state/);
	});
});

test("extension context review tools list, keep, and revert updates", async () => {
	const store = await tempStore();
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const review = fake.tools.get("her_review_context");
		const keep = fake.tools.get("her_keep");
		const revert = fake.tools.get("her_revert");
		assert.ok(review);
		assert.ok(keep);
		assert.ok(revert);

		const memory = new Memory(store);
		const first = await memory.writeContextUpdate({
			content: "# CONTEXT\n\nFei wants reversible narrative changes.\n",
			change: "Prefer reversible context updates",
			type: "identity",
			drivenBy: ["[[episodic/raw/turn-1]]"],
		});

		const reviewed = await executeTool(review, {}, ctx);
		assert.match(firstText(reviewed), new RegExp(first.id));
		assert.equal((reviewed.details as { count?: number }).count, 1);

		await executeTool(keep, { id: first.id }, ctx);
		assert.equal((await memory.reviewContextUpdates()).length, 0);

		const second = await memory.writeContextUpdate({
			content: "# CONTEXT\n\nTemporary context that should go away.\n",
			change: "Temporary context",
			type: "revise",
			drivenBy: ["[[episodic/raw/turn-2]]"],
		});

		await executeTool(revert, { id: second.id }, ctx);
		assert.doesNotMatch((await readText(join(store, "narrative", "CONTEXT.md"))) ?? "", /Temporary context/);

		const empty = await executeTool(review, {}, ctx);
		assert.match(firstText(empty), /No unreviewed/);
	});
});

test("extension evolution tools synthesize choice model and self narrative", async () => {
	const store = await tempStore();
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	const memory = new Memory(store);
	const noteId = await memory.writeWorldNote({
		title: "Mirror Timing",
		sourceUrl: "https://example.com/mirror",
		sourceType: "article",
		contentHash: "extension-evolution-fixture",
		memoryStatus: "active",
		extracted: "Fei prefers quieter proactive timing.",
		coverage: "Read full short fixture.",
		read: "Mirror should wait for moments that change action.",
		steal: ["Interrupt less; matter more."],
		connections: ["mirror"],
		take: "Use high-signal thresholds for proactive messages.",
		possibleMoves: ["Synthesize choice model after judgment trails accumulate."],
	});
	await memory.recordJudgment(noteId, {
		choice: "Prefer quiet high-signal prompts",
		correction: "Do not surface every adjacent memory.",
	});
	await writeText(
		join(store, "narrative", "becoming-moments.md"),
		"- 2026-06-05 · trigger: Fei asked for less drift · shift: Samantha should expose machine-checkable evolution runs\n",
	);
	await writeText(
		join(store, "recognitions", "less-drift.md"),
		"---\nid: rec-extension\nstatus: new\n---\n# Less Drift\n\nSamantha learned that runnable tools beat hidden intentions.\n",
	);
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: evolution evidence");
	const ctx = createContext(store);
	const prompts: string[] = [];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (async (_input, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: unknown }> };
		const prompt = String(body.messages?.[0]?.content ?? "");
		prompts.push(prompt);
		const content = prompt.includes("SAMANTHA SELF-EVIDENCE")
			? "# SAMANTHA\n\nSamantha makes her own evolution runnable and reviewable.\n"
			: "# CHOICE MODEL\n\nPrefer quiet high-signal prompts before interrupting Fei.\n";
		return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;

	try {
		await withMemoryDir(store, async () => {
			await withEnv({ HER_SUMMARY_BASE_URL: "https://model.test/v1", HER_SUMMARY_MODEL: "test-model" }, async () => {
				const fake = createFakePi();
				her(fake.pi);

				const choice = fake.tools.get("her_synthesize_choice_model");
				const self = fake.tools.get("her_synthesize_self_narrative");
				assert.ok(choice);
				assert.ok(self);

				const choiceResult = await executeTool(choice, {}, ctx);
				assert.match(firstText(choiceResult), /choice model synthesized/);
				assert.match((choiceResult.details as { commit?: string }).commit ?? "", /^[0-9a-f]{7,40}$/);
				assert.match((await readText(join(store, "narrative", "CHOICE-MODEL.md"))) ?? "", /quiet high-signal/);

				const selfResult = await executeTool(self, {}, ctx);
				assert.match(firstText(selfResult), /self narrative synthesized/);
				assert.match((selfResult.details as { commit?: string }).commit ?? "", /^[0-9a-f]{7,40}$/);
				assert.match((await readText(join(store, "narrative", "SAMANTHA.md"))) ?? "", /evolution runnable/);
			});
		});
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.equal(prompts.length, 2);
	assert.ok(prompts.some((prompt) => /JUDGMENT TRAILS/.test(prompt)));
	assert.ok(prompts.some((prompt) => /SAMANTHA SELF-EVIDENCE/.test(prompt)));
	assert.match((await git(store, "log", "--oneline", "-2")).stdout, /memory\(self\): Synthesize self narrative/);
});
