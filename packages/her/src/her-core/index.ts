export {
	DEFAULT_PUBLISH_CONFIG,
	DEFAULT_TASKS_CONFIG,
	type HerRuntimeConfig,
	loadRuntimeConfig,
	type PublishConfig,
	parseTasksPublish,
	type TasksConfig,
} from "./bg-task-config.ts";
export {
	DEFAULT_LOG_TRUNCATE,
	type LogTruncateConfig,
	truncateLogBuffer,
	truncateTaskLogIfNeeded,
} from "./bg-task-log.ts";
export { enqueueTaskTelegramNotices, formatBgTaskStatusBoard } from "./bg-task-notify.ts";
export { herTaskOutput, readLogChunk, type TaskOutputChunk } from "./bg-task-output.ts";
export {
	formatWakeMessage,
	type ReconcileOptions,
	reconcileBgTasks,
	type WakeEvent,
} from "./bg-task-reconcile.ts";
export {
	type BgTaskRecord,
	type BgTaskStatus,
	createPendingRecord,
	formatDisplayStatus,
	isTerminal,
	loadBgTask,
	migrateBgStatus,
	newTaskId,
	parseBgTaskMarkdown,
	saveBgTask,
	serializeBgTask,
	taskMdPath,
	tasksDir,
} from "./bg-task-record.ts";
export { purgeExpiredTaskArtifacts, type RetentionPurge } from "./bg-task-retention.ts";
export {
	type BgTaskListItem,
	listBgTasks,
	type SpawnBgTaskInput,
	type SpawnBgTaskResult,
	spawnBgTask,
	stopBgTask,
} from "./bg-task-spawn.ts";
export type { HerConfig } from "./config.ts";
export { DEFAULT_CONFIG, loadConfig, renderConfig } from "./config.ts";
export type {
	AuditCost,
	CostBreakdown,
	CostBreakdownOptions,
	CostBucket,
	CostDayBucket,
	CostLedgerAuditEntry,
	CostProviderBucket,
	CostReport,
	CostReportOptions,
	CostSummary,
	CostSummaryOptions,
} from "./cost-ledger.ts";
export { enforceDailyCostCap, summarizeAuditCosts, summarizeCostBreakdown, writeCostReport } from "./cost-ledger.ts";
export type { Agent, AgentFunction, AgentOptions, AgentSandbox, JsonSchema } from "./deer-agent-types.ts";
export { bindAgent } from "./deer-agent-types.ts";
export {
	createDeerAgentFromEnv,
	FakeDeerAgent,
	SamanthaAgent,
	type SamanthaAgentConfig,
	type SamanthaAgentSpawnFn,
} from "./deer-samantha-agent.ts";
export {
	applyDeerWorkflowEvent,
	createDeerBridgeState,
	DEER_RUN_KIND,
	DEER_RUN_SOURCE,
	type DeerBridgePatch,
	type DeerBridgeState,
	type DeerWorkflowEvent,
	defaultDeerRunId,
	parseDeerWorkflowLine,
} from "./deer-workflow-bridge.ts";
export type {
	DelegatedOperation,
	DelegationDecision,
	DelegationTier,
	IncidentLevel,
	TrustEvent,
	TrustIncidentAction,
	TrustUpgradeProposal,
} from "./delegation.ts";
export {
	classifyDelegatedOperation,
	delegationTiers,
	downgradeAfterIncident,
	incidentLevels,
	proposeTrustUpgrade,
} from "./delegation.ts";
export type {
	DispatchAuditEntry,
	DispatchExecutorKind,
	DispatchExecutorResult,
	DispatchOptions,
	DispatchResult,
	DispatchStatus,
	ParsedExecutor,
	SpawnExecutorFn,
} from "./dispatch.ts";
export {
	DISPATCH_GROUND_RULES,
	estimateUsdFromNdjson,
	normalizeDispatchPath,
	parseExecutor,
	resolvePiCliPath,
	runDispatch,
} from "./dispatch.ts";
export { createEmbeddingSearch } from "./embedding-search.ts";
export type { EvalTrendPoint, EvalTrendReport, TrendDirection } from "./eval-trend.ts";
export { computeEvalTrend, renderEvalTrendReport, runEvalTrend } from "./eval-trend.ts";
export type {
	GoldenEvalAlert,
	GoldenEvalCategory,
	GoldenEvalCategorySummary,
	GoldenEvalFixture,
	GoldenEvalItemResult,
	GoldenEvalReport,
	GoldenEvalScore,
	RunGoldenEvalOptions,
} from "./evals.ts";
export { goldenEvalCategories, runGoldenEvals } from "./evals.ts";
export {
	ensurePublishServer,
	herPublish,
	type PublishResult,
	publishedDir,
	slugifyTitle,
	stopPublishServer,
	wrapPublishedHtml,
} from "./her-publish.ts";
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
export {
	assertPubliclyFetchableUrl,
	collectPathIntakeFiles,
	readPathForWorldNote,
	readUrlForWorldNote,
} from "./intake.ts";
export type { MemoryLintBrokenLink, MemoryLintOrphan, MemoryLintReport, MemoryLintSupersessionIssue } from "./lint.ts";
export { renderMemoryLintReport, runMemoryLint } from "./lint.ts";
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
	GetContextOptions,
	GetContextPriorOptions,
	IdeaData,
	JudgmentFields,
	MemoryContext,
	MemoryOptions,
	MemorySyncResult,
	MemorySyncStatus,
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
} from "./memory.ts";
export { initStore, Memory, SEED_CHOICE_MODEL, SEED_CONTEXT, SEED_SELF_NARRATIVE, SEED_SOUL } from "./memory.ts";
export type {
	BackfillBatchResult,
	BackfillEpisode,
	BackfillOptions,
	BackfillRunResult,
} from "./memory-backfill.ts";
export type { TasteBoardApplyOutcome, TasteBoardApplyResult } from "./memory-world.ts";
export { applyTasteBoard, findWorldNote } from "./memory-world.ts";
export type { ModelLike } from "./model.ts";
export { FakeModel, OpenAICompatibleModel } from "./model.ts";
export { StorePaths } from "./paths.ts";
export type {
	AssemblePriorOptions,
	PriorAuditEntry,
	PriorBlock,
	PriorLayer,
	PriorMode,
	PriorResult,
	RecordPriorAuditOptions,
	ResolvePriorModeOptions,
} from "./prior.ts";
export { assemblePrior, estimatePriorTokens, priorModeForAction, recordPriorAudit, resolvePriorMode } from "./prior.ts";
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
export { type ExternalizeResult, externalizeLargeDataUris } from "./publish-assets.ts";
export type {
	ApplyMemoryRetractionOptions,
	MemoryRetractionCandidate,
	MemoryRetractionPlan,
	MemoryRetractionResult,
	PlanMemoryRetractionOptions,
} from "./retraction.ts";
export { applyMemoryRetraction, planMemoryRetraction } from "./retraction.ts";
export type { SearchBackend } from "./retrieval.ts";
export type { HerRunEvent, HerRunKind, HerRunSnapshot, HerRunStatus } from "./runs.ts";
export { appendHerRunEvent, herRunKinds, herRunStatuses, listHerRunSnapshots, runsEventsPath } from "./runs.ts";
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
export {
	launchTask,
	type PidInfo,
	type ResolvedCommand,
	readPidFile,
	resolveWorkerCommand,
	stopTask,
} from "./task-executor.ts";
export type {
	LocalPdfTextResult,
	TasteSnapshotInput,
	TasteSnapshotKind,
	TasteSnapshotOutput,
	TasteToolConfig,
	VideoTasteMetadata,
} from "./taste-snapshot.ts";
export {
	buildLocalPdfTasteData,
	captureTasteSnapshot,
	extractLocalPdfText,
	fetchVideoTasteMetadata,
	resolveTasteMediaRoot,
	resolveTasteToolConfig,
	resolveWithinRoot,
} from "./taste-snapshot.ts";
export type {
	TasteCardSummary,
	TasteCluster,
	TasteClusterResult,
	TasteClusterStatus,
	TasteIntakeLogEntry,
	TasteLostEntry,
	TasteProposal,
	TasteProposalStatus,
	TasteProposalsSidecar,
	TasteReconciliation,
	TasteWeeklyOptions,
	TasteWeeklyResult,
} from "./taste-weekly.ts";
export {
	appendTasteIntakeLog,
	clusterTasteCards,
	markTasteProposalApplied,
	markTasteProposalsAppliedForBoard,
	NEW_BOARD_THRESHOLD,
	proposeNewBoards,
	readTasteCards,
	readTasteProposalsSidecar,
	reconcileTasteIntake,
	runTasteWeekly,
	writeTasteProposalsSidecar,
} from "./taste-weekly.ts";
export type {
	AttentionDigest,
	AttentionDigestOptions,
	AttentionItem,
	CreateTelegramConfirmationOptions,
	PollTelegramInboxOptions,
	PushTelegramOutboxOptions,
	QueueTelegramInboundOptions,
	ScoredAttentionItem,
	SendTelegramMessageOptions,
	TelegramApiOptions,
	TelegramConfirmationRequest,
	TelegramConfirmationResult,
	TelegramConfirmationStatus,
	TelegramMessage,
	TelegramOutboxDelivery,
	TelegramOutboxResult,
	TelegramPollResult,
	TelegramQueueResult,
	TelegramUpdate,
	TelegramUser,
} from "./telegram.ts";
export {
	callTelegramMethod,
	createTelegramConfirmationRequest,
	pollTelegramInbox,
	pushTelegramOutbox,
	queueTelegramInbound,
	recordTelegramConfirmationFromText,
	scoreAttentionItem,
	selectAttentionDigest,
	sendTelegramMessage,
	trimTelegramText,
} from "./telegram.ts";
export * from "./trigger-log.ts";
export {
	claimWarmWorktree,
	clampWarmWorktreePoolSize,
	drainWarmWorktreePool,
	ensureWarmWorktreePool,
	listReadyWarmSlots,
	WARM_WORKTREE_POOL_MAX,
	type WarmWorktree,
} from "./warm-worktree-pool.ts";
export type {
	XArticleFullTextFailure,
	XArticleFullTextOptions,
	XArticleFullTextResult,
	XThreadTitleInput,
} from "./x-article.ts";
export { deriveXThreadTitle, extractJinaReaderTitle, fetchXArticleFullText } from "./x-article.ts";
