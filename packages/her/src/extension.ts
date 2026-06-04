import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { anthropicOAuthProvider, openaiCodexOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type IdeaData,
	type JudgmentFields,
	Memory,
	type MemorySyncResult,
	type MemorySyncStatus,
	type WorldNoteData,
} from "./her-core/index.ts";
import { createSummaryModel } from "./summary-model.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const skillsDir = resolve(packageRoot, "pi-package", "skills");
const promptsDir = resolve(packageRoot, "pi-package", "prompts");
const herPromptPath = resolve(promptsDir, "her.md");

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const memoryStatusValues = ["active", "archive_only", "needs_deep_read"] as const;

interface SessionMeta {
	sessionId: string;
	sessionFile?: string;
	leafId: string | null;
	cwd: string;
}

function model(id: string, name: string, api: string, reasoning: boolean) {
	return {
		id,
		name,
		api,
		reasoning,
		input: ["text"] as ("text" | "image")[],
		cost: zeroCost,
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function registerProviderPool(pi: ExtensionAPI): void {
	const providers: Array<[string, ProviderConfig]> = [
		[
			"her-claude-oauth",
			{
				name: "Her Claude Pro/Max OAuth",
				baseUrl: "https://api.anthropic.com",
				api: "anthropic-messages",
				oauth: anthropicOAuthProvider,
				models: [
					model("claude-sonnet-4-20250514", "Claude Sonnet 4 for Samantha (OAuth)", "anthropic-messages", true),
				],
			},
		],
		[
			"her-claude",
			{
				name: "Her Claude",
				baseUrl: "https://api.anthropic.com",
				apiKey: "$HER_CLAUDE_API_KEY",
				api: "anthropic-messages",
				models: [model("claude-sonnet-4-20250514", "Claude Sonnet 4 for Samantha", "anthropic-messages", true)],
			},
		],
		[
			"her-codex-oauth",
			{
				name: "Her ChatGPT Pro/Codex OAuth",
				baseUrl: "https://chatgpt.com/backend-api",
				api: "openai-codex-responses",
				oauth: openaiCodexOAuthProvider,
				models: [model("gpt-5-codex", "GPT-5 Codex for Samantha (OAuth)", "openai-codex-responses", true)],
			},
		],
		[
			"her-codex",
			{
				name: "Her GPT/Codex",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "$HER_OPENAI_API_KEY",
				api: "openai-responses",
				models: [model("gpt-5-codex", "GPT Codex for Samantha", "openai-responses", true)],
			},
		],
		[
			"her-relay",
			{
				name: "Her Relay",
				baseUrl: "$HER_RELAY_URL",
				apiKey: "$HER_RELAY_KEY",
				api: "openai-completions",
				models: [model("her-relay-default", "Relay default", "openai-completions", false)],
			},
		],
		[
			"her-deepseek",
			{
				name: "Her DeepSeek",
				baseUrl: "https://api.deepseek.com",
				apiKey: "$HER_DEEPSEEK_KEY",
				api: "openai-completions",
				models: [
					model("deepseek-chat", "DeepSeek Chat", "openai-completions", false),
					model("deepseek-reasoner", "DeepSeek Reasoner", "openai-completions", true),
				],
			},
		],
		[
			"her-local",
			{
				name: "Her Local OpenAI-compatible",
				baseUrl: "$HER_LOCAL_OPENAI_URL",
				apiKey: "$HER_LOCAL_OPENAI_KEY",
				api: "openai-completions",
				models: [model("local-default", "Local default", "openai-completions", false)],
			},
		],
	];

	for (const [name, config] of providers) {
		pi.registerProvider(name, config);
	}
}

function readHerPrompt(): string {
	return readFileSync(herPromptPath, "utf8").trim();
}

function getMemoryDir(): string {
	return process.env.HER_MEMORY_DIR ?? resolve(process.cwd(), "..", "her-memory");
}

function composeSystemPrompt(base: string, context: string, facts: string): string {
	const sections = [readHerPrompt(), `## Her CONTEXT.md\n\n${context.trim()}`];
	if (facts.trim()) sections.push(`## Her FACTS.md\n\n${facts.trim()}`);
	return `${base.trimEnd()}\n\n${sections.join("\n\n")}`;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function renderSync(result: MemorySyncResult): string {
	if (result.status === "clean") return "Her memory is already synced.";
	return `Her memory synced: ${result.commit}`;
}

function renderSyncFooterStatus(status: MemorySyncStatus): string {
	if (status.status === "unknown") return "sync unknown";
	if (status.pending === 0) return "synced";
	return `${status.pending} unsynced`;
}

function renderContextReview(updates: Awaited<ReturnType<Memory["reviewContextUpdates"]>>): string {
	if (updates.length === 0) return "No unreviewed Her context updates.";
	return updates
		.map((update, index) =>
			[
				`${index + 1}. ${update.id} (${update.type}, ${update.status})`,
				`change: ${update.change}`,
				update.commit ? `commit: ${update.commit}` : undefined,
				update.drivenBy.length > 0 ? `driven_by: ${update.drivenBy.join(", ")}` : undefined,
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n\n");
}

function renderContextDigest(updates: Awaited<ReturnType<Memory["reviewContextUpdates"]>>): string {
	const identityCount = updates.filter((update) => update.type === "identity").length;
	const identityText = identityCount > 0 ? ` (${identityCount} identity-level)` : "";
	return `Her context changed in ${updates.length} unreviewed update(s)${identityText}.\n\n${renderContextReview(updates)}`;
}

function renderRecall(notes: Awaited<ReturnType<Memory["recall"]>>): string {
	if (notes.length === 0) return "No Her memory hits.";
	return notes
		.map((note, index) => {
			const excerpt = note.text.trim().replace(/\s+/g, " ").slice(0, 500);
			return `${index + 1}. ${note.id} (${note.kind})\n${excerpt}`;
		})
		.join("\n\n");
}

function renderMirror(note: NonNullable<Awaited<ReturnType<Memory["surface"]>>>): string {
	const excerpt = note.text.trim().replace(/\s+/g, " ").slice(0, 700);
	return `A memory surfaced: ${note.id}\n\n${excerpt}`;
}

function turnToRaw(event: { turnIndex: number; message: unknown; toolResults: unknown }, session: SessionMeta): string {
	return `# Pi Turn ${event.turnIndex}

${safeJson({
	session,
	turnIndex: event.turnIndex,
	message: event.message,
	toolResults: event.toolResults,
})}
`;
}

function safeJson(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(
		value,
		(_key, current) => {
			if (typeof current === "bigint") return current.toString();
			if (!current || typeof current !== "object") return current;
			if (seen.has(current)) return "[Circular]";
			seen.add(current);
			return current;
		},
		2,
	);
}

function hasActiveGoal(ctx: ExtensionContext): boolean {
	const entries = [...ctx.sessionManager.getEntries()].reverse();
	for (const entry of entries) {
		if (!("customType" in entry) || entry.customType !== "pi-codex-goal") continue;
		const data = "data" in entry ? entry.data : undefined;
		if (!data || typeof data !== "object") continue;
		if (!("kind" in data)) continue;
		if (data.kind === "clear") return false;
		if (data.kind === "usage" && "status" in data) return data.status === "active";
		if (
			data.kind === "set" &&
			"goal" in data &&
			data.goal &&
			typeof data.goal === "object" &&
			"status" in data.goal
		) {
			return data.goal.status === "active";
		}
	}
	return false;
}

function syncDebounceMs(): number {
	const parsed = Number(process.env.HER_SYNC_DEBOUNCE_MS);
	if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	return 5 * 60 * 1000;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function her(pi: ExtensionAPI): void {
	const memoryDir = getMemoryDir();
	const mem = new Memory(memoryDir, createSummaryModel());
	let syncTimer: ReturnType<typeof setTimeout> | undefined;
	registerProviderPool(pi);

	const runSync = async (reason: string, ctx?: ExtensionContext): Promise<MemorySyncResult | undefined> => {
		try {
			const result = await mem.sync(`memory(sync): ${reason}`);
			const status = result.status === "pushed" ? "sync-pushed" : "sync-clean";
			ctx?.ui.setStatus("her-sync", "synced");
			pi.appendEntry("her-state", {
				phase: "2",
				status,
				commit: result.commit,
				memoryDir,
			});
			if (result.status === "pushed" && ctx?.hasUI) ctx.ui.notify(renderSync(result), "info");
			return result;
		} catch (error) {
			const message = errorMessage(error);
			ctx?.ui.setStatus("her-sync", "sync failed");
			pi.appendEntry("her-state", {
				phase: "2",
				status: "sync-failed",
				error: message,
				memoryDir,
			});
			if (ctx?.hasUI) ctx.ui.notify(`Her memory sync failed: ${message}`, "error");
			return undefined;
		}
	};

	const publishSyncStatus = async (ctx: ExtensionContext): Promise<MemorySyncStatus> => {
		const status = await mem.syncStatus();
		ctx.ui.setStatus("her-sync", renderSyncFooterStatus(status));
		return status;
	};

	const scheduleSync = (reason: string, ctx: ExtensionContext): void => {
		if (syncTimer) clearTimeout(syncTimer);
		const delay = syncDebounceMs();
		const sync = () => void runSync(reason, ctx);
		if (delay === 0) {
			sync();
			return;
		}
		syncTimer = setTimeout(sync, delay);
		syncTimer.unref?.();
	};

	pi.on("resources_discover", () => ({
		skillPaths: [skillsDir],
		promptPaths: [promptsDir],
	}));

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("her", "Her loaded");
		await publishSyncStatus(ctx);
		ctx.ui.notify("Her loaded", "info");
		pi.appendEntry("her-state", {
			phase: "2",
			status: "loaded",
			memoryDir,
		});
	});

	pi.on("before_agent_start", async (event) => {
		const { context, facts } = await mem.getContext();
		return {
			systemPrompt: composeSystemPrompt(event.systemPrompt, context, facts),
			message: {
				customType: "her-context",
				content: "Her CONTEXT.md and FACTS.md were injected for this turn.",
				display: false,
				details: { pinned: true, memoryDir },
			},
		};
	});

	pi.on("turn_end", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const session: SessionMeta = {
			sessionId,
			sessionFile: ctx.sessionManager.getSessionFile(),
			leafId: ctx.sessionManager.getLeafId(),
			cwd: ctx.cwd,
		};
		const noteId = await mem.capture(turnToRaw(event, session), {
			sessionId: `${sessionId}-turn-${event.turnIndex}`,
			project: ctx.cwd,
		});
		pi.appendEntry("her-state", {
			phase: "2",
			status: "captured",
			lastCapturedLeaf: session.leafId,
			noteId,
			memoryDir,
		});
		try {
			if (!ctx.isIdle() || ctx.hasPendingMessages() || hasActiveGoal(ctx)) return;
			const digest = await mem.contextDigestDue();
			if (digest.length > 0) {
				pi.sendMessage(
					{
						customType: "her-context-digest",
						content: renderContextDigest(digest),
						display: true,
						details: { updates: digest.map((update) => update.id), pinned: true },
					},
					{ deliverAs: "followUp" },
				);
				await mem.markContextDigestSent(digest.map((update) => update.id));
				pi.appendEntry("her-state", {
					phase: "2",
					status: "context-digest-sent",
					count: digest.length,
					memoryDir,
				});
				return;
			}
			const hit = await mem.surface({
				query: safeJson({ message: event.message, toolResults: event.toolResults }),
				sessionId,
			});
			if (!hit) return;
			pi.sendMessage(
				{
					customType: "her-mirror",
					content: renderMirror(hit),
					display: true,
					details: { noteId: hit.id, kind: hit.kind, pinned: true },
				},
				{ deliverAs: "followUp" },
			);
			pi.appendEntry("her-state", {
				phase: "5",
				status: "mirror-sent",
				noteId: hit.id,
				memoryDir,
			});
		} finally {
			await publishSyncStatus(ctx);
			scheduleSync("capture", ctx);
		}
	});

	pi.on("session_before_compact", () => {
		pi.appendEntry("her-state", {
			phase: "2",
			status: "compact-guard",
			pinned: true,
			instruction: "Preserve FACTS.md ground truth and her-* pinned entries.",
		});
		return {
			customInstructions:
				"Preserve Her memory grounding during compaction: keep narrative/FACTS.md ground truth, keep the latest Her CONTEXT.md injection, and retain her-* pinned entries/messages.",
		};
	});

	pi.registerTool({
		name: "her_status",
		label: "Her Status",
		description: "Report Samantha's Her memory integration status.",
		parameters: Type.Object({}),
		async execute() {
			return textResult("Her loaded. Phase 2 context injection, turn capture, and memory tools are active.", {
				phase: "2",
				memoryDir,
			});
		},
	});

	pi.registerTool({
		name: "her_recall",
		label: "Her Recall",
		description: "Search Samantha's owned memory.",
		parameters: Type.Object({
			query: Type.String({ description: "Memory search query" }),
			k: Type.Optional(Type.Number({ description: "Maximum number of notes to return" })),
		}),
		async execute(_toolCallId, params) {
			const notes = await mem.recall(params.query, { k: params.k });
			return textResult(renderRecall(notes), {
				phase: "2",
				query: params.query,
				count: notes.length,
				notes: notes.map((note) => ({ id: note.id, kind: note.kind, path: note.path })),
			});
		},
	});

	pi.registerTool({
		name: "her_sync",
		label: "Her Sync",
		description: "Commit and push pending Her memory changes.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const result = await runSync("manual", ctx);
			if (!result) return textResult("Her memory sync failed.", { phase: "2", status: "failed", memoryDir });
			return textResult(renderSync(result), { phase: "2", ...result, memoryDir });
		},
	});

	pi.registerTool({
		name: "her_review_context",
		label: "Her Review Context",
		description: "List unreviewed Her CONTEXT.md updates before they become trusted narrative.",
		parameters: Type.Object({}),
		async execute() {
			const updates = await mem.reviewContextUpdates();
			return textResult(renderContextReview(updates), { phase: "2", count: updates.length, updates, memoryDir });
		},
	});

	pi.registerTool({
		name: "her_keep",
		label: "Her Keep Context",
		description: "Mark a reviewed Her context update as kept.",
		parameters: Type.Object({
			id: Type.String({ description: "Context update id from her_review_context" }),
		}),
		async execute(_toolCallId, params) {
			await mem.keepContextUpdate(params.id);
			return textResult(`Kept Her context update: ${params.id}`, { phase: "2", id: params.id, memoryDir });
		},
	});

	pi.registerTool({
		name: "her_revert",
		label: "Her Revert Context",
		description: "Revert an unreviewed Her context update and restore the previous CONTEXT.md.",
		parameters: Type.Object({
			id: Type.String({ description: "Context update id from her_review_context" }),
		}),
		async execute(_toolCallId, params) {
			await mem.revertContextUpdate(params.id);
			return textResult(`Reverted Her context update: ${params.id}`, { phase: "2", id: params.id, memoryDir });
		},
	});

	pi.registerTool({
		name: "her_remember",
		label: "Her Remember",
		description: "Write a durable semantic memory note.",
		parameters: Type.Object({
			content: Type.String({ description: "Memory content to preserve" }),
			type: Type.Optional(Type.String({ description: "Memory unit type, e.g. note, preference, decision" })),
		}),
		async execute(_toolCallId, params) {
			const noteId = await mem.remember(params.content, params.type);
			return textResult(`Remembered in Her memory: ${noteId}`, { phase: "2", noteId, memoryDir });
		},
	});

	pi.registerTool({
		name: "her_world_note",
		label: "Her World Note",
		description: "Persist an intake source as a Her world note with coverage and possible moves.",
		parameters: Type.Object({
			title: Type.String(),
			sourceUrl: Type.String(),
			sourceType: Type.String(),
			contentHash: Type.String(),
			memoryStatus: StringEnum(memoryStatusValues),
			extracted: Type.String(),
			coverage: Type.String(),
			read: Type.String(),
			steal: Type.Array(Type.String()),
			connections: Type.Array(Type.String()),
			take: Type.String(),
			possibleMoves: Type.Array(Type.String()),
		}),
		async execute(_toolCallId, params) {
			const data: WorldNoteData = params;
			const noteId = await mem.writeWorldNote(data);
			return textResult(`World note saved in Her memory: ${noteId}`, { phase: "2", noteId, memoryDir });
		},
	});

	pi.registerTool({
		name: "her_idea",
		label: "Her Idea",
		description: "Persist an idea-engine candidate into Her ideas namespace.",
		parameters: Type.Object({
			title: Type.String(),
			content: Type.String(),
			connections: Type.Optional(Type.Array(Type.String())),
			source: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params) {
			const data: IdeaData = params;
			const noteId = await mem.writeIdea(data);
			return textResult(`Idea saved in Her memory: ${noteId}`, { phase: "4", noteId, memoryDir });
		},
	});

	pi.registerTool({
		name: "her_judgment",
		label: "Her Judgment",
		description: "Append Fei's correction or choice signal to a world note's Judgment Trail.",
		parameters: Type.Object({
			noteId: Type.String(),
			attraction: Type.Optional(Type.String()),
			inferredIntent: Type.Optional(Type.String()),
			choice: Type.Optional(Type.String()),
			rejection: Type.Optional(Type.String()),
			hesitation: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String()),
			outcome: Type.Optional(Type.String()),
			correction: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params) {
			const { noteId, ...fields } = params;
			await mem.recordJudgment(noteId, fields satisfies JudgmentFields);
			return textResult(`Judgment recorded for Her note: ${noteId}`, { phase: "2", noteId, memoryDir });
		},
	});

	pi.registerTool({
		name: "her_memory_status",
		label: "Her Memory Status",
		description: "Set a world note memory status with an explicit reason.",
		parameters: Type.Object({
			noteId: Type.String(),
			status: StringEnum(memoryStatusValues),
			reason: Type.String(),
		}),
		async execute(_toolCallId, params) {
			await mem.setMemoryStatus(params.noteId, params.status, params.reason);
			return textResult(`Memory status set for Her note: ${params.noteId}`, {
				phase: "2",
				noteId: params.noteId,
				status: params.status,
				memoryDir,
			});
		},
	});
}
