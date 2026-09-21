import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactAuditPath } from "./audit.ts";

/** Narrative files assembled into the her-context system-prompt block. */
export const CONTEXT_INJECTION_SOURCES = [
	"narrative/CONTEXT.md",
	"narrative/FACTS.md",
	"narrative/SOUL.md",
	"narrative/SAMANTHA.md",
	"narrative/CHOICE-MODEL.md",
] as const;

export type InjectionKind = "context" | "recall" | "mirror" | "world" | (string & {});
export type TurnContextMode = "shadow" | "enforce";

export interface InjectionBlock {
	kind: InjectionKind;
	sources?: string[];
	digest: string;
	bytes: number;
	emittedDigest: string;
	emittedBytes: number;
	emission: "full" | "unchanged-marker" | "truncated" | "omitted";
}

export interface ContextManifestCandidate {
	layer: string;
	source: string;
	digest: string;
	availableTokens: number;
	selectedTokens: number;
	privacy: string;
	decision: "full" | "truncated" | "omitted";
	reason: "within-budget" | "layer-budget" | "total-budget";
}

export interface TurnContextDecision {
	kind: InjectionKind;
	source: string;
	digest: string;
	availableTokens: number;
	selectedTokens: number;
	decision: "full" | "truncated" | "omitted";
	reason: "within-budget" | "ephemeral-first" | "narrative-tail" | "unchanged-marker";
}

export interface TurnContextBudget {
	limitTokens: number;
	availableTokens: number;
	selectedTokens: number;
	omittedBlocks: number;
}

export interface ContextManifest {
	version: "context-manifest-v1";
	mode: TurnContextMode;
	promptChanged: boolean;
	taskDigest: string;
	priorId: string;
	budget: TurnContextBudget;
	actual: InjectionBlock[];
	turn: TurnContextDecision[];
	proposed: ContextManifestCandidate[];
}

export interface InjectionRecord {
	ts: string;
	session?: string;
	blocks: InjectionBlock[];
	manifest?: ContextManifest;
}

export interface InjectionBlockInput {
	kind: InjectionKind;
	content: string;
	emittedContent?: string;
	sources?: string[];
}

export interface TurnNarrativeSection {
	source: string;
	content: string;
}

export interface TurnContextSelection {
	text: string;
	blocks: InjectionBlockInput[];
	proposedBlocks: InjectionBlockInput[];
	decisions: TurnContextDecision[];
	budget: TurnContextBudget;
	promptChanged: boolean;
}

/** sessionId -> kind -> last original content digest */
const previousDigests = new Map<string, Map<string, string>>();

export function contentDigest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function estimateInjectionTokens(text: string): number {
	const trimmed = text.trim();
	// ponytail: chars/4 is the existing prior estimate; use a tokenizer only if measured drift warrants it.
	return trimmed ? Math.ceil(trimmed.length / 4) : 0;
}

export function isInjectDedupeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HER_INJECT_DEDUPE === "1";
}

export function unchangedInjectionMarker(kind: string, digest: string): string {
	return `[her-context unchanged: ${kind} digest ${digest}]`;
}

/**
 * Pure per-block dedupe. First injection of a session+kind (no previous digest)
 * always passes through. Repeat of the same digest becomes a one-line marker.
 * Flag off is a no-op.
 */
export function applyBlockDedupe(input: {
	enabled: boolean;
	kind: string;
	content: string;
	digest: string;
	previousDigest: string | undefined;
}): { text: string; unchanged: boolean } {
	if (!input.enabled || input.previousDigest === undefined) {
		return { text: input.content, unchanged: false };
	}
	if (input.previousDigest === input.digest) {
		return { text: unchangedInjectionMarker(input.kind, input.digest), unchanged: true };
	}
	return { text: input.content, unchanged: false };
}

export function resetInjectionDedupeState(): void {
	previousDigests.clear();
}

export function injectionLedgerPath(memoryDir: string): string {
	return join(memoryDir, "audit", "context-injections.jsonl");
}

function ledgerErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toBlock(input: InjectionBlockInput): InjectionBlock {
	const sources = input.sources?.map(redactAuditPath).filter(Boolean);
	const emittedContent = input.emittedContent ?? input.content;
	const emission =
		emittedContent === input.content
			? "full"
			: emittedContent === ""
				? "omitted"
				: emittedContent === unchangedInjectionMarker(input.kind, contentDigest(input.content))
					? "unchanged-marker"
					: "truncated";
	const block: InjectionBlock = {
		kind: input.kind,
		digest: contentDigest(input.content),
		bytes: Buffer.byteLength(input.content, "utf8"),
		emittedDigest: contentDigest(emittedContent),
		emittedBytes: Buffer.byteLength(emittedContent, "utf8"),
		emission,
	};
	if (sources && sources.length > 0) block.sources = sources;
	return block;
}

/** Append one JSONL line to the store's audit/context-injections.jsonl. Throws on I/O errors. */
export function appendInjectionRecord(opts: {
	memoryDir: string;
	session?: string;
	blocks?: InjectionBlockInput[];
	manifest?: ContextManifest;
	ts?: string;
}): InjectionRecord {
	const ts = opts.ts ?? new Date().toISOString();
	const record: InjectionRecord = {
		ts,
		blocks: (opts.blocks ?? []).map(toBlock),
	};
	if (opts.session) record.session = opts.session;
	if (opts.manifest) record.manifest = opts.manifest;
	const path = injectionLedgerPath(opts.memoryDir);
	mkdirSync(join(opts.memoryDir, "audit"), { recursive: true });
	appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
	return record;
}

export function selectTurnContext(opts: {
	mode: TurnContextMode;
	budgetTokens: number;
	blocks: InjectionBlockInput[];
	narrativeSections?: TurnNarrativeSection[];
}): TurnContextSelection {
	const limitTokens = Math.max(1, Math.floor(opts.budgetTokens));
	const available = opts.blocks.map((block) => ({ ...block, emittedContent: block.emittedContent ?? block.content }));
	const proposed = available.map((block) => ({ ...block }));

	for (const kind of ["inbox", "wake"] as const) {
		if (estimateInjectionTokens(renderTurnBlocks(proposed)) <= limitTokens) break;
		for (const block of proposed) {
			if (block.kind === kind) block.emittedContent = "";
		}
	}

	if (estimateInjectionTokens(renderTurnBlocks(proposed)) > limitTokens) {
		const context = proposed.find((block) => block.kind === "context");
		if (context) context.emittedContent = longestContextPrefix(proposed, context, limitTokens);
	}

	const proposedText = renderTurnBlocks(proposed);
	const availableText = renderTurnBlocks(available);
	const emitted = opts.mode === "enforce" ? proposed : available;
	const decisions = buildTurnDecisions(available, proposed, opts.narrativeSections ?? []);
	const budget = {
		limitTokens,
		availableTokens: estimateInjectionTokens(availableText),
		selectedTokens: estimateInjectionTokens(proposedText),
		omittedBlocks: decisions.filter((decision) => decision.decision === "omitted").length,
	};
	return {
		text: renderTurnBlocks(emitted),
		blocks: emitted,
		proposedBlocks: proposed,
		decisions,
		budget,
		promptChanged: opts.mode === "enforce" && proposedText !== availableText,
	};
}

function longestContextPrefix(
	blocks: InjectionBlockInput[],
	context: InjectionBlockInput,
	limitTokens: number,
): string {
	const original = context.emittedContent ?? context.content;
	let low = 0;
	let high = original.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		context.emittedContent = original.slice(0, mid).trimEnd();
		if (estimateInjectionTokens(renderTurnBlocks(blocks)) <= limitTokens) low = mid;
		else high = mid - 1;
	}
	return original.slice(0, low).trimEnd();
}

function buildTurnDecisions(
	available: InjectionBlockInput[],
	proposed: InjectionBlockInput[],
	narrativeSections: TurnNarrativeSection[],
): TurnContextDecision[] {
	const decisions: TurnContextDecision[] = [];
	const availableContext = available.find((block) => block.kind === "context");
	const proposedContext = proposed.find((block) => block.kind === "context");
	if (availableContext && proposedContext && narrativeSections.length > 0) {
		const original = availableContext.content;
		const beforeBudget = availableContext.emittedContent ?? original;
		const afterBudget = proposedContext.emittedContent ?? original;
		let offset = 0;
		for (const section of narrativeSections) {
			const selectedChars =
				beforeBudget === original ? Math.max(0, Math.min(section.content.length, afterBudget.length - offset)) : 0;
			const selectedText = section.content.slice(0, selectedChars);
			const availableTokens = estimateInjectionTokens(section.content);
			const selectedTokens = estimateInjectionTokens(selectedText);
			decisions.push({
				kind: "context",
				source: redactAuditPath(section.source),
				digest: contentDigest(section.content),
				availableTokens,
				selectedTokens,
				decision: selectedTokens === availableTokens ? "full" : selectedTokens === 0 ? "omitted" : "truncated",
				reason:
					beforeBudget !== original
						? "unchanged-marker"
						: selectedTokens === availableTokens
							? "within-budget"
							: "narrative-tail",
			});
			offset += section.content.length + 2;
		}
	}

	for (const block of available) {
		if (block.kind === "context" && narrativeSections.length > 0) continue;
		const chosen = proposed.find((candidate) => candidate.kind === block.kind);
		const beforeBudget = block.emittedContent ?? block.content;
		const afterBudget = chosen?.emittedContent ?? "";
		const availableTokens = estimateInjectionTokens(beforeBudget);
		const selectedTokens = estimateInjectionTokens(afterBudget);
		decisions.push({
			kind: block.kind,
			source: redactAuditPath(block.sources?.[0] ?? block.kind),
			digest: contentDigest(block.content),
			availableTokens,
			selectedTokens,
			decision: selectedTokens === availableTokens ? "full" : selectedTokens === 0 ? "omitted" : "truncated",
			reason:
				beforeBudget !== block.content
					? "unchanged-marker"
					: selectedTokens === availableTokens
						? "within-budget"
						: block.kind === "wake" || block.kind === "inbox"
							? "ephemeral-first"
							: "narrative-tail",
		});
	}
	return decisions;
}

function renderTurnBlocks(blocks: InjectionBlockInput[]): string {
	return blocks
		.map((block) => block.emittedContent ?? block.content)
		.filter(Boolean)
		.join("\n\n");
}

export function buildContextManifest(opts: {
	task: string;
	priorId: string;
	mode: TurnContextMode;
	promptChanged: boolean;
	budget: TurnContextBudget;
	actual: InjectionBlockInput[];
	turn: TurnContextDecision[];
	proposed: ContextManifestCandidate[];
}): ContextManifest {
	return {
		version: "context-manifest-v1",
		mode: opts.mode,
		promptChanged: opts.promptChanged,
		taskDigest: contentDigest(opts.task),
		priorId: opts.priorId,
		budget: opts.budget,
		actual: opts.actual.map(toBlock),
		turn: opts.turn,
		proposed: opts.proposed.map((candidate) => ({ ...candidate, source: redactAuditPath(candidate.source) })),
	};
}

export function appendContextManifestRecord(opts: {
	memoryDir: string;
	session?: string;
	blocks?: InjectionBlockInput[];
	manifest: ContextManifest;
	ts?: string;
}): InjectionRecord {
	return appendInjectionRecord(opts);
}

/**
 * Dedupe (optional) then log. Ledger failures warn and never throw; a broken
 * ledger must not silence her-context injection.
 */
export function injectLoggedContent(opts: {
	memoryDir: string;
	session?: string;
	kind: InjectionKind;
	content: string;
	sources?: string[];
	extraBlocks?: InjectionBlockInput[];
	dedupe?: boolean;
	log?: boolean;
}): string {
	const digest = contentDigest(opts.content);
	let text = opts.content;
	try {
		if (opts.dedupe !== false && isInjectDedupeEnabled() && opts.session) {
			const byKind = previousDigests.get(opts.session) ?? new Map<string, string>();
			const previousDigest = byKind.get(opts.kind);
			text = applyBlockDedupe({
				enabled: true,
				kind: opts.kind,
				content: opts.content,
				digest,
				previousDigest,
			}).text;
			byKind.set(opts.kind, digest);
			previousDigests.set(opts.session, byKind);
		}
	} catch (error) {
		console.warn(`[her] injection dedupe skipped: ${ledgerErrorMessage(error)}`);
		text = opts.content;
	}

	if (opts.log !== false) {
		try {
			appendInjectionRecord({
				memoryDir: opts.memoryDir,
				session: opts.session,
				blocks: [
					{ kind: opts.kind, content: opts.content, emittedContent: text, sources: opts.sources },
					...(opts.extraBlocks ?? []),
				],
			});
		} catch (error) {
			console.warn(`[her] injection ledger append failed: ${ledgerErrorMessage(error)}`);
		}
	}

	return text;
}
