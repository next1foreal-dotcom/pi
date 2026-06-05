import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import her from "../src/extension.ts";
import { initStore, Memory, readJson, readText, writeText } from "../src/her-core/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
const execFileAsync = promisify(execFile);

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
	await writeText(join(store, "narrative", "SAMANTHA.md"), "# SAMANTHA\n\nSamantha is learning to stay grounded.\n");
	await writeText(join(store, "narrative", "CHOICE-MODEL.md"), "# CHOICE MODEL\n\nPrefer reversible moves.\n");

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		assert.equal(fake.providers.has("her-claude"), true);
		assert.equal(fake.providers.has("her-claude-oauth"), true);
		assert.equal(fake.providers.has("her-codex"), true);
		assert.equal(fake.providers.has("her-codex-oauth"), true);
		assert.match(fake.providers.get("her-claude-oauth")?.oauth?.name ?? "", /Claude Pro/);
		assert.match(fake.providers.get("her-codex-oauth")?.oauth?.name ?? "", /ChatGPT/);
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
		assert.match(injected.systemPrompt ?? "", /Samantha is learning to stay grounded/);
		assert.match(injected.systemPrompt ?? "", /Prefer reversible moves/);
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

test("extension returns compact guard instructions for Her pinned context", async () => {
	const store = await tempStore();
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const beforeCompact = fake.handlers.get("session_before_compact")?.[0];
		assert.ok(beforeCompact);
		const result = (await beforeCompact({ type: "session_before_compact" }, ctx)) as { customInstructions?: string };

		assert.match(result.customInstructions ?? "", /FACTS\.md/);
		assert.match(result.customInstructions ?? "", /her-\*/);
		assert.match(result.customInstructions ?? "", /pinned/);
		assert.equal(
			fake.entries.some((entry) => entry.customType === "her-state" && entryStatus(entry) === "compact-guard"),
			true,
		);
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
	assert.equal((await git(store, "status", "--porcelain")).stdout.trim(), "");
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
		const idea = fake.tools.get("her_idea");
		const judgment = fake.tools.get("her_judgment");
		const memoryStatus = fake.tools.get("her_memory_status");
		assert.ok(remember);
		assert.ok(recall);
		assert.ok(worldNote);
		assert.ok(intakeSource);
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
	});
});

test("extension long task tools persist checkpoints and completion writeback", async () => {
	const store = await tempStore();
	const ctx = createContext(store);

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);

		const start = fake.tools.get("her_goal_start");
		const checkpoint = fake.tools.get("her_goal_checkpoint");
		const complete = fake.tools.get("her_goal_complete");
		const list = fake.tools.get("her_goal_list");
		assert.ok(start);
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
