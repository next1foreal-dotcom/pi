import { contentText } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelLike } from "./her-core/index.ts";

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

/**
 * Character budgets for the transcript excerpts we hand to a summarization model.
 * Sized for the smallest model Her may fall back to (DeepSeek, 64k tokens): the
 * excerpts stay under ~56k characters, so even a 1 token/character worst case
 * (CJK) leaves room for the pinned narrative, the instructions, and the answer.
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

/** Summarize with the session's own model, the env-configured model, or a structured fallback. */
export async function summarizeForCompaction(input: {
	grounding: HerGrounding;
	preparation: CompactionPreparationLike;
	ctx?: ExtensionContext;
	envModel?: ModelLike;
	signal?: AbortSignal;
}): Promise<{ summary: string; source: string; errors?: string[] }> {
	const prompt = renderCompactionPrompt({ ...input.grounding, preparation: input.preparation });
	const candidates: Array<{ source: string; model: ModelLike }> = [];
	const sessionModel = input.ctx ? sessionSummaryModel(input.ctx, input.signal) : undefined;
	if (sessionModel) candidates.push({ source: "session-model", model: sessionModel });
	if (input.envModel) candidates.push({ source: "summary-model", model: input.envModel });

	const errors: string[] = [];
	for (const candidate of candidates) {
		try {
			const summary = await candidate.model.complete(prompt);
			if (summary.trim()) return { summary, source: candidate.source, ...(errors.length ? { errors } : {}) };
			errors.push(`${candidate.source}: empty summary`);
		} catch (error) {
			errors.push(`${candidate.source}: ${errorMessage(error)}`);
		}
	}

	return {
		summary: fallbackCompactionSummary({
			...input.grounding,
			preparation: input.preparation,
			errors,
		}),
		source: "structured-fallback",
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

export function renderCompactionPrompt(input: HerGrounding & { preparation: CompactionPreparationLike }): string {
	return [
		"Create a compact continuation summary for Samantha. Preserve machine-truth grounding and do not invent facts.",
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
	input: HerGrounding & { preparation: CompactionPreparationLike; errors?: string[] },
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
