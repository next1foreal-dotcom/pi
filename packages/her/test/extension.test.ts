import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import her from "../src/extension.ts";
import { initStore, readJson, readText, writeText } from "../src/her-core/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface FakePi {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	tools: Map<string, ToolDefinition>;
	providers: Map<string, ProviderConfig>;
	entries: Array<{ customType: string; data?: unknown }>;
	messages: Array<{ message: unknown; options?: unknown }>;
}

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-extension-"));
	await initStore(root);
	return root;
}

function createFakePi(): FakePi {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition>();
	const providers = new Map<string, ProviderConfig>();
	const entries: Array<{ customType: string; data?: unknown }> = [];
	const messages: Array<{ message: unknown; options?: unknown }> = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerProvider(name: string, config: ProviderConfig) {
			providers.set(name, config);
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

function createContext(cwd: string, entries: unknown[] = []): ExtensionContext {
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

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		assert.equal(fake.providers.has("her-claude"), true);
		assert.equal(fake.providers.has("her-codex"), true);
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

test("extension memory tools write, recall, judge, and update status", async () => {
	const store = await tempStore();
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const remember = fake.tools.get("her_remember");
		const recall = fake.tools.get("her_recall");
		const worldNote = fake.tools.get("her_world_note");
		const idea = fake.tools.get("her_idea");
		const judgment = fake.tools.get("her_judgment");
		const memoryStatus = fake.tools.get("her_memory_status");
		assert.ok(remember);
		assert.ok(recall);
		assert.ok(worldNote);
		assert.ok(idea);
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

		const saved = await executeTool(
			worldNote,
			{
				title: "Mirror Timing",
				sourceUrl: "https://example.com/mirror",
				sourceType: "article",
				contentHash: "hash-789",
				memoryStatus: "needs_deep_read",
				extracted: "Mirror should wait for the right time.",
				coverage: "Orientation read.",
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
		assert.match(world, /correction: Mirror must not interrupt active work/);
		assert.match(world, /memory_status: active/);
		assert.match(world, /reason: Feeds Phase 5 Mirror gating/);
	});
});
