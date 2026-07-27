import { mkdir, readdir } from "node:fs/promises";
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
	changedAfter,
	choiceModelLogBlock,
	choiceRuleRuntimeStatus,
	completeJson,
	contextLogBlock,
	daysSince,
	episodeSection,
	escapeRegExp,
	extractSection,
	genId,
	git,
	hasConflictRelation,
	isFileExists,
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
			try {
				await writeNewText(join(this.paths.raw, `${stem}.md`), text);
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
			const existing = parseChoiceRuleRecords((await readText(path)) ?? "");
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
			return { domain, path, rule: record.rule, weight: record.weight, status: choiceRuleRuntimeStatus(record, at) };
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
		return this.withStoreLock(async () => {
			const state = await readJson<{ last_reflect?: string | null }>(this.paths.stateFile, {});
			const lastReflect = typeof state.last_reflect === "string" ? state.last_reflect : undefined;
			const cadenceDays = reflectCadenceDays(this.config);
			const daysSinceLastReflect = daysSince(parseDate(lastReflect));
			const due = daysSinceLastReflect === undefined || daysSinceLastReflect >= cadenceDays;
			if (opts.ifDue && !due) return { ran: false, due: false };

			if (!this.model) throw new Error("reflect requires a model");
			const model = this.model;

			const recent = (await this.episodesSince(null)).slice(-5);
			const recentText = recent.map((episode) => episode.text).join("\n\n");
			const existingTexts: string[] = [];
			for (const entry of await markdownEntries(this.paths.recognitions)) {
				const body = parseFrontmatter((await readText(join(this.paths.recognitions, entry))) ?? "").body.trim();
				if (body) existingTexts.push(body);
			}
			const existing = existingTexts.join("\n") || "(none)";

			const out = ((await model.complete(surfacePrompt(recentText, existing), { strong: true })) ?? "").trim();

			// A NONE reply is the model's built-in restraint (nothing non-obvious to surface), not a
			// failure: it still counts as this cadence period's reflection, so last_reflect always
			// advances on any real run — a deliberate deviation from the Python reference, which has no
			// cadence tracking at all (Memory.surface there is called on-demand, never gated).
			await writeJson(this.paths.stateFile, { ...state, last_reflect: today() });

			if (!out || out.toUpperCase() === "NONE") return { ran: true, ...(opts.ifDue ? { due } : {}) };

			const date = today();
			const id = genId(date, out);
			const fileName = `${date}--${id}.md`;
			const fm = {
				id,
				status: "pending",
				created: date,
				provenance: recent.map((episode) => episode.id),
				response_episode: null,
			};
			await writeText(join(this.paths.recognitions, fileName), `${frontmatter(fm)}${out}\n`);
			await git(this.paths.root, "add", "--", `recognitions/${fileName}`, ".her/state.json");
			await git(this.paths.root, "commit", "-m", `memory: reflect recognition ${id}`);
			return { ran: true, ...(opts.ifDue ? { due } : {}), id, text: out };
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
		return this.withStoreLock(async () => {
			if (!this.model) throw new Error("consolidate requires a model");
			const model = this.model;
			const state = await readJson<{ cursor?: unknown; last_consolidate?: string | null }>(this.paths.stateFile, {});
			const cursor = parseConsolidateCursor(state.cursor ?? null);
			const batch = selectConsolidateBatch(await this.episodesSince(cursor), limit);
			const episodes = batch.map(({ episode }) => episode);
			if (episodes.length === 0) return { episodes: 0, notesTouched: 0, moments: 0 };

			const joined = batch.map(({ promptText }) => promptText).join("\n\n");
			const existing = await markdownStems(this.paths.semantic);
			const result = await completeJson<{
				notes?: Array<Record<string, unknown>>;
				moments?: Array<{ trigger?: string; shift?: string }>;
			}>(() => model.complete(consolidatePrompt(joined, existing)));
			const notes = result.notes ?? [];
			const moments = result.moments ?? [];
			const newCursor = advanceConsolidateCursor(cursor, episodes);

			for (const note of notes) await this.upsertNote(note);
			if (moments.length > 0) {
				const date = newCursor.ts.slice(0, 10);
				await appendText(
					this.paths.becoming,
					moments
						.map((moment) => `- ${date} · trigger: ${moment.trigger ?? ""} · shift: ${moment.shift ?? ""}\n`)
						.join(""),
				);
			}

			await writeJson(this.paths.stateFile, {
				...state,
				cursor: newCursor,
				last_consolidate: newCursor.ts,
			});
			return { episodes: episodes.length, notesTouched: notes.length, moments: moments.length };
		});
	}
	async backfill(opts: BackfillOptions = {}): Promise<BackfillRunResult> {
		return runBackfill(this, opts);
	}

	async synthesize(): Promise<string> {
		return this.withStoreLock(async () => {
			if (!this.model) throw new Error("synthesize requires a model");
			const current = (await readText(this.paths.contextFile)) ?? SEED_CONTEXT;
			const notes = await readMarkdownDir(this.paths.semantic);
			const moments = (await readText(this.paths.becoming)) ?? "";
			const facts = (await readText(this.paths.factsFile)) ?? "";
			const soul = (await readText(this.paths.soulFile)) ?? SEED_SOUL;
			const self = (await readText(this.paths.selfFile)) ?? SEED_SELF_NARRATIVE;
			const choiceModel = (await readText(this.paths.choiceModelFile)) ?? SEED_CHOICE_MODEL;
			const draft = await this.model.complete(
				synthesizePrompt(current, notes, moments, facts, soul, self, choiceModel),
				{
					strong: true,
				},
			);
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

	async buildTopicMaps(): Promise<string[]> {
		return this.withStoreLock(async () => {
			if (!this.model) throw new Error("buildTopicMaps requires a model");
			const model = this.model;
			const units = await this.noteSummaries();
			if (units.length === 0) return [];
			const lines = units.map((unit) => `- ${unit.key} (${unit.type}): ${unit.title}`).join("\n");
			const result = await completeJson<{ maps?: Array<{ theme?: string; summary?: string; members?: string[] }> }>(
				() => model.complete(topicMapPrompt(lines), { strong: true }),
			);
			const keyset = new Set(units.map((unit) => unit.key));
			const written: string[] = [];
			for (const map of result.maps ?? []) {
				if (!map.theme) continue;
				const key = slug(map.theme);
				const members = (map.members ?? []).map(slug).filter((member) => keyset.has(member));
				await writeText(
					join(this.paths.topics, `${key}.md`),
					`${frontmatter({ theme: map.theme, created: today(), members })}# ${map.theme}\n\n${map.summary ?? ""}\n\n## Units\n${members.map((member) => `- [[${member}]]`).join("\n")}\n`,
				);
				written.push(key);
			}
			return written;
		});
	}

	async generateIdeas(): Promise<Array<{ id: string; title: string; kind: string }>> {
		return this.withStoreLock(async () => {
			if (!this.model) throw new Error("generateIdeas requires a model");
			const model = this.model;
			const units = await this.noteSummaries();
			if (units.length === 0) return [];
			const unitLines = units.map((unit) => `- ${unit.key} (${unit.kind}/${unit.type}): ${unit.title}`).join("\n");
			const topicLines = (await this.topicSummaries()).join("\n") || "(none)";
			const existing = (await this.existingIdeaTitles()).join("\n") || "(none)";
			const result = await completeJson<{
				ideas?: Array<{
					title?: string;
					connects?: string[];
					insight?: string;
					spark?: string;
					kind?: string;
				}>;
			}>(() => model.complete(ideaEnginePrompt(unitLines, topicLines, existing), { strong: true }));
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

	async synthesizeChoiceModel(): Promise<ChoiceModelUpdateResult> {
		return this.withStoreLock(async () => {
			if (!this.model) throw new Error("synthesizeChoiceModel requires a model");
			const trails = await this.choiceModelJudgmentTrails();
			if (trails.length === 0) throw new Error("synthesizeChoiceModel requires Judgment Trail evidence");
			const current = (await readText(this.paths.choiceModelFile)) ?? SEED_CHOICE_MODEL;
			const evidence = trails.map((trail) => `${trail.ref}\n${trail.text}`).join("\n\n");
			const draft = await this.model.complete(choiceModelPrompt(current, evidence), { strong: true });
			const timestamp = new Date().toISOString();
			const id = genId(timestamp, "choice-model");
			await writeText(this.paths.choiceModelFile, draft);
			await appendText(
				this.choiceModelLogFile(),
				choiceModelLogBlock(
					id,
					timestamp,
					trails.map((trail) => trail.ref),
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
		return this.withStoreLock(async () => {
			if (!this.model) throw new Error("synthesizeSelfNarrative requires a model");
			const evidence = await this.selfNarrativeEvidence();
			if (!evidence.moments.trim() && evidence.recognitions.length === 0) {
				throw new Error("synthesizeSelfNarrative requires becoming moments or recognitions");
			}
			const current = (await readText(this.paths.selfFile)) ?? SEED_SELF_NARRATIVE;
			const context = (await readText(this.paths.contextFile)) ?? SEED_CONTEXT;
			const recognitionText = evidence.recognitions
				.map((recognition) => `${recognition.ref}\n${recognition.text}`)
				.join("\n\n");
			const draft = await this.model.complete(
				selfNarrativePrompt(current, context, evidence.moments, recognitionText),
				{ strong: true },
			);
			const timestamp = new Date().toISOString();
			const id = genId(timestamp, "self-narrative");
			const refs = [
				...(evidence.moments.trim() ? ["[[narrative/becoming-moments]]"] : []),
				...evidence.recognitions.map((recognition) => recognition.ref),
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

	private async episodesSince(
		cursor: ParsedConsolidateCursor | null,
	): Promise<Array<{ ts: string; id: string; cursorId: string; text: string }>> {
		const entries = await markdownEntries(this.paths.raw);
		const episodes: Array<{ ts: string; id: string; cursorId: string; text: string }> = [];
		for (const entry of entries) {
			if (!shouldReadRawEpisodeName(entry, cursor)) continue;
			const path = join(this.paths.raw, entry);
			const parsed = parseFrontmatter(await readText(path));
			if (parsed.data.protected_zone === true || parsed.data.consolidate === false) continue;
			const ts = String(parsed.data.timestamp ?? rawEpisodeTimestamp(entry));
			const cursorId = rawEpisodeIdFromName(entry);
			if (!shouldUseRawEpisode(ts, cursorId, cursor)) continue;
			episodes.push({
				ts,
				id: String(parsed.data.id ?? entry.replace(/\.md$/, "")),
				cursorId,
				text: parsed.body.trim(),
			});
		}
		return episodes.sort((a, b) => a.ts.localeCompare(b.ts));
	}
	private async upsertNote(note: Record<string, unknown>): Promise<void> {
		const key = slug(String(note.key ?? note.title ?? "note"));
		const path = join(this.paths.semantic, `${key}.md`);
		const existing = parseFrontmatter(await readText(path));
		const existingSources = Array.isArray(existing.data.sources) ? existing.data.sources.map(String) : [];
		const incomingSources = Array.isArray(note.sources) ? note.sources.map(String) : [];
		const sources = [...new Set([...existingSources, ...incomingSources])].sort();
		const type = typeof note.type === "string" && UNIT_TYPES.has(note.type) ? note.type : "note";
		const tier = normalizeActiveTier(note.tier, existing.data.tier);
		const relations = normalizeRelations(note);
		const fm = {
			key,
			type,
			tier,
			created: existing.data.created ?? today(),
			updated: today(),
			sources,
			relations,
		};
		const content = typeof note.content === "string" ? note.content : "";
		const relationBody =
			relations.length > 0
				? `\n\n## Relations\n${relations.map((relation) => `- ${relation.rel}: [[${relation.to}]]`).join("\n")}\n`
				: "\n";
		await writeText(path, `${frontmatter(fm)}${content.trimEnd()}${relationBody}`);
		for (const relation of relations) {
			if (relation.rel === "replaces") await this.markSemanticNoteSuperseded(relation.to, key);
		}
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
