import type { HerConfig } from "./config.ts";
import type { ModelLike } from "./model.ts";
import type { MemoryPrivacy, MemoryProvenance } from "./privacy.ts";
import type { SearchBackend } from "./retrieval.ts";

export interface CaptureMeta {
	timestamp?: string;
	sessionId?: string;
	session_id?: string;
	project?: string;
	type?: string;
	/** Episodic modality tag (e.g. voice, glass) — written to raw frontmatter when set. */
	source?: string;
	/** G-156: who wrote this memory (fei | samantha | …). */
	authored_by?: string;
	/** G-156: which harness produced it (pi | claude-code | codex | voice | mcp | …). */
	harness?: string;
	/** G-156: optional run/tool/session reference. */
	source_ref?: string;
	capture_scope?: string;
	transcription_quality?: string;
	ref?: string;
	privacy?: MemoryPrivacy;
	provenance?: MemoryProvenance;
	/** her dispatch provenance (T5): which executor this capture was observed from. */
	executor?: string;
	/** her dispatch provenance (T5): handoff document path that drove the dispatch. */
	handoff?: string;
	/** her dispatch provenance (T5): dispatch long-task id, for cross-referencing the ledger. */
	dispatchId?: string;
}

export interface WorldNoteData {
	title: string;
	sourceUrl: string;
	sourceType: string;
	contentHash: string;
	memoryStatus: "active" | "archive_only" | "needs_deep_read";
	memoryStatusReason?: string;
	extracted: string;
	coverage: string;
	claims?: ClaimLedgerEntry[];
	read: string;
	steal: string[];
	connections: string[];
	take: string;
	possibleMoves: string[];
	privacy?: MemoryPrivacy;
	provenance?: MemoryProvenance;
	/** palate T1 (taste-card): board tags this taste belongs to; presence is what triggers frontmatter output. */
	boards?: string[];
	/** palate T1 (taste-card): Fei's half-sentence on this taste, appended (not overwritten) on repeat intake. */
	fei?: string;
	/** palate T1 (taste-card): where the original captured material lives, relative to the her-memory root. */
	snapshot?: WorldNoteSnapshot;
}

export interface WorldNoteSnapshot {
	text: string;
	screenshot: string | null;
	media: string[];
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

export type SamanthaZoneCategory = "journal" | "collection" | "wants" | "taste" | "projects" | "tools" | "dreams";

export type SamanthaJournalKind = "daily" | "weekly";

export interface SamanthaZoneNoteInput {
	category: SamanthaZoneCategory;
	title: string;
	content: string;
	source?: string;
}

export interface SamanthaZoneNoteResult {
	id: string;
	path: string;
}

export interface SamanthaJournalInput {
	kind: SamanthaJournalKind;
	content: string;
	runPath?: string;
	source?: string;
	timestamp?: string;
	title?: string;
}

export interface SamanthaJournalResult {
	id: string;
	kind: SamanthaJournalKind;
	path: string;
}

export interface SamanthaTasteJudgmentInput {
	differsFromFeiRule?: string;
	judgment: string;
	reason: string;
	source?: string;
	timestamp?: string;
	title: string;
}

export interface SamanthaTasteJudgmentResult extends SamanthaZoneNoteResult {}

export interface SurfaceOptions {
	query?: string;
	sessionId?: string;
	cooldownMinutes?: number;
}

export interface ReflectOptions {
	/** When true, skip the reflect pass entirely unless the reflect cadence (cadence.reflect_every_days) is due. */
	ifDue?: boolean;
}

export interface ReflectResult {
	/** Whether a reflect pass actually ran (false only when ifDue gated it out as not-due). */
	ran: boolean;
	/** Present only when ifDue was requested: whether the cadence considered this run due. */
	due?: boolean;
	/** Present when the model surfaced a non-obvious recognition (absent on a NONE reply). */
	id?: string;
	text?: string;
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

export type ChoiceModelDomain = "code-style" | "writing-style" | "design-taste" | "communication-tone";

export interface FeedbackFields {
	domain: ChoiceModelDomain;
	task: string;
	diffSummary: string;
	rule: string;
	weight?: number;
	at?: string;
}

export interface FeedbackResult {
	domain: ChoiceModelDomain;
	path: string;
	rule: string;
	weight: number;
	status: "active" | "stale";
}

export interface ChoiceRuleEvidence {
	at: string;
	task: string;
	diff_summary: string;
}

export interface ChoiceRuleRecord {
	id: string;
	rule: string;
	weight: number;
	first_recorded: string;
	last_triggered: string;
	status: "active" | "stale";
	evidence: ChoiceRuleEvidence[];
}

export interface MemorySyncResult {
	status: "clean" | "pushed" | "fast-forwarded";
	commit?: string;
	behind?: number;
}

export interface MemorySyncStatus {
	status: "synced" | "unsynced" | "unknown";
	dirtyFiles: number;
	aheadCommits: number;
	pending: number;
	branch?: string;
	lastSyncedAt?: string;
	lastSyncedAtError?: string;
	error?: string;
}

export interface MemoryOptions {
	config?: HerConfig;
	model?: ModelLike;
	semanticSearch?: SearchBackend;
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
