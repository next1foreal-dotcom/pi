import { createHash } from "node:crypto";
import { contentText } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bumpCompactionEpoch } from "./design-canvas/epoch.ts";
import type { ModelLike } from "./her-core/index.ts";
import { ANTI_NESTING_CLAUSE } from "./her-core/prompts.ts";

/** Her pinned narrative that must survive every compaction. */
export interface HerGrounding {
	context: string;
	facts: string;
	soul: string;
	self: string;
	choiceModel: string;
}

/** Subset of pi's CompactionPreparation that Her reads. */
export interface CompactionPreparationLike {
	previousSummary?: string;
	messagesToSummarize?: unknown[];
	turnPrefixMessages?: unknown[];
}

export type TaskHistoryAudit = {
	version: "task-history-v1";
	applied: boolean;
	taskDigest: string;
	selected: Array<{ index: number; score: number; reasons: string[] }>;
	omitted: number;
};

export type TaskHistoryReconstruction = {
	text: string;
	audit: TaskHistoryAudit;
};

/**
 * Character budgets for the transcript excerpts we hand to a summarization model.
 * Sized for the smallest model Her may fall back to (DeepSeek, 64k tokens): the
 * excerpts stay under ~56k characters, so even a 1 token/character worst case
 * (CJK) leaves room for the pinned narrative, the instructions, and the answer.
 * dsh 80%/16%/pruner is not copied here — see docs/specs/2026-08-14-g263-compaction-ladder.md.
 */
export const COMPACTION_TRANSCRIPT_BUDGET = 48_000;
export const COMPACTION_PREFIX_BUDGET = 8_000;
const PROMPT_EXCERPT_CHARS = 1_200;
const FALLBACK_TRANSCRIPT_BUDGET = 24_000;
const FALLBACK_PREFIX_BUDGET = 4_000;
const FALLBACK_EXCERPT_CHARS = 200;
const SUMMARY_MAX_TOKENS = 2_000;

const COMPACTION_SYSTEM_PROMPT =
	"You summarize a coding session for continuation. Preserve machine-truth grounding, never invent facts.";

const DEGRADED_NOTICE =
	"Model summarization was unavailable; the section below is a structured degradation, not a model summary.";

export type CompactionIntegrityAudit = {
	version: "compaction-integrity-v1";
	applied: boolean;
	anchors: number;
	missing: Array<{ kind: string; messageIndex: number; digest: string }>;
};

type CompactionAnchor = { kind: string; messageIndex: number; text: string };

const integrityPatterns: Array<[string, RegExp]> = [
	["constraint", /\b(?:must|must not|only|preserve|never|cannot)\b|必须|不要|只能|保留|不能|不得/i],
	["decision", /\b(?:decided|decision|approved|confirmed|adopted)\b|决定|确认|拍板|采用/i],
	["todo", /\b(?:todo|remaining|next step|unfinished)\b|待办|还需|下一步|未完成/i],
];

function compactionAnchors(messages: unknown[] | undefined): CompactionAnchor[] {
	const list = messages ?? [];
	const anchors: CompactionAnchor[] = [];
	for (let index = list.length - 1; index >= 0; index--) {
		const record = asRecord(list[index]);
		if (record?.role !== "user") continue;
		const text = excerpt(record.content, 240);
		if (text) {
			anchors.push({ kind: "objective", messageIndex: index, text });
			break;
		}
	}
	for (const [kind, pattern] of integrityPatterns) {
		for (let index = list.length - 1; index >= 0; index--) {
			const record = asRecord(list[index]);
			if (record?.role !== "user" && record?.role !== "assistant") continue;
			const text = excerpt(record.content, 240);
			if (text && pattern.test(text)) {
				anchors.push({ kind, messageIndex: index, text });
				break;
			}
		}
	}
	for (let index = list.length - 1; index >= 0; index--) {
		const record = asRecord(list[index]);
		if (record?.role !== "toolResult") continue;
		const text = excerpt(record.content, 240);
		if (text && /\b(?:pass(?:ed)?|fail(?:ed)?|verified|tests?)\b|通过|失败|验证|验收/i.test(text)) {
			anchors.push({ kind: "evidence", messageIndex: index, text });
			break;
		}
	}
	return anchors.filter((anchor, index, all) => all.findIndex((item) => item.text === anchor.text) === index);
}

function summaryContains(summary: string, anchor: string): boolean {
	const normalize = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
	const needle = normalize(anchor).slice(0, 80);
	return needle.length > 0 && normalize(summary).includes(needle);
}

export function applyCompactionIntegrity(
	summary: string,
	messages: unknown[] | undefined,
	mode: "shadow" | "enforce" = "shadow",
): { summary: string; audit: CompactionIntegrityAudit } {
	const anchors = compactionAnchors(messages);
	const missingAnchors = anchors.filter((anchor) => !summaryContains(summary, anchor.text));
	const missing = missingAnchors.map(({ kind, messageIndex, text }) => ({
		kind,
		messageIndex,
		digest: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16),
	}));
	const applied = mode === "enforce";
	if (!applied || missingAnchors.length === 0) {
		return { summary, audit: { version: "compaction-integrity-v1", applied, anchors: anchors.length, missing } };
	}
	const lines = [
		...new Map(missingAnchors.map((anchor) => [anchor.text, `- **${anchor.kind}**: ${anchor.text}`])).values(),
	];
	return {
		summary: `${summary.trimEnd()}\n\n## Compaction Integrity Anchors\n${lines.join("\n")}`,
		audit: { version: "compaction-integrity-v1", applied, anchors: anchors.length, missing },
	};
}
/** Summarize with the session's own model, the env-configured model, or a structured fallback. */
export async function summarizeForCompaction(input: {
	grounding: HerGrounding;
	preparation: CompactionPreparationLike;
	ctx?: ExtensionContext;
	envModel?: ModelLike;
	signal?: AbortSignal;
	mode?: "shadow" | "enforce";
}): Promise<{
	summary: string;
	source: string;
	reconstruction: TaskHistoryAudit;
	integrity: CompactionIntegrityAudit;
	errors?: string[];
}> {
	const taskHistory = reconstructTaskHistory(input.preparation.messagesToSummarize, {
		budget: COMPACTION_TRANSCRIPT_BUDGET,
		perMessage: PROMPT_EXCERPT_CHARS,
		applied: input.mode === "enforce",
	});
	const prompt = renderCompactionPrompt({
		...input.grounding,
		preparation: input.preparation,
		...(taskHistory.audit.applied ? { taskHistory } : {}),
	});
	const candidates: Array<{ source: string; model: ModelLike }> = [];
	const sessionModel = input.ctx ? sessionSummaryModel(input.ctx, input.signal) : undefined;
	if (sessionModel) candidates.push({ source: "session-model", model: sessionModel });
	if (input.envModel) candidates.push({ source: "summary-model", model: input.envModel });

	const errors: string[] = [];
	for (const candidate of candidates) {
		try {
			const summary = await candidate.model.complete(prompt);
			if (summary.trim()) {
				const integrity = applyCompactionIntegrity(summary, input.preparation.messagesToSummarize, input.mode);
				bumpCompactionEpoch();
				return {
					summary: integrity.summary,
					source: candidate.source,
					reconstruction: taskHistory.audit,
					integrity: integrity.audit,
					...(errors.length ? { errors } : {}),
				};
			}
			errors.push(`${candidate.source}: empty summary`);
		} catch (error) {
			errors.push(`${candidate.source}: ${errorMessage(error)}`);
		}
	}

	bumpCompactionEpoch();
	const fallbackHistory = reconstructTaskHistory(input.preparation.messagesToSummarize, {
		budget: FALLBACK_TRANSCRIPT_BUDGET,
		perMessage: FALLBACK_EXCERPT_CHARS,
		applied: input.mode === "enforce",
	});
	const fallback = applyCompactionIntegrity(
		fallbackCompactionSummary({
			...input.grounding,
			preparation: input.preparation,
			errors,
			...(fallbackHistory.audit.applied ? { taskHistory: fallbackHistory } : {}),
		}),
		input.preparation.messagesToSummarize,
		input.mode,
	);
	return {
		summary: fallback.summary,
		source: "structured-fallback",
		reconstruction: fallbackHistory.audit,
		integrity: fallback.audit,
		...(errors.length ? { errors } : {}),
	};
}

/** Adapt the session's current model into the ModelLike shape Her uses for summaries. */
export function sessionSummaryModel(ctx: ExtensionContext, signal?: AbortSignal): ModelLike | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	return {
		async complete(prompt: string): Promise<string> {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(`session model auth unavailable: ${auth.error}`);
			const response = await completeSimple(
				model,
				{
					systemPrompt: COMPACTION_SYSTEM_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				},
				{
					maxTokens: model.maxTokens > 0 ? Math.min(SUMMARY_MAX_TOKENS, model.maxTokens) : SUMMARY_MAX_TOKENS,
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal,
				},
			);
			if (response.stopReason === "error") {
				throw new Error(`session model failed: ${response.errorMessage || "unknown error"}`);
			}
			const text = contentText(response.content).trim();
			if (!text) throw new Error("session model returned empty content");
			return text;
		},
	};
}

export function renderCompactionPrompt(
	input: HerGrounding & { preparation: CompactionPreparationLike; taskHistory?: TaskHistoryReconstruction },
): string {
	return [
		"Create a compact continuation summary for Samantha. Preserve machine-truth grounding and do not invent facts.",
		ANTI_NESTING_CLAUSE,
		"",
		"## Her pinned context to preserve",
		`### FACTS.md\n${input.facts.trim() || "(empty)"}`,
		`### SOUL.md\n${input.soul.trim() || "(empty)"}`,
		`### CONTEXT.md\n${input.context.trim() || "(empty)"}`,
		`### SAMANTHA.md\n${input.self.trim() || "(empty)"}`,
		`### CHOICE-MODEL.md\n${input.choiceModel.trim() || "(empty)"}`,
		"",
		input.preparation.previousSummary
			? `## Previous compaction summary\n${input.preparation.previousSummary.trim()}`
			: "## Previous compaction summary\n(none)",
		"",
		"## Messages to summarize",
		input.taskHistory?.text ??
			describeMessages(input.preparation.messagesToSummarize, {
				budget: COMPACTION_TRANSCRIPT_BUDGET,
				perMessage: PROMPT_EXCERPT_CHARS,
			}),
		"",
		"## Turn prefix messages",
		describeMessages(input.preparation.turnPrefixMessages, {
			budget: COMPACTION_PREFIX_BUDGET,
			perMessage: PROMPT_EXCERPT_CHARS,
		}),
		"",
		"Return a concise Markdown summary with: durable facts, current task state, decisions, open questions, and next steps.",
	].join("\n");
}

export function fallbackCompactionSummary(
	input: HerGrounding & {
		preparation: CompactionPreparationLike;
		errors?: string[];
		taskHistory?: TaskHistoryReconstruction;
	},
): string {
	const prefix = input.preparation.turnPrefixMessages ?? [];
	return [
		"# Her Compaction Summary",
		"",
		DEGRADED_NOTICE,
		"",
		"## Preserved Her Grounding",
		`### FACTS.md\n${input.facts.trim() || "(empty)"}`,
		`### SOUL.md\n${input.soul.trim() || "(empty)"}`,
		`### CONTEXT.md\n${input.context.trim().slice(0, 4000) || "(empty)"}`,
		`### SAMANTHA.md\n${input.self.trim() || "(empty)"}`,
		`### CHOICE-MODEL.md\n${input.choiceModel.trim() || "(empty)"}`,
		"",
		input.preparation.previousSummary
			? `## Previous Summary\n${input.preparation.previousSummary.trim()}`
			: "## Previous Summary\n(none)",
		"",
		"## Conversation Outline (structured degradation)",
		input.taskHistory?.text ??
			describeMessages(input.preparation.messagesToSummarize, {
				budget: FALLBACK_TRANSCRIPT_BUDGET,
				perMessage: FALLBACK_EXCERPT_CHARS,
			}),
		prefix.length
			? `\n## Split-Turn Prefix\n${describeMessages(prefix, { budget: FALLBACK_PREFIX_BUDGET, perMessage: FALLBACK_EXCERPT_CHARS })}`
			: "",
		input.errors?.length ? `\n## Compaction Note\nModel compaction was unavailable: ${input.errors.join("; ")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

export function reconstructTaskHistory(
	messages: unknown[] | undefined,
	options: { budget: number; perMessage: number; applied?: boolean },
): TaskHistoryReconstruction {
	const list = messages ?? [];
	const taskText = latestUserText(list);
	const taskTerms = terms(taskText);
	const scored = list.map((message, index) =>
		scoreHistoryMessage(message, index, list.length, taskTerms, options.perMessage),
	);
	const ranked = [...scored].sort((a, b) => b.score - a.score || b.index - a.index);
	const selected: typeof scored = [];
	let used = 0;
	for (const candidate of ranked) {
		if (selected.length > 0 && used + candidate.line.length + 1 > options.budget) continue;
		selected.push(candidate);
		used += candidate.line.length + 1;
	}
	selected.sort((a, b) => a.index - b.index);
	const omitted = Math.max(0, list.length - selected.length);
	const text =
		list.length === 0
			? "(none)"
			: [
					omitted > 0 ? `(${omitted} lower-weight message(s) omitted by task-history rebuild)` : "",
					...selected.map((row) => row.line),
				]
					.filter(Boolean)
					.join("\n");
	return {
		text,
		audit: {
			version: "task-history-v1",
			applied: options.applied === true,
			taskDigest: createHash("sha256").update(taskText, "utf8").digest("hex").slice(0, 16),
			selected: selected.map(({ index, score, reasons }) => ({ index, score, reasons })),
			omitted,
		},
	};
}

function scoreHistoryMessage(
	message: unknown,
	index: number,
	count: number,
	taskTerms: Set<string>,
	perMessage: number,
): { index: number; line: string; score: number; reasons: string[] } {
	const record = asRecord(message);
	const role = typeof record?.role === "string" ? record.role : "unknown";
	const searchable = [
		collectText(record?.content),
		typeof record?.toolName === "string" ? record.toolName : "",
		...toolCallNames(record?.content),
	].join(" ");
	const overlap = [...terms(searchable)].filter((term) => taskTerms.has(term)).length;
	const distance = count - 1 - index;
	const reasons: string[] = [];
	let score = overlap * 100;
	if (overlap > 0) reasons.push("task-overlap");
	if (role === "user") {
		score += 20;
		reasons.push("user-anchor");
	}
	if (distance < 8) {
		score += 16 - distance * 2;
		reasons.push("recent");
	}
	if (role === "toolResult" || toolCallNames(record?.content).length > 0) {
		score += 5;
		reasons.push("tool-receipt");
	}
	if (index === count - 1) {
		score += 25;
		reasons.push("latest");
	}
	return { index, line: describeMessage(message, index, perMessage), score, reasons };
}

function latestUserText(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const record = asRecord(messages[index]);
		if (record?.role === "user") return collectText(record.content);
	}
	return "";
}

function terms(text: string): Set<string> {
	const normalized = text.toLocaleLowerCase();
	const out = new Set(normalized.match(/[a-z0-9_][a-z0-9_-]+/g) ?? []);
	for (const sequence of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
		if (sequence.length === 1) out.add(sequence);
		for (let index = 0; index < sequence.length - 1; index++) out.add(sequence.slice(index, index + 2));
	}
	return out;
}

/**
 * Render messages as structured excerpts (index, role, tool names, leading text) newest
 * first into the budget; anything older that no longer fits is dropped and reported as a
 * per-role count so the summarizer still sees the shape of what was cut.
 */
export function describeMessages(
	messages: unknown[] | undefined,
	options: { budget: number; perMessage: number },
): string {
	const list = messages ?? [];
	if (list.length === 0) return "(none)";

	const lines: string[] = [];
	let used = 0;
	let firstKept = 0;
	for (let index = list.length - 1; index >= 0; index--) {
		const line = describeMessage(list[index], index, options.perMessage);
		if (lines.length > 0 && used + line.length > options.budget) {
			firstKept = index + 1;
			break;
		}
		lines.push(line);
		used += line.length + 1;
	}
	lines.reverse();

	const omitted = list.slice(0, firstKept);
	if (omitted.length === 0) return lines.join("\n");
	return [`(${omitted.length} older message(s) omitted: ${roleCounts(omitted)})`, ...lines].join("\n");
}

function describeMessage(message: unknown, index: number, perMessage: number): string {
	const record = asRecord(message);
	const role = typeof record?.role === "string" ? record.role : "unknown";
	const parts = [`#${index + 1} ${role}`];
	const toolName = typeof record?.toolName === "string" ? record.toolName : undefined;
	if (toolName) parts.push(`tool: ${toolName}`);
	const calls = toolCallNames(record?.content);
	if (calls.length > 0) parts.push(`calls: ${calls.join(", ")}`);
	const text = excerpt(record?.content, perMessage);
	if (text) parts.push(text);
	return parts.join(" | ");
}

function toolCallNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const block of content) {
		const record = asRecord(block);
		if (record?.type === "toolCall" && typeof record.name === "string") names.push(record.name);
	}
	return names;
}

function excerpt(content: unknown, limit: number): string {
	const text = collectText(content).replace(/\s+/g, " ").trim();
	if (!text) return "";
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function collectText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const chunks: string[] = [];
	for (const block of content) {
		const record = asRecord(block);
		if (!record) continue;
		if (record.type === "text" && typeof record.text === "string") chunks.push(record.text);
		else if (record.type === "thinking" && typeof record.thinking === "string") chunks.push(record.thinking);
		else if (record.type === "image") chunks.push("[image]");
	}
	return chunks.join(" ");
}

function roleCounts(messages: unknown[]): string {
	const counts = new Map<string, number>();
	for (const message of messages) {
		const record = asRecord(message);
		const role = typeof record?.role === "string" ? record.role : "unknown";
		counts.set(role, (counts.get(role) ?? 0) + 1);
	}
	return [...counts.entries()].map(([role, count]) => `${count} ${role}`).join(", ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
