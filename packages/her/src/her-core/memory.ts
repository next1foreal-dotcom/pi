import { createHash } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type HerConfig, loadConfig } from "./config.ts";
import { type BackfillOptions, type BackfillRunResult, runBackfill } from "./memory-backfill.ts";
import { buildArchiveCorpus, buildCorpus, recordAccess, staleBanner } from "./memory-corpus.ts";
import {
	advanceConsolidateCursor,
	type ParsedConsolidateCursor,
	parseConsolidateCursor,
	rawEpisodeIdFromName,
	rawEpisodeTimestamp,
	shouldReadRawEpisodeName,
	shouldUseRawEpisode,
} from "./memory-cursor.ts";
import { decaySweep, restoreArchivedSemantic, syncMemory, syncStatus } from "./memory-maintenance.ts";
import { writeSamanthaJournal, writeSamanthaTasteJudgment, writeSamanthaZoneNote } from "./memory-samantha.ts";
import { SEED_CHOICE_MODEL, SEED_CONTEXT, SEED_SELF_NARRATIVE, SEED_SOUL } from "./memory-seeds.ts";
import type {
	CaptureMeta,
	ChoiceModelSynthesizeDueResult,
	ChoiceModelUpdateResult,
	ChoiceRuleRecord,
	ConsolidateResult,
	ContextUpdateInput,
	ContextUpdateRecord,
	DecaySweepOptions,
	DecaySweepResult,
	FeedbackFields,
	FeedbackResult,
	IdeaData,
	JudgmentFields,
	MemoryOptions,
	MemorySyncResult,
	MemorySyncStatus,
	ReflectOptions,
	ReflectResult,
	RestoreArchivedSemanticOptions,
	RestoreArchivedSemanticResult,
	SamanthaJournalInput,
	SamanthaJournalResult,
	SamanthaTasteJudgmentInput,
	SamanthaTasteJudgmentResult,
	SamanthaZoneNoteInput,
	SamanthaZoneNoteResult,
	SelfNarrativeUpdateResult,
	SurfaceOptions,
	SynthesizeDueResult,
	WorldNoteData,
} from "./memory-types.ts";
import {
	assertNarrativeComplete,
	CHOICE_MODEL_SYNTHESIZE_AFTER_DAYS,
	CHOICE_RULES_MARKER,
	changedAfter,
	choiceModelLogBlock,
	choiceRuleRuntimeStatus,
	completeJson,
	contextLogBlock,
	daysSince,
	episodeSection,
	errorMessage,
	escapeRegExp,
	extractSection,
	genId,
	git,
	hasConflictRelation,
	isFileExists,
	JsonMalformedError,
	JsonTruncatedError,
	markdownEntries,
	markdownStems,
	normalizeActiveTier,
	normalizeChoiceRule,
	normalizeRelations,
	parseChoiceRuleRecords,
	parseContextLog,
	parseDate,
	readChoiceModelRuleFiles,
	readMarkdownDir,
	renderChoiceRuleFile,
	renderTasteRuleSummary,
	safeStem,
	sameStrings,
	selfNarrativeLogBlock,
	slug,
	sortChoiceRules,
	sourceRef,
	stripSection,
	timelineEntry,
	timestampMinute,
	today,
	UNIT_TYPES,
	validateChoiceModelDomain,
	validateFeedbackWeight,
} from "./memory-utils.ts";
import {
	applyTasteBoard,
	recordJudgment,
	setMemoryStatus,
	type TasteBoardApplyResult,
	writeWorldNote,
} from "./memory-world.ts";
import type { ModelLike } from "./model.ts";
import { StorePaths } from "./paths.ts";
import type { PriorMode, PriorResult } from "./prior.ts";
import { classifyCapturePrivacy, validateMemoryProvenance } from "./privacy.ts";
import {
	choiceModelPrompt,
	consolidatePrompt,
	ideaEnginePrompt,
	mergeNotePrompt,
	selfNarrativePrompt,
	summaryPrompt,
	surfacePrompt,
	synthesizePrompt,
	topicMapPrompt,
} from "./prompts.ts";
import { lexicalSearch, type Note, rrfSearch, type SearchBackend } from "./retrieval.ts";
import {
	appendText,
	frontmatter,
	parseFrontmatter,
	readJson,
	readText,
	redactSecrets,
	writeJson,
	writeNewText,
	writeText,
} from "./store.ts";
import { storeLock } from "./store-lock.ts";
import { appendTriggerEvent } from "./trigger-log.ts";

const DEFAULT_CONSOLIDATE_EPISODE_CHARS = 8000;
const DEFAULT_CONSOLIDATE_BATCH_CHARS = 240000;
const DEFAULT_CONSOLIDATE_KEY_BUDGET = 120;
const DEFAULT_CONSOLIDATE_KEY_RECENT = 30;
const DEFAULT_CONSOLIDATE_CIPHER_MIN_CHARS = 300;
// Distinct characters a long run must use before it counts as cipher rather than filler or a rule.
// Base64 of 300+ chars essentially always clears 16; "-".repeat(300) and "A".repeat(20000) never do.
const DEFAULT_CONSOLIDATE_CIPHER_MIN_VARIETY = 16;
// G-235 fat-episode chunking. When a SINGLE episode's distilled output still truncates at batch
// size 1, we split its content and distill the pieces that fit instead of dropping the whole turn.
// - FLOOR: a chunk at/below this size that STILL truncates is quarantined (its dense content can't
//   be compiled into a reply that fits the model's output ceiling) — never split below this.
// - MAX_ATTEMPTS: per-episode ceiling on model calls the chunker may spend. A dense multi-MB episode
//   would otherwise fan out into hundreds of calls (real money, in an unattended nightly job); once
//   the budget is spent the remaining un-distilled content is quarantined (preserved, not dropped)
//   and the cursor advances. Generous by default (the real dam episodes are 4-16KB); env-tunable.
// The attempt CEIL reuses DEFAULT_CONSOLIDATE_EPISODE_CHARS: a chunk larger than that is split
// without spending a call, because a <=CEIL slice of THIS episode already truncated (that is why we
// are here), so a larger slice cannot fit — and sending multi-MB inputs to the model is itself costly.
const DEFAULT_CONSOLIDATE_CHUNK_FLOOR_CHARS = 2000;
const DEFAULT_CONSOLIDATE_CHUNK_MAX_ATTEMPTS_FINE = 64;
const DEFAULT_CONSOLIDATE_CHUNK_MAX_ATTEMPTS_COARSE = 8;
const DEFAULT_CONSOLIDATE_COARSE_SAMPLE_SLICES = 6;
// Checked against the store's real `project:` values (last 600 episodes, 2026-08-12): the paths that
// matter carry Her-repo / samantha / @Her, and Her's own worktrees are named wt-<card>. Deliberately
// NOT fine: `her-heartbeat` and `tasks` — heartbeats are log-like (deep digestion of them is what
// produced the heartbeat-runs-regularly-<date> junk notes) and `tasks` is Codex worker transcripts,
// mostly boilerplate, and the source of most byte-identical duplicates.
const DEFAULT_CONSOLIDATE_FINE_PROJECTS = ["Her-repo", "@Her", "samantha", "her-memory", "wt-"];
const DEFAULT_TOPICS_BATCH_UNITS = 250;
const DEFAULT_TOPICS_MIN_BATCH_UNITS = 25;
const DEFAULT_IDEAS_MAX_UNITS = 400;
const DEFAULT_IDEAS_MIN_UNITS = 50;

type NoteSummary = { key: string; kind: string; type: string; title: string };
type OrganKind = "ideas" | "topic-maps";
type ConsolidateEpisode = { ts: string; id: string; cursorId: string; text: string; body: string; project: string };
type IndexedConsolidateEpisode = ConsolidateEpisode & {
	sourceIndex: number;
	duplicateOf?: { id: string; ts: string };
};
type OrganSkipEntry = {
	ts: string;
	organ: OrganKind;
	reason: "truncated-at-floor" | "premise-moved";
	units: number;
	attempts: number;
};

export function selectRelevantKeys(
	episodeText: string,
	stems: string[],
	opts?: { max?: number; recent?: string[] },
): string[] {
	const recent = [...new Set(opts?.recent ?? [])];
	if (!episodeText.trim() || stems.length === 0) return recent;

	const words = new Set(
		episodeText
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => word.length >= 4),
	);
	if (words.size === 0) return recent;

	const max = opts?.max ?? envPositiveInt("HER_CONSOLIDATE_KEY_BUDGET", DEFAULT_CONSOLIDATE_KEY_BUDGET);
	const budget = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
	const scored = [...new Set(stems)]
		.map((stem) => {
			const parts = [
				...new Set(
					stem
						.toLowerCase()
						.split("-")
						.filter((part) => part.length >= 4 && !/^\d+$/.test(part)),
				),
			];
			const score = parts.filter((part) => words.has(part)).length;
			return { stem, score };
		})
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0));

	const result: string[] = [];
	const selected = new Set<string>();
	for (const item of scored.slice(0, budget)) {
		result.push(item.stem);
		selected.add(item.stem);
	}
	for (const stem of recent) {
		if (selected.has(stem)) continue;
		result.push(stem);
		selected.add(stem);
	}
	return result;
}

async function recentSemanticStems(dir: string, limit: number): Promise<string[]> {
	if (limit <= 0) return [];
	const entries = await markdownEntries(dir);
	const stamped = await Promise.all(
		entries.map(async (entry) => {
			try {
				return { stem: entry.replace(/\.md$/, ""), mtimeMs: (await stat(join(dir, entry))).mtimeMs };
			} catch {
				return undefined;
			}
		}),
	);
	return stamped
		.filter((item): item is { stem: string; mtimeMs: number } => item !== undefined)
		.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0))
		.slice(0, limit)
		.map((item) => item.stem);
}
export function isJunkNote(note: { key?: unknown; title?: unknown; content?: unknown }): false | string {
	const key = typeof note.key === "string" ? note.key : "";
	if (/(^|-)(no|not)-extractable/i.test(key) || /no-knowledge/i.test(key) || /unextractable/i.test(key)) {
		return "self-reported-empty";
	}
	if (/(^|-)turn-?\d+/i.test(key) || /(^|-)build-\d{6,}/i.test(key)) return "transient-key";
	// Only genuinely empty content is junk. A length floor was specified originally and dropped real
	// notes: short facts ("Fei uses pnpm, never npm") are exactly the durable kind, and six existing
	// G-234/G-235 tests caught the over-reach. Quality judgement does not belong in a mechanical gate.
	const content = typeof note.content === "string" ? note.content.trim() : "";
	if (content.length === 0) return "empty-content";
	return false;
}
export function consolidateGrain(project: string): "fine" | "coarse" {
	if (!project) return "coarse";
	const configured = process.env.HER_CONSOLIDATE_FINE_PROJECTS;
	const patterns = configured?.trim()
		? configured
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean)
		: DEFAULT_CONSOLIDATE_FINE_PROJECTS;
	const lowerProject = project.toLowerCase();
	return patterns.some((pattern) => lowerProject.includes(pattern.toLowerCase())) ? "fine" : "coarse";
}
function envPositiveInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
	return Math.floor(value);
}

// reflect's cadence.reflect_every_days lives outside this task's write-set (config.ts owns HerConfig
// and is out of scope here), so it is read defensively off the already-loaded config object instead of
// a typed HerConfig.cadence field: config.ts's YAML parser is untyped at runtime (parseConfigYaml casts
// its generic per-section output to Partial<HerConfig>), so a `cadence: { reflect_every_days: N }` block
// in config.yaml still lands on `config.cadence` at runtime even though HerConfig's cadence type doesn't
// declare the field statically. Defaults to 1 (reflect daily) when absent or invalid.
function reflectCadenceDays(config: HerConfig): number {
	const raw = (config.cadence as { reflectEveryDays?: unknown }).reflectEveryDays;
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

function truncateEpisodeText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = `...[truncated, original ${text.length} chars]`;
	const keep = Math.max(0, maxChars - marker.length);
	return `${text.slice(0, keep)}${marker}`;
}

export function stripCipherBlobs(text: string): { text: string; strippedChars: number; blobs: number } {
	const configured = Number(process.env.HER_CONSOLIDATE_CIPHER_MIN_CHARS ?? DEFAULT_CONSOLIDATE_CIPHER_MIN_CHARS);
	const minChars =
		Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : DEFAULT_CONSOLIDATE_CIPHER_MIN_CHARS;
	let strippedChars = 0;
	let blobs = 0;
	const stripped = text.replace(/[A-Za-z0-9+/_=-]+/g, (match) => {
		if (match.length < minChars) return match;
		// Length alone is not enough: a 300-dash rule, a run of "====", or repeated filler all sit in
		// the base64 alphabet, and eight existing G-235/G-249 tests caught exactly that (their fixtures
		// are "A".repeat(20000)). Real base64 of this length is high-variety — an encoded payload uses
		// most of its alphabet — so require variety as well as length before calling something cipher.
		if (new Set(match).size < DEFAULT_CONSOLIDATE_CIPHER_MIN_VARIETY) return match;
		strippedChars += match.length;
		blobs++;
		return `[cipher ${match.length} chars]`;
	});
	return { text: stripped, strippedChars, blobs };
}

function selectConsolidateBatch<T extends { id: string; text: string }>(
	episodes: T[],
	limit: number,
): Array<{ episode: T; promptText: string }> {
	const episodeChars = envPositiveInt("HER_CONSOLIDATE_EPISODE_CHARS", DEFAULT_CONSOLIDATE_EPISODE_CHARS);
	const batchChars = envPositiveInt("HER_CONSOLIDATE_BATCH_CHARS", DEFAULT_CONSOLIDATE_BATCH_CHARS);
	const batch: Array<{ episode: T; promptText: string }> = [];
	let chars = 0;
	for (const episode of episodes) {
		if (batch.length >= limit) break;
		const promptText = `[${episode.id}] ${truncateEpisodeText(episode.text, episodeChars)}`;
		if (batch.length > 0 && chars + promptText.length > batchChars) break;
		batch.push({ episode, promptText });
		chars += promptText.length;
	}
	return batch;
}

// Split text into two strictly-smaller halves for G-235 recursive fat-episode chunking. Cuts at the
// first newline at/after the midpoint so whole lines stay together (the least-invasive cut for
// transcript text), falling back to the raw midpoint for a single oversized line. The cut is a plain
// slice, so `left + right === text` byte-for-byte — quarantined content is preserved exactly, never
// dropping the boundary newline. Every non-trivial input yields two non-empty parts each shorter than
// the input, which is what guarantees the chunking recursion terminates.
function splitTextInHalf(text: string): [string, string] {
	const mid = Math.floor(text.length / 2);
	const newline = text.indexOf("\n", mid);
	const cut = newline === -1 ? mid : newline + 1;
	if (cut <= 0 || cut >= text.length) {
		const half = Math.floor(text.length / 2);
		return [text.slice(0, half), text.slice(half)];
	}
	return [text.slice(0, cut), text.slice(cut)];
}

function cursorFingerprint(cursor: ParsedConsolidateCursor | null): string {
	if (!cursor) return "";
	return `${cursor.legacy ? "L" : "N"}:${cursor.ts}:${[...cursor.doneIds].sort().join(",")}`;
}

function textFingerprint(text: string | undefined): string {
	return createHash("sha256")
		.update(text ?? "", "utf8")
		.digest("hex");
}

type CoarseSample = { text: string; sampledChars: number; slices: number };

function alignSampleBoundary(text: string, position: number): number {
	if (position <= 0) return 0;
	if (position >= text.length) return text.length;
	const newline = text.indexOf("\n", position);
	return newline === -1 ? position : newline + 1;
}

function sampleCoarseEpisode(text: string, ceil: number, slices: number): CoarseSample {
	const count = Math.max(1, slices);
	if (count === 1) {
		const end = Math.min(text.length, ceil);
		return { text: text.slice(0, end), sampledChars: end, slices: 1 };
	}
	const maxStart = Math.max(0, text.length - ceil);
	const starts: number[] = [];
	let previous = 0;
	for (let index = 0; index < count; index++) {
		const target = index === 0 ? 0 : Math.round((maxStart * index) / (count - 1));
		let start = index === 0 ? 0 : alignSampleBoundary(text, target);
		if (start <= previous) start = target;
		if (index === count - 1) start = alignSampleBoundary(text, maxStart);
		start = Math.max(previous, Math.min(text.length, start));
		starts.push(start);
		previous = start;
	}
	const parts: string[] = [];
	let sampledChars = 0;
	for (let index = 0; index < starts.length; index++) {
		const start = starts[index] ?? 0;
		const rawEnd = index === starts.length - 1 ? text.length : start + ceil;
		const end = index === starts.length - 1 ? text.length : Math.min(text.length, alignSampleBoundary(text, rawEnd));
		const safeEnd = Math.max(start, end);
		const part = text.slice(start, safeEnd);
		parts.push(part);
		sampledChars += part.length;
		if (index < starts.length - 1) {
			const nextStart = starts[index + 1] ?? text.length;
			const skipped = Math.max(0, nextStart - safeEnd);
			parts.push(`\n\n[... \u7565\u8fc7 ${skipped} \u5b57\u7b26 ...]\n\n`);
		}
	}
	return { text: parts.join(""), sampledChars, slices: count };
}

export type {
	BackfillBatchResult,
	BackfillEpisode,
	BackfillOptions,
	BackfillRunResult,
} from "./memory-backfill.ts";
export { initStore } from "./memory-init.ts";
export { SEED_CHOICE_MODEL, SEED_CONTEXT, SEED_SELF_NARRATIVE, SEED_SOUL } from "./memory-seeds.ts";
export type {
	CaptureMeta,
	ChoiceModelDomain,
	ChoiceModelSynthesizeDueResult,
	ChoiceModelUpdateResult,
	ClaimLedgerEntry,
	ConsolidateResult,
	ContextUpdateInput,
	ContextUpdateRecord,
	DecaySweepOptions,
	DecaySweepResult,
	FeedbackFields,
	FeedbackResult,
	IdeaData,
	JudgmentFields,
	MemoryOptions,
	MemorySyncResult,
	MemorySyncStatus,
	ReflectOptions,
	ReflectResult,
	RestoreArchivedSemanticOptions,
	RestoreArchivedSemanticResult,
	SamanthaJournalInput,
	SamanthaJournalKind,
	SamanthaJournalResult,
	SamanthaTasteJudgmentInput,
	SamanthaTasteJudgmentResult,
	SamanthaZoneCategory,
	SamanthaZoneNoteInput,
	SamanthaZoneNoteResult,
	SelfNarrativeUpdateResult,
	SurfaceOptions,
	SynthesizeDueReason,
	SynthesizeDueResult,
	WorldNoteData,
} from "./memory-types.ts";

export interface GetContextPriorOptions {
	action?: string;
	budget?: number;
	env?: Pick<NodeJS.ProcessEnv, "HER_PRIOR">;
	mode?: PriorMode;
	sessionMode?: PriorMode;
	task?: string;
	writeTargets?: string[];
}

export interface GetContextOptions {
	prior?: GetContextPriorOptions;
}

export interface MemoryContext {
	choiceModel: string;
	context: string;
	facts: string;
	prior?: PriorResult;
	self: string;
	soul: string;
}

export class Memory {
	readonly paths: StorePaths;
	private readonly model?: ModelLike;
	private readonly config: HerConfig;
	private readonly semanticSearch?: SearchBackend;

	constructor(root: string, modelOrOptions?: ModelLike | MemoryOptions, config?: HerConfig) {
		this.paths = new StorePaths(root);
		if (isMemoryOptions(modelOrOptions)) {
			this.model = modelOrOptions.model;
			this.config = modelOrOptions.config ?? loadConfig(this.paths.configFile);
			this.semanticSearch = modelOrOptions.semanticSearch;
		} else {
			this.model = modelOrOptions;
			this.config = config ?? loadConfig(this.paths.configFile);
		}
	}

	private async withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
		return storeLock(this.paths.root, fn);
	}

	async capture(raw: string, meta: CaptureMeta = {}): Promise<string> {
		const ts = meta.timestamp ?? timestampMinute();
		const sid = meta.sessionId ?? meta.session_id ?? genId(ts, raw);
		const date = safeStem(ts.slice(0, 10));
		const project = meta.project ?? "unknown";
		const rawBaseStem = `${safeStem(ts)}--${safeStem(sid)}`;
		const safeRaw = redactSecrets(raw);
		const rawFm = {
			id: sid,
			timestamp: ts,
			project,
			session_id: sid,
			privacy: classifyCapturePrivacy(safeRaw, meta.privacy),
			provenance: meta.provenance ? validateMemoryProvenance(meta.provenance) : "her-observed",
			authored_by: meta.authored_by?.trim() || "unknown",
			harness: meta.harness?.trim() || meta.source?.trim() || "unknown",
			...(meta.source ? { source: meta.source } : {}),
			...(meta.source_ref?.trim() ? { source_ref: meta.source_ref.trim() } : {}),
			...(meta.type ? { type: meta.type } : {}),
			...(meta.capture_scope ? { capture_scope: meta.capture_scope } : {}),
			...(meta.transcription_quality ? { transcription_quality: meta.transcription_quality } : {}),
			...(meta.executor ? { executor: meta.executor } : {}),
			...(meta.handoff ? { handoff: meta.handoff } : {}),
			...(meta.dispatchId ? { dispatch_id: meta.dispatchId } : {}),
		};
		const rawStem = await this.writeRawEpisode(rawBaseStem, `${frontmatter(rawFm)}\n${safeRaw}`);

		let pending = false;
		let summary: string;
		try {
			if (!this.model) throw new Error("no model configured");
			summary = await this.model.complete(summaryPrompt(safeRaw));
		} catch {
			summary = "- (summary pending - summarizer unavailable)";
			pending = true;
		}

		await appendText(this.paths.dailyEpisode(date), episodeSection(sid, ts, project, summary, rawStem, pending));
		if (meta.type === "recognition_response" && meta.ref) {
			await this.markRecognitionAnswered(meta.ref, sid);
		}
		return sid;
	}

	private async writeRawEpisode(baseStem: string, text: string): Promise<string> {
		for (let duplicate = 0; duplicate < 1000; duplicate++) {
			const stem = duplicate === 0 ? baseStem : `${baseStem}--dup-${duplicate}`;
			const path = join(this.paths.raw, `${stem}.md`);
			let existing: string | undefined;
			try {
				existing = await readText(path);
			} catch {
				// A transient read failure must not change the append-only allocation path.
			}
			if (existing !== undefined && existing === text) {
				console.warn(`[her] capture: identical episode already stored as ${stem}; reusing (no duplicate written)`);
				return stem;
			}
			try {
				await writeNewText(path, text);
				return stem;
			} catch (error) {
				if (isFileExists(error)) continue;
				throw error;
			}
		}
		throw new Error(`could not allocate raw episode filename for ${baseStem}`);
	}
	async getContext(opts: GetContextOptions = {}): Promise<MemoryContext> {
		const context = (await readText(this.paths.contextFile)) ?? SEED_CONTEXT;
		const facts = (await readText(this.paths.factsFile)) ?? "";
		const soul = (await readText(this.paths.soulFile)) ?? SEED_SOUL;
		const self = (await readText(this.paths.selfFile)) ?? SEED_SELF_NARRATIVE;
		const choiceModel = await this.readChoiceModelContext();
		const base: MemoryContext = {
			context: `${await staleBanner(this.paths, this.config)}${context}`,
			facts,
			soul,
			self,
			choiceModel,
		};
		if (!opts.prior) return base;

		const { assemblePrior, priorModeForAction, recordPriorAudit } = await import("./prior.ts");
		const mode = priorModeForAction(opts.prior.writeTargets ?? [], {
			env: opts.prior.env,
			requestedMode: opts.prior.mode,
			sessionMode: opts.prior.sessionMode,
		});
		const prior = await assemblePrior({
			budget: opts.prior.budget,
			mode,
			storeRoot: this.paths.root,
			task: opts.prior.task,
		});
		await recordPriorAudit(this.paths.root, { action: opts.prior.action ?? "getContext", mode, prior });
		return { ...base, prior };
	}

	async recordFeedback(fields: FeedbackFields): Promise<FeedbackResult> {
		return this.withStoreLock(async () => {
			const domain = validateChoiceModelDomain(fields.domain);
			const rule = fields.rule.trim();
			const task = fields.task.trim();
			const diffSummary = fields.diffSummary.trim();
			const weight = validateFeedbackWeight(fields.weight);
			if (!rule) throw new Error("feedback rule is required");
			if (!task) throw new Error("feedback task is required");
			if (!diffSummary) throw new Error("feedback diffSummary is required");

			const at = fields.at ?? new Date().toISOString();
			await mkdir(this.paths.choiceModelDir, { recursive: true });
			const path = join(this.paths.choiceModelDir, `${domain}.md`);
			const raw = (await readText(path)) ?? "";
			const existing = parseChoiceRuleRecords(raw);
			// Never lose existing rules (G-170): a fresh/seeded domain file legitimately has no
			// her-choice-rules marker at all, so existing.length === 0 is normal there. But if the marker
			// IS present and still parses to zero records, parseChoiceRuleRecords swallowed a JSON error
			// (memory-utils.ts's catch-and-return-[] path) — proceeding would silently overwrite whatever
			// rules that marker used to hold with just the one new rule. Fail loud instead.
			if (existing.length === 0 && raw.includes(CHOICE_RULES_MARKER)) {
				throw new Error(
					`recordFeedback: ${path} has a her-choice-rules marker that failed to parse; refusing to write (would silently discard existing rules)`,
				);
			}
			const key = normalizeChoiceRule(rule);
			const found = existing.find((item) => normalizeChoiceRule(item.rule) === key);
			const evidence = { at, task, diff_summary: diffSummary };
			let record: ChoiceRuleRecord;
			if (found) {
				record = {
					...found,
					rule,
					weight: found.weight + weight,
					last_triggered: at,
					status: "active",
					evidence: [...found.evidence, evidence],
				};
				const index = existing.indexOf(found);
				existing[index] = record;
			} else {
				record = {
					id: genId(domain, rule),
					rule,
					weight,
					first_recorded: at,
					last_triggered: at,
					status: "active",
					evidence: [evidence],
				};
				existing.push(record);
			}
			const renderedRules = sortChoiceRules(existing, at).map((item) => ({
				...item,
				status: choiceRuleRuntimeStatus(item, at),
			}));
			await writeText(path, renderChoiceRuleFile(domain, renderedRules));
			// Commit immediately (G-170): an uncommitted feedback write can sit in the working tree for
			// weeks until a generic sync sweeps it up, leaving the exposure window where git-level
			// operations (checkout/autocrlf rewrite) can destroy it with no recoverable history.
			await git(this.paths.root, "add", "--", `choice-model/${domain}.md`);
			await git(this.paths.root, "commit", "-m", `memory(feedback): ${domain}`);
			const commit = (await git(this.paths.root, "rev-parse", "--short", "HEAD")).stdout.trim();
			return {
				domain,
				path,
				rule: record.rule,
				weight: record.weight,
				status: choiceRuleRuntimeStatus(record, at),
				commit,
			};
		});
	}

	private async readChoiceModelContext(): Promise<string> {
		const base = ((await readText(this.paths.choiceModelFile)) ?? SEED_CHOICE_MODEL).trim();
		const ruleFiles = await readChoiceModelRuleFiles(this.paths.choiceModelDir);
		if (ruleFiles.length === 0) return `${base}\n`;
		const tasteRules = renderTasteRuleSummary(ruleFiles);
		const rules = ruleFiles.map(({ name, text }) => `## choice-model/${name}\n\n${text.trim()}`).join("\n\n");
		return `${base}${tasteRules ? `\n\n${tasteRules}` : ""}\n\n# CHOICE-MODEL Directory Rules\n\n${rules}\n`;
	}

	async recall(query: string, opts: { k?: number; recordAccess?: boolean } = {}): Promise<Note[]> {
		const hits = await rrfSearch(query, await buildCorpus(this.paths), {
			k: opts.k ?? 8,
			semanticSearch: this.semanticSearch,
		});
		if (opts.recordAccess !== false) {
			await this.withStoreLock(() =>
				recordAccess(
					this.paths,
					hits.map((hit) => hit.id),
				),
			);
		}
		return hits;
	}

	async recallArchive(query: string, opts: { k?: number } = {}): Promise<Note[]> {
		return lexicalSearch(query, await buildArchiveCorpus(this.paths), opts.k ?? 5);
	}

	async surface(opts: SurfaceOptions = {}): Promise<Note | undefined> {
		return this.withStoreLock(async () => {
			const state = await readJson<{
				mirror?: {
					lastAtBySession?: Record<string, string>;
					surfacedBySession?: Record<string, string[]>;
				};
			}>(this.paths.stateFile, {});
			const sessionId = opts.sessionId ?? "global";
			const query = opts.query?.trim();
			const cooldownMs = (opts.cooldownMinutes ?? 30) * 60000;
			const lastAt = state.mirror?.lastAtBySession?.[sessionId];
			if (lastAt && cooldownMs > 0 && Date.now() - Date.parse(lastAt) < cooldownMs) {
				await appendTriggerEvent(this.paths, { sessionId, outcome: "cooldown", hasQuery: Boolean(query) }).catch(
					() => {},
				);
				return undefined;
			}

			const surfaced = new Set(state.mirror?.surfacedBySession?.[sessionId] ?? []);
			const corpus = await buildCorpus(this.paths);
			const ranked = query ? await rrfSearch(query, corpus, { k: 20, semanticSearch: this.semanticSearch }) : [];
			const candidates = ranked.length > 0 ? ranked : corpus.map((doc) => ({ ...doc, score: 0 }));
			const hit = candidates.find((note) => !surfaced.has(note.id));
			if (!hit) {
				await appendTriggerEvent(this.paths, { sessionId, outcome: "empty", hasQuery: Boolean(query) }).catch(
					() => {},
				);
				return undefined;
			}

			surfaced.add(hit.id);
			await writeJson(this.paths.stateFile, {
				...state,
				mirror: {
					...state.mirror,
					lastAtBySession: {
						...(state.mirror?.lastAtBySession ?? {}),
						[sessionId]: new Date().toISOString(),
					},
					surfacedBySession: {
						...(state.mirror?.surfacedBySession ?? {}),
						[sessionId]: [...surfaced].slice(-200),
					},
				},
			});
			await recordAccess(this.paths, [hit.id]);
			await appendTriggerEvent(this.paths, {
				sessionId,
				outcome: "surfaced",
				hasQuery: Boolean(query),
				...(isProtectedSurfaceId(hit.id) ? {} : { noteId: hit.id }),
			}).catch(() => {});
			return hit;
		});
	}

	// ---- reflect (the Mirror Effect, generation) ---------------------------
	// Generation counterpart of surface() (retrieval-only, above): reflects on the last 5 episodes plus
	// every existing recognition and may write ONE new pending recognition via a single strong-tier
	// model call. Mirrors her-core/her/memory.py's Memory.surface (Python names this op "surface"; the
	// TS port is named "reflect" so it doesn't collide with the existing retrieval-only surface() here).
	async reflect(opts: ReflectOptions = {}): Promise<ReflectResult> {
		const prepared = await this.withStoreLock(async () => {
			const state = await readJson<{ last_reflect?: string | null }>(this.paths.stateFile, {});
			const lastReflect = typeof state.last_reflect === "string" ? state.last_reflect : undefined;
			const cadenceDays = reflectCadenceDays(this.config);
			const daysSinceLastReflect = daysSince(parseDate(lastReflect));
			const due = daysSinceLastReflect === undefined || daysSinceLastReflect >= cadenceDays;
			if (opts.ifDue && !due) return { kind: "not-due" as const };

			if (!this.model) throw new Error("reflect requires a model");

			const recent = (await this.episodesSince(null)).slice(-5);
			const recentText = recent.map((episode) => episode.text).join("\n\n");
			const existingTexts: string[] = [];
			for (const entry of await markdownEntries(this.paths.recognitions)) {
				const body = parseFrontmatter((await readText(join(this.paths.recognitions, entry))) ?? "").body.trim();
				if (body) existingTexts.push(body);
			}
			const existing = existingTexts.join("\n") || "(none)";
			return { kind: "ready" as const, lastReflect, due, recent, recentText, existing };
		});
		if (prepared.kind === "not-due") return { ran: false, due: false };

		if (!this.model) throw new Error("reflect requires a model");
		const out = (
			(await this.model.complete(surfacePrompt(prepared.recentText, prepared.existing), { strong: true })) ?? ""
		).trim();

		return this.withStoreLock(async () => {
			const state = await readJson<{ last_reflect?: string | null }>(this.paths.stateFile, {});
			const lastReflect = typeof state.last_reflect === "string" ? state.last_reflect : undefined;
			if (lastReflect !== prepared.lastReflect) {
				console.warn("[her] reflect: last_reflect moved during model call; discarding draft");
				return { ran: false, ...(opts.ifDue ? { due: prepared.due } : {}) };
			}

			// A NONE reply is the model's built-in restraint (nothing non-obvious to surface), not a
			// failure: it still counts as this cadence period's reflection, so last_reflect always
			// advances on any real run — a deliberate deviation from the Python reference, which has no
			// cadence tracking at all (Memory.surface there is called on-demand, never gated).
			await writeJson(this.paths.stateFile, { ...state, last_reflect: today() });

			if (!out || out.toUpperCase() === "NONE") return { ran: true, ...(opts.ifDue ? { due: prepared.due } : {}) };

			const date = today();
			const id = genId(date, out);
			const fileName = `${date}--${id}.md`;
			const fm = {
				id,
				status: "pending",
				created: date,
				provenance: prepared.recent.map((episode) => episode.id),
				response_episode: null,
			};
			await writeText(join(this.paths.recognitions, fileName), `${frontmatter(fm)}${out}\n`);
			await git(this.paths.root, "add", "--", `recognitions/${fileName}`, ".her/state.json");
			await git(this.paths.root, "commit", "-m", `memory: reflect recognition ${id}`);
			return { ran: true, ...(opts.ifDue ? { due: prepared.due } : {}), id, text: out };
		});
	}

	async remember(content: string, type = "note"): Promise<string> {
		const id = genId(new Date().toISOString(), content);
		const key = slug(content.split(/\r?\n/, 1)[0] ?? "note");
		await writeText(
			join(this.paths.semantic, `${key}-${id}.md`),
			`${frontmatter({ id, type, tier: "summarizable", created: today() })}# ${key}\n\n${content.trim()}\n`,
		);
		return id;
	}

	async consolidate(limit = 25): Promise<ConsolidateResult> {
		if (!this.model) throw new Error("consolidate requires a model");
		const model = this.model;
		const boot = await this.withStoreLock(async () => {
			const state = await readJson<Record<string, unknown>>(this.paths.stateFile, {});
			const cursor = parseConsolidateCursor(state.cursor ?? null);
			const available = await this.episodesSince(cursor);
			if (available.length === 0) return undefined;
			const existing = await markdownStems(this.paths.semantic);
			const recent = await recentSemanticStems(
				this.paths.semantic,
				envPositiveInt("HER_CONSOLIDATE_KEY_RECENT", DEFAULT_CONSOLIDATE_KEY_RECENT),
			);
			return { state, cursor, available, existing, recent };
		});
		if (!boot) return { episodes: 0, notesTouched: 0, moments: 0 };
		const { state, cursor, available, existing, recent } = boot;
		const consolidateSkipsPath = join(this.paths.root, "audit", "consolidate-skips.jsonl");
		let workingCursor = cursor;
		const seenBodies = new Map<string, { id: string; ts: string }>();
		const indexedAvailable: IndexedConsolidateEpisode[] = available.map((episode, sourceIndex) => {
			const digest = createHash("sha256").update(episode.body, "utf8").digest("hex");
			// Only allocator-created --dup-N names identify capture replays; independent events may share prose.
			const duplicateOf = episode.cursorId.includes("--dup-") ? seenBodies.get(digest) : undefined;
			if (!duplicateOf) seenBodies.set(digest, { id: episode.id, ts: episode.ts });
			return { ...episode, sourceIndex, ...(duplicateOf ? { duplicateOf } : {}) };
		});
		const uniqueAvailable = indexedAvailable.filter((episode) => !episode.duplicateOf);
		const recordedDuplicateIndices = new Set<number>();
		const duplicateEndAfter = (sourceIndex: number): number => {
			let end = sourceIndex;
			while (end + 1 < indexedAvailable.length && indexedAvailable[end + 1]?.duplicateOf) end++;
			return end;
		};
		const recordDuplicateSkipsThrough = async (endIndex: number): Promise<void> => {
			for (const episode of indexedAvailable.slice(0, endIndex + 1)) {
				if (!episode.duplicateOf || recordedDuplicateIndices.has(episode.sourceIndex)) continue;
				await appendText(
					consolidateSkipsPath,
					JSON.stringify({
						at: new Date().toISOString(),
						episode: episode.id,
						ts: episode.ts,
						reason: "duplicate-body",
						duplicate_of: episode.duplicateOf.id,
					}) + "\n",
				);
				console.warn(
					"[her] consolidate: SKIPPED duplicate episode " +
						episode.id +
						" (identical body as " +
						episode.duplicateOf.id +
						"); no model call",
				);
				recordedDuplicateIndices.add(episode.sourceIndex);
			}
		};
		const advanceThrough = async (endIndex: number): Promise<ReturnType<typeof advanceConsolidateCursor>> => {
			return this.withStoreLock(async () => {
				const latest = await readJson<Record<string, unknown>>(this.paths.stateFile, {});
				const latestCursor = parseConsolidateCursor(latest.cursor ?? null);
				const consumed = indexedAvailable.slice(0, endIndex + 1);
				if (cursorFingerprint(latestCursor) !== cursorFingerprint(workingCursor)) {
					console.warn("[her] consolidate: cursor moved before advance; skipping stale cursor write");
					workingCursor = latestCursor;
					if (!latestCursor) throw new Error("cannot advance consolidate cursor without episodes");
					return { ts: latestCursor.ts, done_ids: [...latestCursor.doneIds].sort() };
				}
				await recordDuplicateSkipsThrough(endIndex);
				const advanced = advanceConsolidateCursor(workingCursor, consumed);
				await writeJson(this.paths.stateFile, { ...latest, cursor: advanced, last_consolidate: advanced.ts });
				workingCursor = parseConsolidateCursor(advanced);
				return advanced;
			});
		};

		// Batch size is our primary lever against output-token truncation: the model interface
		// (model.ts ModelLike) exposes no max_tokens knob, and a truncated reply repeats identically
		// for a fixed prompt (so completeJson's re-asks can't fix it). On JsonTruncatedError or JsonMalformedError, halve the
		// batch and retry — a smaller batch has less to emit, so the reply fits — letting the backlog
		// drain instead of wedging forever on batch 1. Halving the realized episode count (not the
		// requested limit) guarantees strict progress even when the char budget was the binding
		// constraint. If a SINGLE episode still truncates (its dense turn overflows even alone, and
		// retrying reproduces it), we skip it: account it to audit/consolidate-skips.jsonl, advance the
		// cursor past it, and keep draining — a frozen backlog is worse than one un-distilled turn,
		// whose raw text stays recoverable in raw/ (G-234; consolidatePrompt also caps note count to
		// keep normal replies inside the output budget). workingCursor threads skip advances so
		// same-timestamp siblings keep correct done_ids.
		// G-247: a stochastically malformed reply (valid-length but unparseable JSON) gets the same
		// treatment — halve while the batch is >1, skip+account at batch 1 — because it too must not
		// cost a whole round. Only a batch-one TRUNCATION enters fat-episode chunking: that one is
		// deterministic and about size, so splitting the input is what actually helps.
		const rawBatchHint = state.consolidate_batch_hint;
		const batchHint =
			typeof rawBatchHint === "number" && Number.isInteger(rawBatchHint) && rawBatchHint > 0
				? Math.min(limit, Math.max(1, rawBatchHint))
				: limit;
		let batchLimit = batchHint;
		let batchWasTruncated = false;
		let remaining: IndexedConsolidateEpisode[] = uniqueAvailable;
		if (remaining.length === 0) {
			await advanceThrough(indexedAvailable.length - 1);
			return { episodes: available.length, notesTouched: 0, moments: 0 };
		}
		const persistBatchHint = async (
			startedBatchLimit: number,
			actualBatchLimit: number,
			truncated: boolean,
		): Promise<void> => {
			await this.withStoreLock(async () => {
				const nextHint = truncated ? actualBatchLimit : startedBatchLimit + 1;
				const latest = await readJson<Record<string, unknown>>(this.paths.stateFile, {});
				await writeJson(this.paths.stateFile, { ...latest, consolidate_batch_hint: Math.max(1, nextHint) });
			});
		};
		const processFatEpisode = async (
			fat: IndexedConsolidateEpisode,
			initialResponseHead: string,
			sample?: CoarseSample,
		): Promise<{ notesTouched: number; moments: number }> => {
			const digestEpisode = sample ? { ...fat, text: sample.text } : fat;
			const outcome = await this.digestFatEpisode(digestEpisode, existing, recent, initialResponseHead, {
				totalChars: fat.text.length,
				allowOversizeFirst: Boolean(sample),
			});
			const fatStale = await this.withStoreLock(async () => {
				const latest = await readJson<Record<string, unknown>>(this.paths.stateFile, {});
				return (
					cursorFingerprint(parseConsolidateCursor(latest.cursor ?? null)) !== cursorFingerprint(workingCursor)
				);
			});
			if (fatStale) {
				console.warn(
					`[her] consolidate: cursor moved during fat-episode model call for ${fat.id}; discarding output`,
				);
				await appendText(
					consolidateSkipsPath,
					`${JSON.stringify({
						at: new Date().toISOString(),
						reason: "premise-moved",
						episode: fat.id,
					})}\n`,
				);
				return { notesTouched: 0, moments: 0 };
			}
			const notes = await this.filterJunkNotes(outcome.notes, consolidateSkipsPath);
			let mergeFailures = 0;
			for (const note of notes) {
				if ((await this.upsertNote(note)) === "merge-failed") mergeFailures++;
			}
			if (mergeFailures > 0) {
				console.warn(
					`[her] consolidate: ${mergeFailures}/${notes.length} chunked note(s) from episode ${fat.id} failed to merge; old bodies kept, see their Timeline pending entries`,
				);
			}
			for (const segment of outcome.quarantined) {
				await this.quarantineSegment(fat, segment);
				await appendText(
					consolidateSkipsPath,
					`${JSON.stringify({
						at: new Date().toISOString(),
						episode: fat.id,
						ts: fat.ts,
						part: segment.part,
						reason: segment.reason,
						response_head: segment.responseHead.slice(0, 200),
					})}\n`,
				);
				console.warn(
					`[her] consolidate: QUARANTINED segment part ${segment.part} of episode ${fat.id} (${segment.text.length} chars, ${segment.reason}) - content saved to .her/quarantine/ and accounted to audit/consolidate-skips.jsonl`,
				);
			}
			if (outcome.digestedChars < outcome.totalChars) {
				const pct =
					outcome.totalChars === 0 ? "100.0" : ((outcome.digestedChars / outcome.totalChars) * 100).toFixed(1);
				console.warn(
					`[her] consolidate: PARTIAL episode ${fat.id} grain=${consolidateGrain(fat.project)} digested ${outcome.digestedChars}/${outcome.totalChars} chars (${pct}%), rest quarantined`,
				);
			}
			if (sample) {
				await appendText(
					consolidateSkipsPath,
					JSON.stringify({
						at: new Date().toISOString(),
						episodeId: fat.id,
						episode: fat.id,
						totalChars: fat.text.length,
						sampledChars: sample.sampledChars,
						slices: sample.slices,
						reason: "coarse-sampled",
					}) + "\n",
				);
				console.warn(
					`[her] consolidate: COARSE-SAMPLED episode ${fat.id} ${sample.sampledChars}/${fat.text.length} chars in ${sample.slices} slices; raw preserved`,
				);
			}
			if (outcome.moments.length > 0) {
				const date = fat.ts.slice(0, 10);
				await appendText(
					this.paths.becoming,
					outcome.moments
						.map((moment) => `- ${date} · trigger: ${moment.trigger ?? ""} · shift: ${moment.shift ?? ""}\n`)
						.join(""),
				);
			}
			return { notesTouched: notes.length, moments: outcome.moments.length };
		};
		for (;;) {
			const batch = selectConsolidateBatch(remaining, batchLimit);
			const episodes = batch.map(({ episode }) => episode);
			if (episodes.length === 0) return { episodes: 0, notesTouched: 0, moments: 0 };
			const firstEpisode = episodes[0];
			const sampleCeil = envPositiveInt("HER_CONSOLIDATE_EPISODE_CHARS", DEFAULT_CONSOLIDATE_EPISODE_CHARS);
			const sampleSlices = envPositiveInt(
				"HER_CONSOLIDATE_COARSE_SAMPLE_SLICES",
				DEFAULT_CONSOLIDATE_COARSE_SAMPLE_SLICES,
			);
			const sampleBudget = sampleSlices * sampleCeil;
			const firstGrain = consolidateGrain(firstEpisode.project);
			if (episodes.length === 1 && firstGrain === "coarse" && firstEpisode.text.length > sampleBudget) {
				const sample = sampleCoarseEpisode(firstEpisode.text, sampleCeil, sampleSlices);
				await processFatEpisode(firstEpisode, "", sample);
				const consumedEnd = duplicateEndAfter(firstEpisode.sourceIndex);
				await advanceThrough(consumedEnd);
				remaining = remaining.slice(batch.length);
				await persistBatchHint(batchHint, batchLimit, batchWasTruncated);
				batchLimit = limit;
				batchWasTruncated = false;
				continue;
			}
			const joined = batch.map(({ promptText }) => promptText).join("\n\n");
			const selectedKeys = selectRelevantKeys(joined, existing, { recent });
			// stderr, not stdout: the CLI writes its --json payload to stdout (cli.ts:335), so an
			// operational line on stdout would be interleaved into the JSON any consumer parses.
			console.warn(
				"[her] consolidate: keys " +
					existing.length +
					" \u2192 " +
					selectedKeys.length +
					" (relevance-filtered, budget " +
					envPositiveInt("HER_CONSOLIDATE_KEY_BUDGET", DEFAULT_CONSOLIDATE_KEY_BUDGET) +
					")",
			);

			let result: {
				notes?: Array<Record<string, unknown>>;
				moments?: Array<{ trigger?: string; shift?: string }>;
			};
			try {
				result = await completeJson<{
					notes?: Array<Record<string, unknown>>;
					moments?: Array<{ trigger?: string; shift?: string }>;
				}>(() => model.complete(consolidatePrompt(joined, selectedKeys)));
			} catch (error) {
				if ((error instanceof JsonTruncatedError || error instanceof JsonMalformedError) && episodes.length > 1) {
					const fromBatchLimit = batchLimit;
					const nextBatchLimit = Math.floor(episodes.length / 2);
					console.warn(`[her] consolidate: batch ${fromBatchLimit} \u2192 ${nextBatchLimit} (truncated)`);
					batchLimit = nextBatchLimit;
					batchWasTruncated = true;
					continue;
				}
				if (error instanceof JsonMalformedError && episodes.length === 1) {
					const skipped = episodes[0];
					await appendText(
						consolidateSkipsPath,
						`${JSON.stringify({
							at: new Date().toISOString(),
							episode: skipped.id,
							ts: skipped.ts,
							reason: "malformed",
							response_head: error.responseHead.slice(0, 200),
						})}\n`,
					);
					console.warn(
						`[her] consolidate: SKIPPED malformed episode ${skipped.id}; content remains in episodic/raw and cursor advances; accounted to audit/consolidate-skips.jsonl`,
					);
					const consumedEnd = duplicateEndAfter(episodes.at(-1)?.sourceIndex ?? -1);
					await advanceThrough(consumedEnd);
					remaining = remaining.slice(batch.length);
					batchLimit = limit;
					batchWasTruncated = false;
					continue;
				}
				if (error instanceof JsonTruncatedError && episodes.length === 1) {
					// G-235 fat-episode chunking. This single episode's distilled output overflows the model's
					// output ceiling even alone, and re-asking reproduces it. Dropping the whole turn (the old
					// backstop) loses everything it holds; instead split its content and distill the pieces that
					// fit. Segments that still truncate at/below the char floor — or that fall past the per-episode
					// attempt budget — are loudly QUARANTINED: their full content is written to .her/quarantine/
					// for human recovery and accounted to audit/consolidate-skips.jsonl. Isolation is not deletion.
					// The model calls happen inside digestFatEpisode; a non-truncation HARD failure there
					// propagates out with nothing applied and the cursor frozen (G-231 durability). Only after
					// every segment is distilled or quarantined do we upsert, quarantine, and advance the cursor.
					const fat = episodes[0];
					await processFatEpisode(fat, error.responseHead);
					const consumedEnd = duplicateEndAfter(fat.sourceIndex);
					await advanceThrough(consumedEnd);
					remaining = remaining.slice(batch.length);
					await persistBatchHint(batchHint, batchLimit, batchWasTruncated);
					batchLimit = limit;
					batchWasTruncated = false;
					continue;
				}
				throw error;
			}

			const rawNotes = result.notes ?? [];
			const consumedEnd = duplicateEndAfter(episodes.at(-1)?.sourceIndex ?? -1);
			const stale = await this.withStoreLock(async () => {
				const latest = await readJson<Record<string, unknown>>(this.paths.stateFile, {});
				const latestCursor = parseConsolidateCursor(latest.cursor ?? null);
				if (cursorFingerprint(latestCursor) === cursorFingerprint(workingCursor)) return false;
				await appendText(
					consolidateSkipsPath,
					`${JSON.stringify({
						at: new Date().toISOString(),
						reason: "premise-moved",
						episodes: episodes.map((episode) => episode.id),
					})}\n`,
				);
				console.warn(
					"[her] consolidate: cursor moved during model call; discarding batch without writing or advancing",
				);
				return true;
			});
			if (stale) return { episodes: 0, notesTouched: 0, moments: 0 };

			const notes = await this.filterJunkNotes(rawNotes, consolidateSkipsPath);
			const moments = result.moments ?? [];
			const newCursor = await advanceThrough(consumedEnd);

			let mergeFailures = 0;
			for (const note of notes) {
				if ((await this.upsertNote(note)) === "merge-failed") mergeFailures++;
			}
			if (mergeFailures > 0) {
				console.warn(
					`[her] consolidate: ${mergeFailures}/${notes.length} note(s) failed to merge; old bodies kept, see their Timeline pending entries`,
				);
			}
			if (moments.length > 0) {
				const date = newCursor.ts.slice(0, 10);
				await this.withStoreLock(async () => {
					await appendText(
						this.paths.becoming,
						moments
							.map((moment) => `- ${date} · trigger: ${moment.trigger ?? ""} · shift: ${moment.shift ?? ""}\n`)
							.join(""),
					);
				});
			}

			await persistBatchHint(batchHint, batchLimit, batchWasTruncated);
			return { episodes: episodes.length, notesTouched: notes.length, moments: moments.length };
		}
	}
	// G-235: distill a single fat episode by recursive halving instead of dropping it whole. Splits the
	// episode's FULL content (not the batch-truncated prefix) and distills every piece that fits the
	// model's output ceiling; pieces that still truncate at/below the char floor, or that fall past the
	// per-episode attempt budget, are returned as `quarantined` for the caller to preserve. A chunk larger
	// than the attempt ceiling is split WITHOUT a model call (a <=ceil slice already truncated, so a larger
	// one cannot fit, and multi-MB inputs are costly). Entry is through splitOrQuarantine, never a fresh
	// attempt on the whole episode: the batch=1 attempt in consolidate ALREADY proved it truncates, so
	// re-asking would only burn a token (the her-core "no futile re-asks" contract). Model calls happen
	// only here; a non-truncation hard failure throws out so the caller applies nothing and the cursor
	// stays frozen. Recursion terminates because splitTextInHalf yields strictly-shorter parts and the
	// floor stops the descent.
	private async digestFatEpisode(
		episode: { id: string; text: string; project: string },
		existing: string[],
		recent: string[],
		initialResponseHead: string,
		options: { totalChars?: number; allowOversizeFirst?: boolean } = {},
	): Promise<{
		notes: Array<Record<string, unknown>>;
		moments: Array<{ trigger?: string; shift?: string }>;
		quarantined: Array<{ part: string; text: string; responseHead: string; reason: string }>;
		digestedChars: number;
		totalChars: number;
	}> {
		if (!this.model) throw new Error("consolidate requires a model");
		const model = this.model;
		const ceil = envPositiveInt("HER_CONSOLIDATE_EPISODE_CHARS", DEFAULT_CONSOLIDATE_EPISODE_CHARS);
		const floor = envPositiveInt("HER_CONSOLIDATE_CHUNK_FLOOR_CHARS", DEFAULT_CONSOLIDATE_CHUNK_FLOOR_CHARS);
		const grain = consolidateGrain(episode.project);
		const legacyMaxAttempts = process.env.HER_CONSOLIDATE_CHUNK_MAX_ATTEMPTS;
		const maxAttempts = legacyMaxAttempts?.trim()
			? envPositiveInt("HER_CONSOLIDATE_CHUNK_MAX_ATTEMPTS", 1)
			: envPositiveInt(
					grain === "fine"
						? "HER_CONSOLIDATE_CHUNK_MAX_ATTEMPTS_FINE"
						: "HER_CONSOLIDATE_CHUNK_MAX_ATTEMPTS_COARSE",
					grain === "fine"
						? DEFAULT_CONSOLIDATE_CHUNK_MAX_ATTEMPTS_FINE
						: DEFAULT_CONSOLIDATE_CHUNK_MAX_ATTEMPTS_COARSE,
				);

		const notes: Array<Record<string, unknown>> = [];
		const moments: Array<{ trigger?: string; shift?: string }> = [];
		const quarantined: Array<{ part: string; text: string; responseHead: string; reason: string }> = [];
		let attempts = 0;
		let digestedChars = 0;
		const totalChars = options.totalChars ?? episode.text.length;

		// A chunk known to truncate: quarantine it if it is already at/below the floor (pathologically
		// dense — its full content is preserved for recovery), otherwise split and recurse the strictly
		// smaller halves, which are new inputs worth a fresh attempt.
		async function splitOrQuarantine(
			text: string,
			part: string,
			responseHead: string,
			reason: "truncated" | "malformed" = "truncated",
		): Promise<void> {
			const [left, right] = text.length <= floor ? ["", ""] : splitTextInHalf(text);
			if (text.length <= floor || left.length === 0 || right.length === 0) {
				quarantined.push({ part, text, responseHead, reason });
				return;
			}
			await recurse(left, `${part}.1`);
			await recurse(right, `${part}.2`);
		}

		async function recurse(text: string, part: string): Promise<void> {
			// Cost cap: once the attempt budget is spent, preserve the rest of this episode as one blob per
			// remaining subtree rather than fan out into hundreds more model calls (real money, nightly).
			if (attempts >= maxAttempts) {
				quarantined.push({ part, text, responseHead: "", reason: "attempt-budget" });
				return;
			}
			// Larger than the attempt ceiling: split without spending a call — a <=ceil slice of THIS episode
			// already truncated, so a larger slice cannot fit, and multi-MB inputs are themselves costly.
			if (text.length > ceil && !(options.allowOversizeFirst && attempts === 0)) {
				const [left, right] = splitTextInHalf(text);
				if (left.length === 0 || right.length === 0) {
					quarantined.push({ part, text, responseHead: "", reason: "unsplittable" });
					return;
				}
				await recurse(left, `${part}.1`);
				await recurse(right, `${part}.2`);
				return;
			}
			attempts++;
			digestedChars += text.length;
			let result: {
				notes?: Array<Record<string, unknown>>;
				moments?: Array<{ trigger?: string; shift?: string }>;
			};
			try {
				const promptText = "[" + episode.id + "] " + text;
				const selectedKeys = selectRelevantKeys(promptText, existing, { recent });
				// stderr, not stdout — same reason as the batch path above.
				console.warn(
					"[her] consolidate: keys " +
						existing.length +
						" \u2192 " +
						selectedKeys.length +
						" (relevance-filtered, budget " +
						envPositiveInt("HER_CONSOLIDATE_KEY_BUDGET", DEFAULT_CONSOLIDATE_KEY_BUDGET) +
						")",
				);
				result = await completeJson(() => model.complete(consolidatePrompt(promptText, selectedKeys)));
			} catch (error) {
				if (error instanceof JsonTruncatedError) {
					await splitOrQuarantine(text, part, error.responseHead);
					return;
				}
				if (error instanceof JsonMalformedError) {
					await splitOrQuarantine(text, part, error.responseHead, "malformed");
					return;
				}
				throw error; // hard failure — propagate; caller applies nothing, cursor stays frozen
			}
			for (const note of result.notes ?? []) notes.push(note);
			for (const moment of result.moments ?? []) moments.push(moment);
		}

		// The batch=1 attempt already proved the whole episode truncates — enter through the known-truncated
		// path, never re-attempting the whole. A <=floor episode quarantines here with no further model call.
		if (options.allowOversizeFirst) await recurse(episode.text, "1");
		else await splitOrQuarantine(episode.text, "1", initialResponseHead);
		return { notes, moments, quarantined, digestedChars, totalChars };
	}

	// G-235: write one quarantined fat-episode segment to <store>/.her/quarantine/ — full content plus the
	// metadata needed to recover or re-run it by hand. Isolation preserves; it never deletes.
	private async quarantineSegment(
		episode: { id: string; ts: string },
		segment: { part: string; text: string; responseHead: string; reason: string },
	): Promise<void> {
		const stem = `${safeStem(episode.id)}--part-${safeStem(segment.part)}`;
		const meta = {
			episode: episode.id,
			part: segment.part,
			ts: episode.ts,
			quarantined_at: new Date().toISOString(),
			reason: segment.reason,
			chars: segment.text.length,
			...(segment.responseHead ? { response_head: segment.responseHead.slice(0, 200) } : {}),
		};
		await writeText(join(this.paths.herDir, "quarantine", `${stem}.md`), `${frontmatter(meta)}${segment.text}\n`);
	}

	async backfill(opts: BackfillOptions = {}): Promise<BackfillRunResult> {
		return runBackfill(this, opts);
	}

	async synthesize(): Promise<string> {
		if (!this.model) throw new Error("synthesize requires a model");
		const prepared = await this.withStoreLock(async () => {
			const current = (await readText(this.paths.contextFile)) ?? SEED_CONTEXT;
			const notes = await readMarkdownDir(this.paths.semantic);
			const moments = (await readText(this.paths.becoming)) ?? "";
			const facts = (await readText(this.paths.factsFile)) ?? "";
			const soul = (await readText(this.paths.soulFile)) ?? SEED_SOUL;
			const self = (await readText(this.paths.selfFile)) ?? SEED_SELF_NARRATIVE;
			const choiceModel = (await readText(this.paths.choiceModelFile)) ?? SEED_CHOICE_MODEL;
			return {
				current,
				notes,
				moments,
				facts,
				soul,
				self,
				choiceModel,
				contextFingerprint: textFingerprint(current),
			};
		});
		const draft = await this.model.complete(
			synthesizePrompt(
				prepared.current,
				prepared.notes,
				prepared.moments,
				prepared.facts,
				prepared.soul,
				prepared.self,
				prepared.choiceModel,
			),
			{
				strong: true,
			},
		);
		// Fail before anything lands. The proposal, CONTEXT.md and last_synthesize all advance
		// together below, so a draft cut off at the token ceiling would overwrite the core
		// narrative and stamp the week done — which is exactly what happened on 08-09/08-11.
		assertNarrativeComplete(draft, prepared.current);
		return this.withStoreLock(async () => {
			const current = (await readText(this.paths.contextFile)) ?? SEED_CONTEXT;
			if (textFingerprint(current) !== prepared.contextFingerprint) {
				console.warn("[her] synthesize: CONTEXT.md changed during model call; discarding draft");
				return `${today()}-narrative-update`;
			}
			const proposalId = `${today()}-narrative-update`;
			await writeText(join(this.paths.proposals, `${proposalId}.md`), draft);
			const state = await readJson<Record<string, unknown>>(this.paths.stateFile, {});
			await writeJson(this.paths.stateFile, { ...state, last_synthesize: today() });
			await this.writeContextUpdate({
				content: draft,
				change: "Synthesize narrative update",
				type: "revise",
				drivenBy: await this.contextUpdateSources(),
				extraPaths: [`proposals/${proposalId}.md`],
			});
			return proposalId;
		});
	}

	async synthesizeDue(): Promise<SynthesizeDueResult> {
		const state = await readJson<{ last_synthesize?: string | null }>(this.paths.stateFile, {});
		const lastSynthesize = typeof state.last_synthesize === "string" ? state.last_synthesize : undefined;
		const lastTime = parseDate(lastSynthesize);
		const threshold = this.config.cadence.synthesizeAfterNewNotes;
		let newSemanticNotes = 0;
		let hasConflict = false;

		for (const entry of await markdownEntries(this.paths.semantic)) {
			const parsed = parseFrontmatter(await readText(join(this.paths.semantic, entry)));
			if (!changedAfter(parsed.data, lastTime)) continue;
			newSemanticNotes++;
			hasConflict ||= hasConflictRelation(parsed.data.relations);
		}

		const daysSinceLastSynthesize = daysSince(lastTime);
		if (hasConflict) {
			return {
				due: true,
				reason: "conflict",
				threshold,
				newSemanticNotes,
				hasConflict,
				lastSynthesize,
				daysSinceLastSynthesize,
			};
		}
		if (newSemanticNotes >= threshold) {
			return {
				due: true,
				reason: "new_notes",
				threshold,
				newSemanticNotes,
				hasConflict,
				lastSynthesize,
				daysSinceLastSynthesize,
			};
		}
		if (
			daysSinceLastSynthesize !== undefined &&
			daysSinceLastSynthesize > this.config.cadence.synthesizeStaleAfterDays
		) {
			return {
				due: true,
				reason: "stale",
				threshold,
				newSemanticNotes,
				hasConflict,
				lastSynthesize,
				daysSinceLastSynthesize,
			};
		}
		return { due: false, threshold, newSemanticNotes, hasConflict, lastSynthesize, daysSinceLastSynthesize };
	}

	async decaySweep(opts: DecaySweepOptions = {}): Promise<DecaySweepResult> {
		return decaySweep(this.paths, opts);
	}

	async restoreArchivedSemantic(
		key: string,
		opts: RestoreArchivedSemanticOptions = {},
	): Promise<RestoreArchivedSemanticResult> {
		return restoreArchivedSemantic(this.paths, key, opts);
	}

	async approve(proposalId: string): Promise<void> {
		return this.withStoreLock(async () => {
			const proposed = await readText(join(this.paths.proposals, `${proposalId}.md`));
			if (proposed === undefined) throw new Error(`no proposal: ${proposalId}`);
			if (((await readText(this.paths.contextFile)) ?? "") === proposed) return;
			await this.writeContextUpdate({
				content: proposed,
				change: `Approve proposal ${proposalId}`,
				type: "revise",
				drivenBy: [`[[proposals/${proposalId}]]`],
			});
		});
	}

	private async organJsonWithShrink<T>(
		units: NoteSummary[],
		render: (units: NoteSummary[]) => Promise<T>,
		floor: number,
		organ: OrganKind,
	): Promise<T | null> {
		let current = units;
		let attempts = 0;
		for (;;) {
			attempts++;
			try {
				return await render(current);
			} catch (error) {
				if (!(error instanceof JsonTruncatedError)) throw error;
				if (current.length <= floor) {
					await this.appendOrganSkip({
						ts: new Date().toISOString(),
						organ,
						reason: "truncated-at-floor",
						units: current.length,
						attempts,
					});
					return null;
				}
				const nextLength = Math.max(floor, Math.floor(current.length / 2));
				current = organ === "ideas" ? current.slice(-nextLength) : current.slice(0, nextLength);
			}
		}
	}

	private async appendOrganSkip(entry: OrganSkipEntry): Promise<void> {
		await appendText(join(this.paths.root, "audit", "organ-skips.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	async buildTopicMaps(): Promise<string[]> {
		if (!this.model) throw new Error("buildTopicMaps requires a model");
		const model = this.model;
		const prepared = await this.withStoreLock(async () => {
			const units = await this.noteSummaries();
			return { units, fingerprint: textFingerprint(JSON.stringify(units)) };
		});
		if (prepared.units.length === 0) return [];
		const batchSize = envPositiveInt("HER_TOPICS_BATCH_UNITS", DEFAULT_TOPICS_BATCH_UNITS);
		const floor = envPositiveInt("HER_TOPICS_MIN_BATCH_UNITS", DEFAULT_TOPICS_MIN_BATCH_UNITS);
		const keyset = new Set(prepared.units.map((unit) => unit.key));
		const maps = new Map<string, { theme: string; summary: string; members: Set<string> }>();
		for (let start = 0; start < prepared.units.length; start += batchSize) {
			const batch = prepared.units.slice(start, start + batchSize);
			const result = await this.organJsonWithShrink(
				batch,
				async (current) => {
					const lines = current.map((unit) => `- ${unit.key} (${unit.type}): ${unit.title}`).join("\n");
					return completeJson<{ maps?: Array<{ theme?: string; summary?: string; members?: string[] }> }>(() =>
						model.complete(topicMapPrompt(lines), { strong: true }),
					);
				},
				floor,
				"topic-maps",
			);
			if (result === null) continue;
			for (const map of result.maps ?? []) {
				if (!map.theme) continue;
				const key = slug(map.theme);
				const members = (map.members ?? []).map(slug).filter((member) => keyset.has(member));
				const existing = maps.get(key);
				if (existing) {
					for (const member of members) existing.members.add(member);
					if (!existing.summary && map.summary?.trim()) existing.summary = map.summary;
					continue;
				}
				maps.set(key, {
					theme: map.theme,
					summary: map.summary?.trim() ? map.summary : "",
					members: new Set(members),
				});
			}
		}
		return this.withStoreLock(async () => {
			const units = await this.noteSummaries();
			if (textFingerprint(JSON.stringify(units)) !== prepared.fingerprint) {
				console.warn("[her] buildTopicMaps: note summaries changed during model call; discarding maps");
				await this.appendOrganSkip({
					ts: new Date().toISOString(),
					organ: "topic-maps",
					reason: "premise-moved",
					units: units.length,
					attempts: 0,
				});
				return [];
			}
			const written: string[] = [];
			for (const [key, map] of maps) {
				const members = [...map.members];
				await writeText(
					join(this.paths.topics, `${key}.md`),
					`${frontmatter({ theme: map.theme, created: today(), members })}# ${map.theme}\n\n${map.summary}\n\n## Units\n${members.map((member) => `- [[${member}]]`).join("\n")}\n`,
				);
				written.push(key);
			}
			return written;
		});
	}

	async generateIdeas(): Promise<Array<{ id: string; title: string; kind: string }>> {
		if (!this.model) throw new Error("generateIdeas requires a model");
		const model = this.model;
		const prepared = await this.withStoreLock(async () => {
			const units = await this.noteSummaries();
			const topicLines = (await this.topicSummaries()).join("\n") || "(none)";
			const existing = (await this.existingIdeaTitles()).join("\n") || "(none)";
			return {
				units,
				topicLines,
				existing,
				fingerprint: textFingerprint(`${JSON.stringify(units)}\n${topicLines}\n${existing}`),
			};
		});
		if (prepared.units.length === 0) return [];
		const maxUnits = envPositiveInt("HER_IDEAS_MAX_UNITS", DEFAULT_IDEAS_MAX_UNITS);
		const floor = envPositiveInt("HER_IDEAS_MIN_UNITS", DEFAULT_IDEAS_MIN_UNITS);
		const subset = prepared.units.length > maxUnits ? prepared.units.slice(-maxUnits) : prepared.units;
		const result = await this.organJsonWithShrink(
			subset,
			async (current) => {
				const unitLines = current
					.map((unit) => `- ${unit.key} (${unit.kind}/${unit.type}): ${unit.title}`)
					.join("\n");
				return completeJson<{
					ideas?: Array<{
						title?: string;
						connects?: string[];
						insight?: string;
						spark?: string;
						kind?: string;
					}>;
				}>(() =>
					model.complete(ideaEnginePrompt(unitLines, prepared.topicLines, prepared.existing), { strong: true }),
				);
			},
			floor,
			"ideas",
		);
		if (result === null) return [];
		return this.withStoreLock(async () => {
			const units = await this.noteSummaries();
			const topicLines = (await this.topicSummaries()).join("\n") || "(none)";
			const existing = (await this.existingIdeaTitles()).join("\n") || "(none)";
			if (textFingerprint(`${JSON.stringify(units)}\n${topicLines}\n${existing}`) !== prepared.fingerprint) {
				console.warn("[her] generateIdeas: units/topics/ideas changed during model call; discarding ideas");
				await this.appendOrganSkip({
					ts: new Date().toISOString(),
					organ: "ideas",
					reason: "premise-moved",
					units: units.length,
					attempts: 0,
				});
				return [];
			}
			const written: Array<{ id: string; title: string; kind: string }> = [];
			for (const idea of result.ideas ?? []) {
				if (!idea.title) continue;
				const id = genId(today(), idea.title);
				const connects = (idea.connects ?? []).map(slug).filter(Boolean);
				const kind = idea.kind ?? "";
				const body = `# ${idea.title}\n\n**Insight:** ${idea.insight ?? ""}\n\n**Spark:** ${idea.spark ?? ""}\n\n## Connects\n${connects.map((item) => `- [[${item}]]`).join("\n")}\n`;
				await writeText(
					join(this.paths.ideas, `${today()}--${id}.md`),
					`${frontmatter({ id, created: today(), kind, status: "new", connects })}${body}`,
				);
				written.push({ id, title: idea.title, kind });
			}
			return written;
		});
	}

	// Rhythm gate for synthesizeChoiceModel() (G-170): mirrors synthesizeDue()'s shape (days-since-last
	// check plus a "is there anything to distill" check) but combines them with AND rather than
	// synthesizeDue()'s OR, per the G-170 task packet's explicit spec. hasJudgmentTrails uses the exact
	// same choiceModelJudgmentTrails() precondition synthesizeChoiceModel() itself throws without, so a
	// `due: true` result can always be safely followed by calling synthesizeChoiceModel().
	async choiceModelSynthesizeDue(): Promise<ChoiceModelSynthesizeDueResult> {
		const state = await readJson<{ last_choice_model?: string | null }>(this.paths.stateFile, {});
		const lastChoiceModel = typeof state.last_choice_model === "string" ? state.last_choice_model : undefined;
		const lastTime = parseDate(lastChoiceModel);
		const daysSinceLastChoiceModel = daysSince(lastTime);
		const rhythmDue =
			lastTime === undefined ||
			(daysSinceLastChoiceModel ?? Number.POSITIVE_INFINITY) >= CHOICE_MODEL_SYNTHESIZE_AFTER_DAYS;

		const hasJudgmentTrails = (await this.choiceModelJudgmentTrails()).length > 0;

		return {
			due: rhythmDue && hasJudgmentTrails,
			thresholdDays: CHOICE_MODEL_SYNTHESIZE_AFTER_DAYS,
			hasJudgmentTrails,
			lastChoiceModel,
			daysSinceLastChoiceModel,
		};
	}

	async synthesizeChoiceModel(): Promise<ChoiceModelUpdateResult> {
		if (!this.model) throw new Error("synthesizeChoiceModel requires a model");
		const prepared = await this.withStoreLock(async () => {
			const trails = await this.choiceModelJudgmentTrails();
			if (trails.length === 0) throw new Error("synthesizeChoiceModel requires Judgment Trail evidence");
			const current = (await readText(this.paths.choiceModelFile)) ?? SEED_CHOICE_MODEL;
			const evidence = trails.map((trail) => `${trail.ref}\n${trail.text}`).join("\n\n");
			return { trails, current, evidence, fingerprint: textFingerprint(current) };
		});
		const draft = await this.model.complete(choiceModelPrompt(prepared.current, prepared.evidence), { strong: true });
		return this.withStoreLock(async () => {
			const current = (await readText(this.paths.choiceModelFile)) ?? SEED_CHOICE_MODEL;
			if (textFingerprint(current) !== prepared.fingerprint) {
				console.warn("[her] synthesizeChoiceModel: CHOICE-MODEL.md changed during model call; discarding draft");
				const timestamp = new Date().toISOString();
				return { id: genId(timestamp, "choice-model"), commit: "" };
			}
			const timestamp = new Date().toISOString();
			const id = genId(timestamp, "choice-model");
			await writeText(this.paths.choiceModelFile, draft);
			await appendText(
				this.choiceModelLogFile(),
				choiceModelLogBlock(
					id,
					timestamp,
					prepared.trails.map((trail) => trail.ref),
				),
			);
			const state = await readJson<Record<string, unknown>>(this.paths.stateFile, {});
			await writeJson(this.paths.stateFile, { ...state, last_choice_model: timestamp.slice(0, 10) });
			await git(
				this.paths.root,
				"add",
				"--",
				"narrative/CHOICE-MODEL.md",
				"narrative/choice-model-log.md",
				".her/state.json",
			);
			await git(this.paths.root, "commit", "-m", "memory(choice): Synthesize choice model");
			const commit = (await git(this.paths.root, "rev-parse", "--short", "HEAD")).stdout.trim();
			return { id, commit };
		});
	}

	async synthesizeSelfNarrative(): Promise<SelfNarrativeUpdateResult> {
		if (!this.model) throw new Error("synthesizeSelfNarrative requires a model");
		const prepared = await this.withStoreLock(async () => {
			const evidence = await this.selfNarrativeEvidence();
			if (!evidence.moments.trim() && evidence.recognitions.length === 0) {
				throw new Error("synthesizeSelfNarrative requires becoming moments or recognitions");
			}
			const current = (await readText(this.paths.selfFile)) ?? SEED_SELF_NARRATIVE;
			const context = (await readText(this.paths.contextFile)) ?? SEED_CONTEXT;
			const recognitionText = evidence.recognitions
				.map((recognition) => `${recognition.ref}\n${recognition.text}`)
				.join("\n\n");
			return { evidence, current, context, recognitionText, fingerprint: textFingerprint(current) };
		});
		const draft = await this.model.complete(
			selfNarrativePrompt(prepared.current, prepared.context, prepared.evidence.moments, prepared.recognitionText),
			{ strong: true },
		);
		return this.withStoreLock(async () => {
			const current = (await readText(this.paths.selfFile)) ?? SEED_SELF_NARRATIVE;
			if (textFingerprint(current) !== prepared.fingerprint) {
				console.warn("[her] synthesizeSelfNarrative: SAMANTHA.md changed during model call; discarding draft");
				const timestamp = new Date().toISOString();
				return { id: genId(timestamp, "self-narrative"), commit: "" };
			}
			const timestamp = new Date().toISOString();
			const id = genId(timestamp, "self-narrative");
			const refs = [
				...(prepared.evidence.moments.trim() ? ["[[narrative/becoming-moments]]"] : []),
				...prepared.evidence.recognitions.map((recognition) => recognition.ref),
			];
			await writeText(this.paths.selfFile, draft);
			await appendText(this.selfNarrativeLogFile(), selfNarrativeLogBlock(id, timestamp, refs));
			const state = await readJson<Record<string, unknown>>(this.paths.stateFile, {});
			await writeJson(this.paths.stateFile, { ...state, last_self_narrative: timestamp.slice(0, 10) });
			await git(
				this.paths.root,
				"add",
				"--",
				"narrative/SAMANTHA.md",
				"narrative/self-narrative-log.md",
				".her/state.json",
			);
			await git(this.paths.root, "commit", "-m", "memory(self): Synthesize self narrative");
			const commit = (await git(this.paths.root, "rev-parse", "--short", "HEAD")).stdout.trim();
			return { id, commit };
		});
	}

	async writeContextUpdate(input: ContextUpdateInput): Promise<{ id: string; commit: string }> {
		return this.withStoreLock(async () => {
			const timestamp = new Date().toISOString();
			const id = genId(timestamp, input.change);
			await writeText(this.paths.contextFile, input.content);
			await appendText(this.contextLogFile(), contextLogBlock(id, timestamp, input));
			const state = await readJson<{ unreviewed_updates?: string[] }>(this.paths.stateFile, {});
			await writeJson(this.paths.stateFile, {
				...state,
				unreviewed_updates: [...new Set([...(state.unreviewed_updates ?? []), id])],
			});
			await this.stageContextUpdateFiles(input.extraPaths);
			await git(this.paths.root, "commit", "-m", `memory(context): ${input.change}`);
			const commit = (await git(this.paths.root, "rev-parse", "--short", "HEAD")).stdout.trim();
			return { id, commit };
		});
	}

	async reviewContextUpdates(): Promise<ContextUpdateRecord[]> {
		const records = parseContextLog((await readText(this.contextLogFile())) ?? "");
		const unreviewed = records.filter((record) => record.status === "unreviewed");
		for (const record of unreviewed) {
			record.commit = await this.findContextUpdateCommit(record.id);
			if (record.commit) record.diff = await this.contextUpdateDiff(record.commit);
		}
		return unreviewed;
	}

	async contextDigestDue(): Promise<ContextUpdateRecord[]> {
		const updates = await this.reviewContextUpdates();
		if (updates.length < this.config.cadence.digestAfterUnreviewed) return [];
		const ids = updates.map((update) => update.id).sort();
		const state = await readJson<{ last_digest_updates?: string[] }>(this.paths.stateFile, {});
		const last = [...(state.last_digest_updates ?? [])].sort();
		return sameStrings(ids, last) ? [] : updates;
	}

	async markContextDigestSent(updateIds: string[]): Promise<void> {
		return this.withStoreLock(async () => {
			const state = await readJson<Record<string, unknown>>(this.paths.stateFile, {});
			await writeJson(this.paths.stateFile, {
				...state,
				last_digest: today(),
				last_digest_updates: [...updateIds].sort(),
			});
		});
	}

	async keepContextUpdate(id: string): Promise<void> {
		return this.withStoreLock(async () => {
			await this.setContextUpdateStatus(id, "kept");
			await this.removeUnreviewedUpdate(id);
			await this.commitIfDirty(`memory(context): keep ${id}`);
		});
	}

	async revertContextUpdate(id: string): Promise<void> {
		return this.withStoreLock(async () => {
			const commit = await this.findContextUpdateCommit(id);
			if (!commit) throw new Error(`context update commit not found: ${id}`);
			const previous = await git(this.paths.root, "show", `${commit}^:narrative/CONTEXT.md`).catch(() => ({
				stdout: SEED_CONTEXT,
				stderr: "",
			}));
			await writeText(this.paths.contextFile, previous.stdout);
			await this.setContextUpdateStatus(id, "reverted");
			await this.removeUnreviewedUpdate(id);
			await this.commitIfDirty(`memory(context): revert ${id}`);
		});
	}

	async writeIdea(data: IdeaData): Promise<string> {
		const id = genId(data.title, data.content);
		const key = slug(data.title);
		const connections = data.connections ?? [];
		const body = `# ${data.title}

${data.content.trim()}

## Connections

${connections.map((item) => `- [[${item}]]`).join("\n")}
`;
		await writeText(
			join(this.paths.ideas, `${today()}--${key}--${id}.md`),
			`${frontmatter({ id, title: data.title, created: today(), source: data.source ?? "her_idea", connections })}${body}`,
		);
		return id;
	}

	async writeSamanthaZoneNote(data: SamanthaZoneNoteInput): Promise<SamanthaZoneNoteResult> {
		return writeSamanthaZoneNote(this.paths, data);
	}

	async writeSamanthaJournal(data: SamanthaJournalInput): Promise<SamanthaJournalResult> {
		return writeSamanthaJournal(this.paths, data);
	}

	async writeSamanthaTasteJudgment(data: SamanthaTasteJudgmentInput): Promise<SamanthaTasteJudgmentResult> {
		return writeSamanthaTasteJudgment(this.paths, data);
	}

	async writeWorldNote(data: WorldNoteData): Promise<string> {
		return writeWorldNote(this.paths, data);
	}

	async recordJudgment(noteId: string, fields: JudgmentFields): Promise<void> {
		await recordJudgment(this.paths, noteId, fields);
	}

	async setMemoryStatus(
		noteId: string,
		status: "active" | "archive_only" | "needs_deep_read",
		reason: string,
	): Promise<void> {
		await setMemoryStatus(this.paths, noteId, status, reason);
	}

	async applyTasteBoard(cardId: string, board: string): Promise<TasteBoardApplyResult> {
		return applyTasteBoard(this.paths, cardId, board);
	}

	async sync(message = `memory(sync): ${new Date().toISOString()}`): Promise<MemorySyncResult> {
		return syncMemory(this.paths, message);
	}

	async syncStatus(): Promise<MemorySyncStatus> {
		return syncStatus(this.paths);
	}

	private async episodesSince(cursor: ParsedConsolidateCursor | null): Promise<ConsolidateEpisode[]> {
		const entries = await markdownEntries(this.paths.raw);
		const episodes: ConsolidateEpisode[] = [];
		for (const entry of entries) {
			if (!shouldReadRawEpisodeName(entry, cursor)) continue;
			const path = join(this.paths.raw, entry);
			const parsed = parseFrontmatter(await readText(path));
			if (parsed.data.protected_zone === true || parsed.data.consolidate === false) continue;
			const ts = String(parsed.data.timestamp ?? rawEpisodeTimestamp(entry));
			const cursorId = rawEpisodeIdFromName(entry);
			if (!shouldUseRawEpisode(ts, cursorId, cursor)) continue;
			const id = String(parsed.data.id ?? entry.replace(/\.md$/, ""));
			const stripped = stripCipherBlobs(parsed.body.trim());
			if (stripped.blobs > 0) {
				console.warn(
					`[her] consolidate: stripped ${stripped.blobs} cipher blob(s), ${stripped.strippedChars} chars, from ${id}`,
				);
			}
			episodes.push({
				ts,
				id,
				cursorId,
				text: stripped.text,
				body: parsed.body,
				project: String(parsed.data.project ?? ""),
			});
		}
		return episodes.sort((a, b) => a.ts.localeCompare(b.ts));
	}
	private async filterJunkNotes(
		notes: Array<Record<string, unknown>>,
		consolidateSkipsPath: string,
	): Promise<Array<Record<string, unknown>>> {
		const accepted: Array<Record<string, unknown>> = [];
		for (const note of notes) {
			const junkReason = isJunkNote(note);
			if (!junkReason) {
				accepted.push(note);
				continue;
			}
			const noteKey = typeof note.key === "string" ? note.key : typeof note.title === "string" ? note.title : "";
			await appendText(
				consolidateSkipsPath,
				JSON.stringify({
					at: new Date().toISOString(),
					reason: "junk-note",
					note_key: noteKey,
					junk_reason: junkReason,
				}) + "\n",
			);
			console.warn(`[her] consolidate: DROPPED junk note "${noteKey}" (${junkReason})`);
		}
		return accepted;
	}
	private async upsertNote(note: Record<string, unknown>): Promise<"created" | "merged" | "merge-failed"> {
		const key = slug(String(note.key ?? note.title ?? "note"));
		const path = join(this.paths.semantic, `${key}.md`);
		const incomingSources = Array.isArray(note.sources) ? note.sources.map(String) : [];
		const incoming = typeof note.content === "string" ? note.content : "";
		const relations = normalizeRelations(note);

		const snapshot = await this.withStoreLock(async () => {
			const existingText = await readText(path);
			const existing = parseFrontmatter(existingText);
			const existingSources = Array.isArray(existing.data.sources) ? existing.data.sources.map(String) : [];
			const sources = [...new Set([...existingSources, ...incomingSources])].sort();
			const type = typeof note.type === "string" && UNIT_TYPES.has(note.type) ? note.type : "note";
			const tier = normalizeActiveTier(note.tier, existing.data.tier);
			const isExisting = existingText !== undefined;
			const oldProse = isExisting ? stripSection(stripSection(existing.body, "Relations"), "Timeline").trim() : "";
			const priorTimeline = isExisting ? extractSection(existing.body, "Timeline") : "";
			return {
				fingerprint: textFingerprint(existingText),
				created: existing.data.created ?? today(),
				sources,
				type,
				tier,
				isExisting,
				oldProse,
				priorTimeline,
			};
		});

		const srcLabel = incomingSources.length > 0 ? incomingSources.join(", ") : "(unknown)";

		// G-234 law 1 — compiled truth is a REWRITE, never a blind overwrite. On a key that already
		// exists, letting the new content replace the body wholesale silently drops the old note's other
		// knowledge, so we integrate (old prose + new) via one LLM call. New keys write directly. The
		// old `## Relations`/`## Timeline` scaffolding is stripped first so only real prose is reconciled.
		let body: string;
		let change: string;
		let outcome: "created" | "merged" | "merge-failed";
		if (!snapshot.isExisting) {
			body = incoming;
			change = typeof note.change === "string" && note.change.trim() ? note.change : "created";
			outcome = "created";
		} else if (this.model) {
			const model = this.model;
			try {
				const merged = await completeJson<{ content?: unknown; change?: unknown }>(() =>
					model.complete(mergeNotePrompt(snapshot.oldProse, incoming, relations)),
				);
				const mergedContent = typeof merged.content === "string" ? merged.content.trim() : "";
				if (!mergedContent) throw new Error("merge returned empty content");
				body = mergedContent;
				change = typeof merged.change === "string" && merged.change.trim() ? merged.change : "note updated";
				outcome = "merged";
			} catch (error) {
				// 止损底线 — keep the OLD prose verbatim; never fall back to a blind overwrite with the raw
				// new content. Record the miss on the Timeline and fail loud; one bad note must not abort
				// the batch (fail loud, degrade gracefully).
				console.warn(
					`[her] upsertNote merge failed for note "${key}": ${errorMessage(error)}; keeping old body, new info pending in episode ${srcLabel}`,
				);
				body = snapshot.oldProse;
				change = `merge failed, new info in episode ${srcLabel} pending`;
				outcome = "merge-failed";
			}
		} else {
			// Existing note but no model available to merge — keep the old prose, do not blind-overwrite.
			console.warn(
				`[her] upsertNote has no model to merge note "${key}"; keeping old body, new info pending in episode ${srcLabel}`,
			);
			body = snapshot.oldProse;
			change = `merge failed, new info in episode ${srcLabel} pending`;
			outcome = "merge-failed";
		}

		return this.withStoreLock(async () => {
			const currentText = await readText(path);
			if (textFingerprint(currentText) !== snapshot.fingerprint) {
				console.warn(`[her] upsertNote: note changed during merge ("${key}"); skipping stale write`);
				await appendText(
					join(this.paths.root, "audit", "consolidate-skips.jsonl"),
					`${JSON.stringify({
						at: new Date().toISOString(),
						reason: "premise-moved",
						note_key: key,
					})}\n`,
				);
				return "merge-failed";
			}
			const fm = {
				key,
				type: snapshot.type,
				tier: snapshot.tier,
				created: snapshot.created,
				updated: today(),
				sources: snapshot.sources,
				relations,
			};

			// G-234 law 2 — semantic-level changelog. `## Timeline` lives after `## Relations` and is
			// append-only: prior entries are carried forward unchanged and one line is appended per upsert.
			const relationBody =
				relations.length > 0
					? `\n\n## Relations\n${relations.map((relation) => `- ${relation.rel}: [[${relation.to}]]`).join("\n")}\n`
					: "\n";
			const timelineBody = `\n## Timeline\n${[
				snapshot.priorTimeline,
				timelineEntry(today(), change, incomingSources),
			]
				.filter((part) => part.trim())
				.join("\n")}\n`;
			await writeText(path, `${frontmatter(fm)}${body.trimEnd()}${relationBody}${timelineBody}`);
			for (const relation of relations) {
				if (relation.rel === "replaces") await this.markSemanticNoteSuperseded(relation.to, key);
			}
			return outcome;
		});
	}

	private async markSemanticNoteSuperseded(targetKey: string, replacementKey: string): Promise<void> {
		if (!targetKey || targetKey === replacementKey) return;
		const path = join(this.paths.semantic, `${targetKey}.md`);
		const text = await readText(path);
		if (text === undefined) return;
		const parsed = parseFrontmatter(text);
		if (parsed.data.superseded_by === replacementKey) return;
		const fm = {
			...parsed.data,
			status: "superseded",
			superseded_by: replacementKey,
			superseded_at: today(),
		};
		const marker = `\n\n## EVOLVES\n- replaced by [[${replacementKey}]]\n`;
		const body = parsed.body.includes(`[[${replacementKey}]]`)
			? parsed.body.trimEnd()
			: `${parsed.body.trimEnd()}${marker}`;
		await writeText(path, `${frontmatter(fm)}${body}\n`);
	}

	private async noteSummaries(): Promise<Array<{ key: string; kind: string; type: string; title: string }>> {
		const out: Array<{ key: string; kind: string; type: string; title: string }> = [];
		for (const [dir, kind] of [
			[this.paths.semantic, "semantic"],
			[this.paths.world, "world"],
			[this.paths.samanthaCollection, "samantha/collection"],
		] as const) {
			for (const entry of await markdownEntries(dir)) {
				if (entry.toLowerCase() === "readme.md") continue;
				const text = (await readText(join(dir, entry))) ?? "";
				const parsed = parseFrontmatter(text);
				const title = parsed.body
					.split(/\r?\n/)
					.find((line) => line.startsWith("# "))
					?.slice(2)
					.trim();
				out.push({
					key:
						kind === "samantha/collection" ? `${kind}/${entry.replace(/\.md$/, "")}` : entry.replace(/\.md$/, ""),
					kind,
					type: typeof parsed.data.type === "string" ? parsed.data.type : "note",
					title: title || entry.replace(/\.md$/, ""),
				});
			}
		}
		return out;
	}

	private async topicSummaries(): Promise<string[]> {
		const lines: string[] = [];
		for (const entry of await markdownEntries(this.paths.topics)) {
			const parsed = parseFrontmatter(await readText(join(this.paths.topics, entry)));
			const members = Array.isArray(parsed.data.members) ? parsed.data.members.join(", ") : "";
			lines.push(`- ${String(parsed.data.theme ?? entry.replace(/\.md$/, ""))}: ${members}`);
		}
		return lines;
	}

	private async existingIdeaTitles(): Promise<string[]> {
		const titles: string[] = [];
		for (const entry of await markdownEntries(this.paths.ideas)) {
			const body = parseFrontmatter(await readText(join(this.paths.ideas, entry))).body;
			titles.push(
				body
					.split(/\r?\n/)
					.find((line) => line.startsWith("# "))
					?.slice(2)
					.trim() ?? entry.replace(/\.md$/, ""),
			);
		}
		return titles;
	}

	private contextLogFile(): string {
		return join(this.paths.narrative, "context-log.md");
	}

	private choiceModelLogFile(): string {
		return join(this.paths.narrative, "choice-model-log.md");
	}

	private selfNarrativeLogFile(): string {
		return join(this.paths.narrative, "self-narrative-log.md");
	}

	private async stageContextUpdateFiles(extraPaths: string[] = []): Promise<void> {
		await git(
			this.paths.root,
			"add",
			"--",
			"narrative/CONTEXT.md",
			"narrative/context-log.md",
			".her/state.json",
			...extraPaths,
		);
	}

	private async setContextUpdateStatus(id: string, status: ContextUpdateRecord["status"]): Promise<void> {
		const text = (await readText(this.contextLogFile())) ?? "";
		const pattern = new RegExp(`(### ${escapeRegExp(id)}[\\s\\S]*?- status: )\\w+`);
		if (!pattern.test(text)) throw new Error(`context update not found: ${id}`);
		await writeText(this.contextLogFile(), text.replace(pattern, `$1${status}`));
	}

	private async removeUnreviewedUpdate(id: string): Promise<void> {
		return this.withStoreLock(async () => {
			const state = await readJson<{ unreviewed_updates?: string[] }>(this.paths.stateFile, {});
			await writeJson(this.paths.stateFile, {
				...state,
				unreviewed_updates: (state.unreviewed_updates ?? []).filter((item) => item !== id),
			});
		});
	}

	private async findContextUpdateCommit(id: string): Promise<string | undefined> {
		const result = await git(this.paths.root, "log", "--format=%H", "-G", id, "--", "narrative/context-log.md").catch(
			() => ({ stdout: "", stderr: "" }),
		);
		return result.stdout.trim().split(/\r?\n/).find(Boolean);
	}

	private async contextUpdateDiff(commit: string): Promise<string | undefined> {
		const result = await git(this.paths.root, "show", "--format=", commit, "--", "narrative/CONTEXT.md").catch(
			() => ({
				stdout: "",
				stderr: "",
			}),
		);
		return result.stdout.trim() || undefined;
	}

	private async commitIfDirty(message: string): Promise<void> {
		await this.stageContextUpdateFiles();
		const staged = await git(this.paths.root, "diff", "--cached", "--name-only");
		if (!staged.stdout.trim()) return;
		await git(this.paths.root, "commit", "-m", message);
	}

	private async markRecognitionAnswered(ref: string, episodeId: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(this.paths.recognitions);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const path = join(this.paths.recognitions, entry);
			const parsed = parseFrontmatter(await readText(path));
			if (parsed.data.id !== ref) continue;
			parsed.data.status = "answered";
			parsed.data.response_episode = episodeId;
			await writeText(path, `${frontmatter(parsed.data)}${parsed.body}`);
			return;
		}
	}

	private async contextUpdateSources(): Promise<string[]> {
		const refs = new Set<string>();
		for (const entry of await markdownEntries(this.paths.semantic)) {
			const path = join(this.paths.semantic, entry);
			const stem = basename(entry, ".md");
			refs.add(`[[semantic/${stem}]]`);
			const parsed = parseFrontmatter(await readText(path));
			if (!Array.isArray(parsed.data.sources)) continue;
			for (const source of parsed.data.sources) refs.add(sourceRef(String(source)));
		}
		const moments = (await readText(this.paths.becoming)) ?? "";
		if (moments.trim()) refs.add("[[narrative/becoming-moments]]");
		return [...refs].sort();
	}

	private async choiceModelJudgmentTrails(): Promise<Array<{ ref: string; text: string }>> {
		const trails: Array<{ ref: string; text: string }> = [];
		for (const entry of await markdownEntries(this.paths.world)) {
			const body = parseFrontmatter(await readText(join(this.paths.world, entry))).body;
			const trail = extractSection(body, "Judgment Trail");
			if (!trail.trim()) continue;
			trails.push({ ref: `[[world/${basename(entry, ".md")}]]`, text: trail.trim() });
		}
		return trails.sort((a, b) => a.ref.localeCompare(b.ref));
	}

	private async selfNarrativeEvidence(): Promise<{
		moments: string;
		recognitions: Array<{ ref: string; text: string }>;
	}> {
		const moments = (await readText(this.paths.becoming)) ?? "";
		const recognitions: Array<{ ref: string; text: string }> = [];
		for (const entry of await markdownEntries(this.paths.recognitions)) {
			const text = (await readText(join(this.paths.recognitions, entry))) ?? "";
			if (!text.trim()) continue;
			recognitions.push({ ref: `[[recognitions/${basename(entry, ".md")}]]`, text: text.trim() });
		}
		return { moments: moments.trim(), recognitions: recognitions.sort((a, b) => a.ref.localeCompare(b.ref)) };
	}
}

function isProtectedSurfaceId(noteId: string): boolean {
	return /^samantha\/(?:wants|journal)(?:\/|$)/.test(noteId);
}

function isMemoryOptions(value: ModelLike | MemoryOptions | undefined): value is MemoryOptions {
	return Boolean(
		value &&
			typeof value === "object" &&
			!("complete" in value) &&
			("model" in value || "config" in value || "semanticSearch" in value),
	);
}
