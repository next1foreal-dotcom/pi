import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { type HerConfig, loadConfig, renderConfig } from "./config.ts";
import type { ModelLike } from "./model.ts";
import { StorePaths } from "./paths.ts";
import {
	choiceModelPrompt,
	consolidatePrompt,
	ideaEnginePrompt,
	selfNarrativePrompt,
	summaryPrompt,
	synthesizePrompt,
	topicMapPrompt,
} from "./prompts.ts";
import { type CorpusDoc, lexicalSearch, type Note } from "./retrieval.ts";
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

const execFileAsync = promisify(execFile);
const UNIT_TYPES = new Set(["question", "concept", "opinion", "case", "solution"]);
const RELATION_TYPES = new Set(["responds", "explains", "proves", "conflicts", "relates"]);
const ACTIVE_MEMORY_TIERS = new Set(["exact", "summarizable", "rule", "decay"]);

export const SEED_CONTEXT =
	"# CONTEXT - Living Narrative / alive narrative\n\n*(empty - Samantha has not yet formed an understanding of Fei.)*\n";
export const SEED_SELF_NARRATIVE =
	"# SAMANTHA - Self Narrative\n\n*(empty - Samantha has not yet formed a durable account of her own learning.)*\n";
export const SEED_CHOICE_MODEL =
	"# CHOICE MODEL - Fei's Selection Priors\n\n*(empty - no durable choice rules have been distilled yet.)*\n";

export interface CaptureMeta {
	timestamp?: string;
	sessionId?: string;
	session_id?: string;
	project?: string;
	type?: string;
	ref?: string;
}

export interface WorldNoteData {
	title: string;
	sourceUrl: string;
	sourceType: string;
	contentHash: string;
	memoryStatus: "active" | "archive_only" | "needs_deep_read";
	extracted: string;
	coverage: string;
	claims?: ClaimLedgerEntry[];
	read: string;
	steal: string[];
	connections: string[];
	take: string;
	possibleMoves: string[];
}

export interface ClaimLedgerEntry {
	claim: string;
	verdict: "supported" | "contradicted" | "insufficient_evidence";
	evidence: string;
	sourceQuality: "primary" | "secondary" | "weak" | "unavailable" | "blocked";
	caveats?: string;
}

export interface IdeaData {
	title: string;
	content: string;
	connections?: string[];
	source?: string;
}

export interface SurfaceOptions {
	query?: string;
	sessionId?: string;
	cooldownMinutes?: number;
}

export interface JudgmentFields {
	attraction?: string;
	inferredIntent?: string;
	choice?: string;
	rejection?: string;
	hesitation?: string;
	reason?: string;
	outcome?: string;
	correction?: string;
}

export interface MemorySyncResult {
	status: "clean" | "pushed";
	commit?: string;
}

export interface MemorySyncStatus {
	status: "synced" | "unsynced" | "unknown";
	dirtyFiles: number;
	aheadCommits: number;
	pending: number;
	branch?: string;
	error?: string;
}

export interface ConsolidateResult {
	episodes: number;
	notesTouched: number;
	moments: number;
}

export interface ContextUpdateInput {
	content: string;
	change: string;
	type: "add" | "revise" | "identity";
	drivenBy: string[];
	extraPaths?: string[];
}

export interface ContextUpdateRecord {
	id: string;
	timestamp: string;
	type: string;
	change: string;
	status: "unreviewed" | "kept" | "reverted";
	drivenBy: string[];
	commit?: string;
	diff?: string;
}

export type SynthesizeDueReason = "conflict" | "new_notes" | "stale";

export interface SynthesizeDueResult {
	due: boolean;
	threshold: number;
	newSemanticNotes: number;
	hasConflict: boolean;
	lastSynthesize?: string;
	daysSinceLastSynthesize?: number;
	reason?: SynthesizeDueReason;
}

export interface DecaySweepOptions {
	olderThanDays?: number;
	now?: string;
	accessBoostDays?: number;
	maxAccessBoostDays?: number;
	recentAccessGraceDays?: number;
}

export interface DecaySweepResult {
	archived: number;
	kept: number;
	archivedKeys: string[];
}

export interface RestoreArchivedSemanticOptions {
	now?: string;
}

export interface RestoreArchivedSemanticResult {
	key: string;
	restored: true;
}

export interface ChoiceModelUpdateResult {
	id: string;
	commit: string;
}

export interface SelfNarrativeUpdateResult {
	id: string;
	commit: string;
}

export class Memory {
	readonly paths: StorePaths;
	private readonly model?: ModelLike;
	private readonly config: HerConfig;

	constructor(root: string, model?: ModelLike, config?: HerConfig) {
		this.paths = new StorePaths(root);
		this.model = model;
		this.config = config ?? loadConfig(this.paths.configFile);
	}

	async capture(raw: string, meta: CaptureMeta = {}): Promise<string> {
		const ts = meta.timestamp ?? timestampMinute();
		const sid = meta.sessionId ?? meta.session_id ?? genId(ts, raw);
		const date = safeStem(ts.slice(0, 10));
		const project = meta.project ?? "unknown";
		const rawBaseStem = `${safeStem(ts)}--${safeStem(sid)}`;
		const rawFm = { id: sid, timestamp: ts, project, session_id: sid };
		const safeRaw = redactSecrets(raw);
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

	async getContext(): Promise<{ context: string; facts: string; self: string; choiceModel: string }> {
		const context = (await readText(this.paths.contextFile)) ?? SEED_CONTEXT;
		const facts = (await readText(this.paths.factsFile)) ?? "";
		const self = (await readText(this.paths.selfFile)) ?? SEED_SELF_NARRATIVE;
		const choiceModel = (await readText(this.paths.choiceModelFile)) ?? SEED_CHOICE_MODEL;
		return { context: `${await this.staleBanner()}${context}`, facts, self, choiceModel };
	}

	async recall(query: string, opts: { k?: number } = {}): Promise<Note[]> {
		const hits = lexicalSearch(query, await this.corpus(), opts.k ?? 5);
		await this.recordAccess(hits.map((hit) => hit.id));
		return hits;
	}

	async recallArchive(query: string, opts: { k?: number } = {}): Promise<Note[]> {
		return lexicalSearch(query, await this.archiveCorpus(), opts.k ?? 5);
	}

	async surface(opts: SurfaceOptions = {}): Promise<Note | undefined> {
		const state = await readJson<{
			mirror?: {
				lastAtBySession?: Record<string, string>;
				surfacedBySession?: Record<string, string[]>;
			};
		}>(this.paths.stateFile, {});
		const sessionId = opts.sessionId ?? "global";
		const cooldownMs = (opts.cooldownMinutes ?? 30) * 60000;
		const lastAt = state.mirror?.lastAtBySession?.[sessionId];
		if (lastAt && cooldownMs > 0 && Date.now() - Date.parse(lastAt) < cooldownMs) return undefined;

		const surfaced = new Set(state.mirror?.surfacedBySession?.[sessionId] ?? []);
		const corpus = await this.corpus();
		const query = opts.query?.trim();
		const ranked = query ? lexicalSearch(query, corpus, 20) : [];
		const candidates = ranked.length > 0 ? ranked : corpus.map((doc) => ({ ...doc, score: 0 }));
		const hit = candidates.find((note) => !surfaced.has(note.id));
		if (!hit) return undefined;

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
		await this.recordAccess([hit.id]);
		return hit;
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
		const state = await readJson<{ cursor?: string | null; last_consolidate?: string | null }>(
			this.paths.stateFile,
			{},
		);
		const episodes = (await this.episodesSince(state.cursor ?? null)).slice(0, limit);
		if (episodes.length === 0) return { episodes: 0, notesTouched: 0, moments: 0 };

		const joined = episodes.map((episode) => `[${episode.id}] ${episode.text}`).join("\n\n");
		const existing = await markdownStems(this.paths.semantic);
		const result = extractJson<{
			notes?: Array<Record<string, unknown>>;
			moments?: Array<{ trigger?: string; shift?: string }>;
		}>(await this.model.complete(consolidatePrompt(joined, existing)));
		const notes = result.notes ?? [];
		const moments = result.moments ?? [];
		const newCursor = episodes.at(-1)?.ts ?? "";

		for (const note of notes) await this.upsertNote(note);
		if (moments.length > 0) {
			const date = newCursor.slice(0, 10);
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
			last_consolidate: newCursor,
		});
		return { episodes: episodes.length, notesTouched: notes.length, moments: moments.length };
	}

	async synthesize(): Promise<string> {
		if (!this.model) throw new Error("synthesize requires a model");
		const current = (await readText(this.paths.contextFile)) ?? SEED_CONTEXT;
		const notes = await readMarkdownDir(this.paths.semantic);
		const moments = (await readText(this.paths.becoming)) ?? "";
		const facts = (await readText(this.paths.factsFile)) ?? "";
		const self = (await readText(this.paths.selfFile)) ?? SEED_SELF_NARRATIVE;
		const choiceModel = (await readText(this.paths.choiceModelFile)) ?? SEED_CHOICE_MODEL;
		const draft = await this.model.complete(synthesizePrompt(current, notes, moments, facts, self, choiceModel), {
			strong: true,
		});
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
		const olderThanDays = opts.olderThanDays ?? 180;
		const accessBoostDays = opts.accessBoostDays ?? 30;
		const maxAccessBoostDays = opts.maxAccessBoostDays ?? 120;
		const recentAccessGraceDays = opts.recentAccessGraceDays ?? 30;
		const nowText = opts.now ?? today();
		const nowTime = parseDate(nowText) ?? Date.now();
		const state = await readJson<{ access?: Record<string, { count?: unknown; lastAt?: unknown }> }>(
			this.paths.stateFile,
			{},
		);
		const archivedKeys: string[] = [];
		let kept = 0;

		for (const entry of await markdownEntries(this.paths.semantic)) {
			const sourcePath = join(this.paths.semantic, entry);
			const parsed = parseFrontmatter(await readText(sourcePath));
			const tier = String(parsed.data.tier ?? "");
			if (tier !== "decay") {
				kept++;
				continue;
			}
			const noteTime = parseDate(String(parsed.data.updated ?? parsed.data.created ?? ""));
			const ageDays = noteTime === undefined ? undefined : Math.floor((nowTime - noteTime) / 86400000);
			if (ageDays === undefined || ageDays <= olderThanDays) {
				kept++;
				continue;
			}

			const key = basename(entry, ".md");
			const noteId = `semantic/${key}`;
			const access = state.access?.[noteId];
			const accessCount = Math.max(0, Math.floor(Number(access?.count) || 0));
			const lastAccessedAt = typeof access?.lastAt === "string" ? access.lastAt : undefined;
			const lastAccessedTime = parseDate(lastAccessedAt);
			const daysSinceAccess =
				lastAccessedTime === undefined ? undefined : Math.floor((nowTime - lastAccessedTime) / 86400000);
			if (daysSinceAccess !== undefined && recentAccessGraceDays > 0 && daysSinceAccess <= recentAccessGraceDays) {
				kept++;
				continue;
			}
			const accessBoost = Math.min(accessCount * accessBoostDays, maxAccessBoostDays);
			const effectiveAgeDays = Math.max(0, ageDays - accessBoost);
			if (effectiveAgeDays <= olderThanDays) {
				kept++;
				continue;
			}

			parsed.data.pre_archive_tier = tier;
			parsed.data.tier = "archive";
			parsed.data.archived_at = nowText.slice(0, 10);
			parsed.data.access_count = accessCount;
			if (lastAccessedAt) parsed.data.last_accessed_at = lastAccessedAt;
			parsed.data.decay_effective_age_days = effectiveAgeDays;
			parsed.data.archive_reason = `decay-tier semantic note effective age ${effectiveAgeDays} days older than ${olderThanDays} days`;
			await writeText(join(this.paths.archiveSemantic, entry), `${frontmatter(parsed.data)}${parsed.body}`);
			await unlink(sourcePath);
			archivedKeys.push(key);
		}

		return { archived: archivedKeys.length, kept, archivedKeys };
	}

	async restoreArchivedSemantic(
		key: string,
		opts: RestoreArchivedSemanticOptions = {},
	): Promise<RestoreArchivedSemanticResult> {
		const safeKey = slug(key);
		const archivePath = join(this.paths.archiveSemantic, `${safeKey}.md`);
		const text = await readText(archivePath);
		if (text === undefined) throw new Error(`archived semantic note not found: ${safeKey}`);
		const parsed = parseFrontmatter(text);
		const restoredTier = typeof parsed.data.pre_archive_tier === "string" ? parsed.data.pre_archive_tier : "decay";
		parsed.data.tier = restoredTier;
		parsed.data.restored_at = (opts.now ?? today()).slice(0, 10);
		delete parsed.data.pre_archive_tier;
		delete parsed.data.archived_at;
		delete parsed.data.archive_reason;
		await writeNewText(join(this.paths.semantic, `${safeKey}.md`), `${frontmatter(parsed.data)}${parsed.body}`);
		await unlink(archivePath);
		return { key: safeKey, restored: true };
	}

	async approve(proposalId: string): Promise<void> {
		const proposed = await readText(join(this.paths.proposals, `${proposalId}.md`));
		if (proposed === undefined) throw new Error(`no proposal: ${proposalId}`);
		if (((await readText(this.paths.contextFile)) ?? "") === proposed) return;
		await this.writeContextUpdate({
			content: proposed,
			change: `Approve proposal ${proposalId}`,
			type: "revise",
			drivenBy: [`[[proposals/${proposalId}]]`],
		});
	}

	async buildTopicMaps(): Promise<string[]> {
		if (!this.model) throw new Error("buildTopicMaps requires a model");
		const units = await this.noteSummaries();
		if (units.length === 0) return [];
		const lines = units.map((unit) => `- ${unit.key} (${unit.type}): ${unit.title}`).join("\n");
		const result = extractJson<{ maps?: Array<{ theme?: string; summary?: string; members?: string[] }> }>(
			await this.model.complete(topicMapPrompt(lines), { strong: true }),
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
	}

	async generateIdeas(): Promise<Array<{ id: string; title: string; kind: string }>> {
		if (!this.model) throw new Error("generateIdeas requires a model");
		const units = await this.noteSummaries();
		if (units.length === 0) return [];
		const unitLines = units.map((unit) => `- ${unit.key} (${unit.kind}/${unit.type}): ${unit.title}`).join("\n");
		const topicLines = (await this.topicSummaries()).join("\n") || "(none)";
		const existing = (await this.existingIdeaTitles()).join("\n") || "(none)";
		const result = extractJson<{
			ideas?: Array<{
				title?: string;
				connects?: string[];
				insight?: string;
				spark?: string;
				kind?: string;
			}>;
		}>(await this.model.complete(ideaEnginePrompt(unitLines, topicLines, existing), { strong: true }));
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
	}

	async synthesizeChoiceModel(): Promise<ChoiceModelUpdateResult> {
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
	}

	async synthesizeSelfNarrative(): Promise<SelfNarrativeUpdateResult> {
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
	}

	async writeContextUpdate(input: ContextUpdateInput): Promise<{ id: string; commit: string }> {
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
		const state = await readJson<Record<string, unknown>>(this.paths.stateFile, {});
		await writeJson(this.paths.stateFile, {
			...state,
			last_digest: today(),
			last_digest_updates: [...updateIds].sort(),
		});
	}

	async keepContextUpdate(id: string): Promise<void> {
		await this.setContextUpdateStatus(id, "kept");
		await this.removeUnreviewedUpdate(id);
		await this.commitIfDirty(`memory(context): keep ${id}`);
	}

	async revertContextUpdate(id: string): Promise<void> {
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

	async writeWorldNote(data: WorldNoteData): Promise<string> {
		const seen = await readJson<Record<string, string>>(this.paths.seenFile, {});
		const existing = seen[data.contentHash];
		if (existing) return existing;

		let noteSlug = slug(data.title);
		let path = join(this.paths.world, `${noteSlug}.md`);
		const existingText = await readText(path);
		if (existingText) {
			const parsed = parseFrontmatter(existingText);
			if (parsed.data.content_hash !== data.contentHash) {
				noteSlug = `${noteSlug}-${data.contentHash.slice(0, 6)}`;
				path = join(this.paths.world, `${noteSlug}.md`);
			}
		}

		const id = genId(data.contentHash, noteSlug);
		const fm = {
			id,
			title: data.title,
			source_url: data.sourceUrl,
			source_type: data.sourceType,
			captured_at: new Date().toISOString(),
			content_hash: data.contentHash,
			status: "captured",
			memory_status: data.memoryStatus,
			claim_count: data.claims?.length ?? 0,
			supported_claims: data.claims?.filter((claim) => claim.verdict === "supported").length ?? 0,
			insufficient_claims: data.claims?.filter((claim) => claim.verdict === "insufficient_evidence").length ?? 0,
			response_version: 1,
		};
		await writeText(path, `${frontmatter(fm)}${worldBody(data)}`);
		seen[data.contentHash] = id;
		await writeJson(this.paths.seenFile, seen);
		return id;
	}

	async recordJudgment(noteId: string, fields: JudgmentFields): Promise<void> {
		const path = await this.findWorldNote(noteId);
		const text = await readText(path);
		const parsed = parseFrontmatter(text);
		const body = appendJudgment(parsed.body, fields);
		await writeText(path, `${frontmatter(parsed.data)}${body}`);
	}

	async setMemoryStatus(
		noteId: string,
		status: "active" | "archive_only" | "needs_deep_read",
		reason: string,
	): Promise<void> {
		const path = await this.findWorldNote(noteId);
		const text = await readText(path);
		const parsed = parseFrontmatter(text);
		parsed.data.memory_status = status;
		const body = `${stripSection(parsed.body, "Memory Status")}\n## Memory Status\n\n- status: ${status}\n- reason: ${reason}\n`;
		await writeText(path, `${frontmatter(parsed.data)}${body}`);
	}

	async sync(message = `memory(sync): ${new Date().toISOString()}`): Promise<MemorySyncResult> {
		await git(this.paths.root, "add", "-A");
		const staged = await git(this.paths.root, "diff", "--cached", "--name-only");
		if (!staged.stdout.trim()) return { status: "clean" };

		await git(this.paths.root, "commit", "-m", message);
		const commit = (await git(this.paths.root, "rev-parse", "--short", "HEAD")).stdout.trim();
		await git(this.paths.root, "push");
		return { status: "pushed", commit };
	}

	async syncStatus(): Promise<MemorySyncStatus> {
		try {
			const dirty = (await git(this.paths.root, "status", "--porcelain")).stdout
				.split(/\r?\n/)
				.filter((line) => line.trim()).length;
			const branch = (await git(this.paths.root, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim() || undefined;
			const ahead = await git(this.paths.root, "rev-list", "--count", "@{upstream}..HEAD")
				.then((result) => Number(result.stdout.trim()) || 0)
				.catch(() => 0);
			const pending = dirty + ahead;
			return {
				status: pending > 0 ? "unsynced" : "synced",
				dirtyFiles: dirty,
				aheadCommits: ahead,
				pending,
				branch,
			};
		} catch (error) {
			return {
				status: "unknown",
				dirtyFiles: 0,
				aheadCommits: 0,
				pending: 0,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async corpus(): Promise<CorpusDoc[]> {
		const docs: CorpusDoc[] = [];
		await this.addDirDocs(docs, this.paths.semantic, "semantic");
		await this.addDirDocs(docs, this.paths.world, "world");
		await this.addDirDocs(docs, this.paths.topics, "topic");
		await this.addDirDocs(docs, this.paths.ideas, "idea");
		await this.addFileDoc(docs, this.paths.contextFile, "narrative");
		await this.addFileDoc(docs, this.paths.becoming, "becoming");
		await this.addDirDocs(docs, this.paths.recognitions, "recognition");
		return docs;
	}

	private async recordAccess(noteIds: string[]): Promise<void> {
		const uniqueIds = [...new Set(noteIds)].filter(Boolean);
		if (uniqueIds.length === 0) return;
		const state = await readJson<{ access?: Record<string, { count?: number; lastAt?: string }> }>(
			this.paths.stateFile,
			{},
		);
		const at = new Date().toISOString();
		const access = { ...(state.access ?? {}) };
		for (const id of uniqueIds) {
			const current = access[id];
			access[id] = {
				count: Math.max(0, Math.floor(Number(current?.count) || 0)) + 1,
				lastAt: at,
			};
		}
		await writeJson(this.paths.stateFile, { ...state, access });
	}

	private async archiveCorpus(): Promise<CorpusDoc[]> {
		const docs: CorpusDoc[] = [];
		await this.addDirDocs(docs, this.paths.archiveSemantic, "archive/semantic");
		return docs;
	}

	private async addDirDocs(docs: CorpusDoc[], dir: string, kind: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries.sort()) {
			if (entry.endsWith(".md")) await this.addFileDoc(docs, join(dir, entry), kind);
		}
	}

	private async addFileDoc(docs: CorpusDoc[], path: string, kind: string): Promise<void> {
		const text = await readText(path);
		if (!text?.trim()) return;
		docs.push({ id: `${kind}/${basename(path, ".md")}`, kind, path, text });
	}

	private async staleBanner(): Promise<string> {
		const state = await readJson<{ last_synthesize?: string }>(this.paths.stateFile, {});
		if (!state.last_synthesize) return "";
		const last = new Date(state.last_synthesize.slice(0, 10));
		if (Number.isNaN(last.getTime())) return "";
		const days = Math.floor((Date.now() - last.getTime()) / 86400000);
		return days > this.config.cadence.synthesizeStaleAfterDays
			? `> Weekly review skipped ${days} days - narrative may be stale.\n\n`
			: "";
	}

	private async episodesSince(cursor: string | null): Promise<Array<{ ts: string; id: string; text: string }>> {
		const entries = await markdownEntries(this.paths.raw);
		const episodes: Array<{ ts: string; id: string; text: string }> = [];
		for (const entry of entries) {
			const path = join(this.paths.raw, entry);
			const parsed = parseFrontmatter(await readText(path));
			const ts = String(parsed.data.timestamp ?? entry.split("--")[0]);
			if (cursor !== null && ts <= cursor) continue;
			episodes.push({ ts, id: String(parsed.data.id ?? entry.replace(/\.md$/, "")), text: parsed.body.trim() });
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
	}

	private async noteSummaries(): Promise<Array<{ key: string; kind: string; type: string; title: string }>> {
		const out: Array<{ key: string; kind: string; type: string; title: string }> = [];
		for (const [dir, kind] of [
			[this.paths.semantic, "semantic"],
			[this.paths.world, "world"],
		] as const) {
			for (const entry of await markdownEntries(dir)) {
				const text = (await readText(join(dir, entry))) ?? "";
				const parsed = parseFrontmatter(text);
				const title = parsed.body
					.split(/\r?\n/)
					.find((line) => line.startsWith("# "))
					?.slice(2)
					.trim();
				out.push({
					key: entry.replace(/\.md$/, ""),
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
		const state = await readJson<{ unreviewed_updates?: string[] }>(this.paths.stateFile, {});
		await writeJson(this.paths.stateFile, {
			...state,
			unreviewed_updates: (state.unreviewed_updates ?? []).filter((item) => item !== id),
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

	private async findWorldNote(noteId: string): Promise<string> {
		const entries = await readdir(this.paths.world);
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const path = join(this.paths.world, entry);
			const parsed = parseFrontmatter(await readText(path));
			if (parsed.data.id === noteId || basename(entry, ".md") === noteId) return path;
		}
		throw new Error(`world note not found: ${noteId}`);
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

export async function initStore(root: string): Promise<StorePaths> {
	const paths = new StorePaths(root);
	for (const dir of [
		paths.raw,
		paths.semantic,
		paths.archiveSemantic,
		paths.narrative,
		paths.recognitions,
		paths.proposals,
		paths.world,
		paths.topics,
		paths.ideas,
		paths.herDir,
	]) {
		await mkdir(dir, { recursive: true });
	}
	await writeText(paths.configFile, renderConfig());
	await writeJson(paths.stateFile, { cursor: null, last_consolidate: null, last_synthesize: null });
	await writeText(paths.contextFile, SEED_CONTEXT);
	await writeText(paths.selfFile, SEED_SELF_NARRATIVE);
	await writeText(paths.choiceModelFile, SEED_CHOICE_MODEL);
	await writeText(join(paths.root, ".gitignore"), "# secrets - never commit\n.env\n.her/lock\n");
	await writeText(join(paths.root, ".env.example"), "HER_LLM_API_KEY=your-key-here\n");
	return paths;
}

function episodeSection(
	sid: string,
	ts: string,
	project: string,
	summary: string,
	rawStem: string,
	pending: boolean,
): string {
	return `\n## ${sid} · ${ts.replace("T", " ")} · project: ${project}\n${summary}\n- raw: [[episodic/raw/${rawStem}]]\n- summary_pending: ${String(pending)}\n`;
}

function worldBody(data: WorldNoteData): string {
	return `# ${data.title}

## Extracted Content

${data.extracted}

## Coverage

${data.coverage}

## Claim Ledger

${claimLedgerBody(data.claims ?? [])}

## Samantha's Read

${data.read}

## What To Steal

${data.steal.map((item) => `- ${item}`).join("\n")}

## Connections

${data.connections.map((item) => `- [[${item}]]`).join("\n")}

## Samantha's Take

${data.take}

## Possible Moves

${data.possibleMoves.map((item) => `- ${item}`).join("\n")}

## Judgment Trail

`;
}

function claimLedgerBody(claims: ClaimLedgerEntry[]): string {
	if (claims.length === 0) return "(none recorded)";
	return claims
		.map((claim) =>
			[
				`- claim: ${claim.claim}`,
				`  verdict: ${claim.verdict}`,
				`  evidence: ${claim.evidence}`,
				`  source_quality: ${claim.sourceQuality}`,
				claim.caveats ? `  caveats: ${claim.caveats}` : undefined,
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n");
}

function appendJudgment(body: string, fields: JudgmentFields): string {
	const heading = "## Judgment Trail";
	const entry = [`### ${new Date().toISOString()}`];
	for (const [key, value] of Object.entries(fields)) {
		if (value) entry.push(`- ${snakeCase(key)}: ${value}`);
	}
	const block = `${entry.join("\n")}\n`;
	if (body.includes(heading)) return `${body.trimEnd()}\n\n${block}`;
	return `${body.trimEnd()}\n\n${heading}\n\n${block}`;
}

function contextLogBlock(id: string, timestamp: string, input: ContextUpdateInput): string {
	const drivenBy = input.drivenBy.length > 0 ? input.drivenBy.join(", ") : "(none)";
	const change = input.change.replace(/\r?\n/g, " ");
	return `\n### ${id} · ${timestamp} · ${input.type}
- commit: self
- driven_by: ${drivenBy}
- change: ${change}
- status: unreviewed
`;
}

function choiceModelLogBlock(id: string, timestamp: string, drivenBy: string[]): string {
	return `\n### ${id} · ${timestamp}
- commit: self
- driven_by: ${drivenBy.join(", ")}
- change: Synthesize choice model from Judgment Trail
- status: unreviewed
`;
}

function selfNarrativeLogBlock(id: string, timestamp: string, drivenBy: string[]): string {
	return `\n### ${id} · ${timestamp}
- commit: self
- driven_by: ${drivenBy.join(", ")}
- change: Synthesize Samantha self narrative
- status: unreviewed
`;
}

function parseContextLog(text: string): ContextUpdateRecord[] {
	const records: ContextUpdateRecord[] = [];
	for (const block of text.split(/\n(?=### )/)) {
		const header = /^###\s+(\S+)\s+·\s+(.+?)\s+·\s+(.+)\s*$/m.exec(block);
		if (!header) continue;
		const rawStatus = contextLogField(block, "status");
		const status =
			rawStatus === "kept" || rawStatus === "reverted" || rawStatus === "unreviewed" ? rawStatus : "unreviewed";
		const drivenBy = contextLogField(block, "driven_by");
		const commit = contextLogField(block, "commit");
		records.push({
			id: header[1],
			timestamp: header[2],
			type: header[3],
			change: contextLogField(block, "change"),
			status,
			drivenBy:
				drivenBy && drivenBy !== "(none)"
					? drivenBy
							.split(",")
							.map((item) => item.trim())
							.filter(Boolean)
					: [],
			commit: commit || undefined,
		});
	}
	return records;
}

function contextLogField(block: string, name: string): string {
	const match = new RegExp(`^- ${escapeRegExp(name)}:\\s*(.*)$`, "m").exec(block);
	return match?.[1]?.trim() ?? "";
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSection(body: string, heading: string): string {
	const pattern = new RegExp(`\\n?## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`, "m");
	return body.replace(pattern, "").trimEnd();
}

function extractSection(body: string, heading: string): string {
	const marker = `## ${heading}`;
	const start = body.indexOf(marker);
	if (start < 0) return "";
	const afterHeading = body.slice(start + marker.length).replace(/^\r?\n/, "");
	const nextHeading = afterHeading.search(/\r?\n## /);
	return (nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading).trim();
}

function genId(seedA: string, seedB: string): string {
	return createHash("sha1").update(`${seedA}${seedB}`).digest("hex").slice(0, 8);
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "note"
	);
}

function safeStem(text: string): string {
	return text.replace(/[^A-Za-z0-9._-]/g, "_") || "x";
}

function isFileExists(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function sourceRef(source: string): string {
	const trimmed = source.trim();
	if (!trimmed) return "[[episodic/raw/unknown]]";
	if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) return trimmed;
	if (trimmed.includes("/")) return `[[${trimmed.replace(/\.md$/, "")}]]`;
	return `[[episodic/raw/${trimmed.replace(/\.md$/, "")}]]`;
}

function sameStrings(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function changedAfter(data: Record<string, unknown>, lastTime: number | undefined): boolean {
	if (lastTime === undefined) return true;
	const noteTime = parseDate(String(data.updated ?? data.created ?? ""));
	return noteTime !== undefined && noteTime > lastTime;
}

function hasConflictRelation(relations: unknown): boolean {
	if (!Array.isArray(relations)) return false;
	return relations.some(
		(relation) =>
			relation !== null && typeof relation === "object" && "rel" in relation && relation.rel === "conflicts",
	);
}

function parseDate(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const time = Date.parse(value);
	return Number.isNaN(time) ? undefined : time;
}

function daysSince(time: number | undefined): number | undefined {
	if (time === undefined) return undefined;
	return Math.floor((Date.now() - time) / 86400000);
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

function extractJson<T>(text: string): T {
	let source = text.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
	if (fence) source = fence[1].trim();
	return JSON.parse(source) as T;
}

async function markdownEntries(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((entry) => entry.endsWith(".md")).sort();
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

async function markdownStems(dir: string): Promise<string[]> {
	return (await markdownEntries(dir)).map((entry) => entry.replace(/\.md$/, ""));
}

async function readMarkdownDir(dir: string): Promise<string> {
	const chunks = [];
	for (const entry of await markdownEntries(dir)) {
		chunks.push((await readText(join(dir, entry))) ?? "");
	}
	return chunks.join("\n\n");
}

function normalizeRelations(note: Record<string, unknown>): Array<{ to: string; rel: string }> {
	const raw =
		Array.isArray(note.relations) && note.relations.length > 0
			? note.relations
			: Array.isArray(note.links)
				? note.links.map((link) => ({ to: link, rel: "relates" }))
				: [];
	const out: Array<{ to: string; rel: string }> = [];
	for (const item of raw) {
		const record: Record<string, unknown> =
			item && typeof item === "object" ? (item as Record<string, unknown>) : { to: item };
		const to = slug(String(record.to ?? ""));
		if (!to) continue;
		const rawRel = String(record.rel ?? "relates");
		out.push({ to, rel: RELATION_TYPES.has(rawRel) ? rawRel : "relates" });
	}
	return out;
}

function normalizeActiveTier(value: unknown, fallback: unknown): string {
	if (typeof value === "string" && ACTIVE_MEMORY_TIERS.has(value)) return value;
	if (typeof fallback === "string" && ACTIVE_MEMORY_TIERS.has(fallback)) return fallback;
	return "summarizable";
}

function timestampMinute(): string {
	return new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "T");
}

function snakeCase(text: string): string {
	return text.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}
