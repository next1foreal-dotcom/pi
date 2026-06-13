export type { HerConfig } from "./config.ts";
export { DEFAULT_CONFIG, loadConfig, renderConfig } from "./config.ts";
export type {
	AuditCost,
	CostBucket,
	CostLedgerAuditEntry,
	CostReport,
	CostReportOptions,
	CostSummary,
	CostSummaryOptions,
} from "./cost-ledger.ts";
export { enforceDailyCostCap, summarizeAuditCosts, writeCostReport } from "./cost-ledger.ts";
export { createEmbeddingSearch } from "./embedding-search.ts";
export type {
	PathIntakeCollectOptions,
	PathIntakeOptions,
	PathIntakeResult,
	UrlIntakeOptions,
	UrlIntakeResult,
	UrlMarkdownReader,
	UrlMarkdownReadOptions,
	UrlMarkdownReadResult,
} from "./intake.ts";
export { collectPathIntakeFiles, readPathForWorldNote, readUrlForWorldNote } from "./intake.ts";
export type {
	LongTaskCheckpointOptions,
	LongTaskClaimOptions,
	LongTaskCompleteOptions,
	LongTaskRecord,
	LongTaskStartOptions,
	LongTaskStatus,
} from "./long-task.ts";
export {
	checkpointLongTask,
	claimNextLongTask,
	completeLongTask,
	listLongTasks,
	longTaskStatuses,
	startLongTask,
} from "./long-task.ts";
export type {
	CaptureMeta,
	ChoiceModelDomain,
	ChoiceModelUpdateResult,
	ClaimLedgerEntry,
	ConsolidateResult,
	DecaySweepOptions,
	DecaySweepResult,
	FeedbackFields,
	FeedbackResult,
	IdeaData,
	JudgmentFields,
	MemoryOptions,
	MemorySyncResult,
	MemorySyncStatus,
	RestoreArchivedSemanticOptions,
	RestoreArchivedSemanticResult,
	SamanthaZoneCategory,
	SamanthaZoneNoteInput,
	SamanthaZoneNoteResult,
	SelfNarrativeUpdateResult,
	SurfaceOptions,
	SynthesizeDueReason,
	SynthesizeDueResult,
	WorldNoteData,
} from "./memory.ts";
export { initStore, Memory, SEED_CHOICE_MODEL, SEED_CONTEXT, SEED_SELF_NARRATIVE, SEED_SOUL } from "./memory.ts";
export type { ModelLike } from "./model.ts";
export { FakeModel, OpenAICompatibleModel } from "./model.ts";
export { StorePaths } from "./paths.ts";
export type {
	MemoryClassificationRecord,
	MemoryClassificationResult,
	MemoryExportCheckResult,
	MemoryPrivacy,
	MemoryProvenance,
} from "./privacy.ts";
export {
	checkMemoryExport,
	classifyCapturePrivacy,
	classifyMemoryCorpus,
	defaultWorldPrivacy,
	memoryPrivacyLevels,
	memoryProvenanceValues,
	validateMemoryPrivacy,
	validateMemoryProvenance,
} from "./privacy.ts";
export {
	choiceModelPrompt,
	consolidatePrompt,
	ideaEnginePrompt,
	ingestPrompt,
	selfNarrativePrompt,
	summaryPrompt,
	surfacePrompt,
	synthesizePrompt,
	topicMapPrompt,
} from "./prompts.ts";
export type {
	HerProposalFeedback,
	HerProposalFeedbackVerdict,
	HerProposalMode,
	HerProposalRecord,
	HerProposalStats,
	HerProposalStatus,
	RecordHerProposalFeedbackOptions,
	RecordHerProposalOptions,
} from "./proposal.ts";
export {
	herProposalFeedbackVerdicts,
	herProposalStatuses,
	listHerProposals,
	recordHerProposal,
	recordHerProposalFeedback,
	summarizeHerProposalStats,
} from "./proposal.ts";
export type {
	ApplyMemoryRetractionOptions,
	MemoryRetractionCandidate,
	MemoryRetractionPlan,
	MemoryRetractionResult,
	PlanMemoryRetractionOptions,
} from "./retraction.ts";
export { applyMemoryRetraction, planMemoryRetraction } from "./retraction.ts";
export type { SearchBackend } from "./retrieval.ts";
export { frontmatter, parseFrontmatter, readJson, readText, writeJson, writeText } from "./store.ts";
export type {
	CreateHerTaskOptions,
	ExitCriterionResult,
	GateDecision,
	GateName,
	GateVerdict,
	HerTaskRecord,
	HerTaskStatus,
	HerTaskStep,
	HerTaskStepInput,
	HerTaskStepStatus,
	UpdateHerTaskOptions,
	UpdateHerTaskResult,
	VerifyStepInput,
} from "./task.ts";
export { createHerTask, herTaskStatuses, listHerTasks, updateHerTask, verifyStep } from "./task.ts";
export type {
	AttentionDigest,
	AttentionDigestOptions,
	AttentionItem,
	QueueTelegramInboundOptions,
	ScoredAttentionItem,
	TelegramMessage,
	TelegramQueueResult,
	TelegramUpdate,
	TelegramUser,
} from "./telegram.ts";
export { queueTelegramInbound, scoreAttentionItem, selectAttentionDigest } from "./telegram.ts";
