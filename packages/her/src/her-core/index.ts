export type {
	AcceptanceClaim,
	AcceptanceGate,
	AcceptanceGateSummary,
	AcceptanceGateType,
	AcceptanceOutcome,
	AcceptanceReason,
	AcceptanceReasonCode,
	AcceptanceReport,
	AcceptanceRun,
	AcceptanceVerdict,
	EvidenceGateResult,
	GatePlan,
	GatePlanSource,
	GateRun,
} from "./bg-task-acceptance.ts";
export {
	ACCEPTANCE_REPORT_FILENAME,
	acceptanceRunFilename,
	EVIDENCE_GATE_NAME,
	evaluateTaskAcceptance,
	extractEvidenceItems,
	formatAcceptanceLine,
	gatePlanFilename,
	judgeAcceptance,
	loadRepoGatePlan,
	parseAcceptanceReport,
	parseGatePlan,
	REPO_GATE_MANIFEST_RELATIVE_PATH,
	verifyEvidenceGate,
} from "./bg-task-acceptance.ts";

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
	type DependencyTask,
	formatWakeMessage,
	parseCodexSessionId,
	type ReconcileOptions,
	reconcileBgTasks,
	resolveDependencyActions,
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
	continueBgTask,
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
export type { CheckResult, CheckStatus, DoctorOptions, DoctorReport, Severity } from "./doctor.ts";
export { runDoctor } from "./doctor.ts";
export type {
	ClampTtlResult,
	DrainBgTask,
	DrainFlag,
	DrainState,
	StartDrainOptions,
	StartDrainResult,
	StopDrainOptions,
	StopDrainResult,
	WaitForQuietOptions,
	WaitQuietResult,
} from "./drain.ts";
export {
	clampDrainTtlMinutes,
	DEFAULT_DRAIN_TTL_MINUTES,
	DRAIN_WAIT_POLL_MS,
	drainFlagPath,
	formatStartMessage,
	MAX_DRAIN_TTL_MINUTES,
	readDrainState,
	startDrain,
	stopDrain,
	waitForQuiet,
} from "./drain.ts";
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
export type {
	CorruptMarker,
	DerivedEvent,
	EventKind,
	HistoryEvent,
	HostRunner,
	ListedEvent,
	ListHerEventsOptions,
	ReadEventHistoryResult,
} from "./event-history.ts";
export {
	appendEvent,
	appendEventBestEffort,
	appendSelfmodTransition,
	detectPresumedCrashes,
	EVENT_KINDS,
	eventHistoryPath,
	eventHistoryStatePath,
	HOST_RUNNERS,
	isEventKind,
	isHostRunner,
	listHerEvents,
	readEventHistory,
	uuidv7,
} from "./event-history.ts";
export type { VerifyAlertSender, VerifyResult } from "./event-history-verify.ts";
export { eventHistoryAlertPath, verifyEventHistoryPrefix } from "./event-history-verify.ts";
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
export type { DeliveryDecision, HerMessage } from "./messages.ts";
export {
	archiveInbox,
	deliveryDecision,
	drainInbox,
	formatInbox,
	INBOX_MESSAGE_BEGIN,
	INBOX_MESSAGE_END,
	MAX_AGE_MS,
	MIN_BATCH,
	maybeWake,
	NON_PI_DELIVERY_REFUSAL,
	resolveTargetSource,
	writeMessage,
} from "./messages.ts";
export type { CadenceOrgan, MissedFireInput, MissedFirePolicy, MissedFireResult } from "./missed-fire.ts";
export {
	computeMissedFire,
	MISSED_FIRE_GRACE_MS,
	MISSED_FIRE_MAX_CATCHUP,
	nextCadenceAnchorIso,
	parseCadenceTimestamp,
	parseMissedFirePolicy,
} from "./missed-fire.ts";
export type { CompletionMeta, CompletionOptions, CompletionResult, CompletionUsage, ModelLike } from "./model.ts";
export { FakeModel, FinishReasonLengthError, invokeCompletion, OpenAICompatibleModel } from "./model.ts";
export { detectOrphanBrackets, opsLedgerPath, withOpBracket } from "./op-brackets.ts";
export {
	buildPanelChairBrief,
	type PanelChairBriefParams,
} from "./panel-chair-brief.ts";
export { StorePaths } from "./paths.ts";
export type { PersonaKind, PersonaOrganResult, PersonaProposalRef, RunPersonaOrganOptions } from "./persona.ts";
export {
	DEFAULT_PERSONA_INTERVAL_DAYS,
	PERSONA_INPUT_BUDGET_CHARS,
	PERSONA_KINDS,
	PERSONA_LOOKBACK_DAYS,
	PERSONA_MODEL_TIMEOUT_MS,
	PERSONA_ORGAN_SYSTEM_PROMPT,
	PERSONA_PROPOSAL_BEGIN,
	PERSONA_PROPOSAL_END,
	runPersonaOrgan,
} from "./persona.ts";
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
	allVerified,
	anyInvalidated,
	applyVerifierDecision,
	classifyStall,
	type DoneEvidence,
	emptyProgressState,
	type FailureClass,
	formatProgressCheckpoint,
	type HerTaskDisplayStatus,
	type ProgressState,
	type Requirement,
	type RequirementStatus,
	requirementStatus,
	statusFromDoneEvidence,
	type UsefulValue,
	type VerifiedEvidence,
	type VerifyDecision,
	withRequirements,
} from "./progress-state.ts";
export {
	ANTI_NESTING_CLAUSE,
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
export type { RecallReceipt } from "./recall-receipts.ts";
export { buildRecallReceipt, buildRecallReceipts, UNKNOWN_PROVENANCE } from "./recall-receipts.ts";
export type { ReingestEntry, ReingestOptions, ReingestOutcome, ReingestReport } from "./reingest.ts";
export { runReingest } from "./reingest.ts";
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
export type {
	CheckRollbackOptions,
	RunSelfModOptions,
	SelfModGateResult,
	SelfModHooks,
	SelfModMotivation,
	SelfModProposal,
	SelfModRollbackResult,
	SelfModRunRecord,
	SelfModRunResult,
	SelfModStage,
} from "./selfmod.ts";
export {
	ANCHOR_PATHS,
	checkRollback,
	latestSelfmodRecord,
	MERGE_CRITERIA,
	ROLLBACK_WATCH_HOURS,
	readSelfmodRecords,
	runSelfMod,
	SELFMOD_ALLOWED_PATHS_V1,
	SELFMOD_LEDGER_PATH,
	SELFMOD_OWNED_SKILLS,
	selfmodLedgerPath,
} from "./selfmod.ts";
export type {
	SessionAmbiguousResult,
	SessionCandidate,
	SessionMetaResult,
	SessionMode,
	SessionNotFoundResult,
	SessionReadConfig,
	SessionReadInput,
	SessionReadResult,
	SessionRecordOut,
	SessionRecordsResult,
	SessionSourceName,
} from "./session-read.ts";
export {
	DEFAULT_GREP_CONTEXT,
	formatSessionRead,
	readSession,
	resolveSessionReadConfig,
	SESSION_READ_MAX_BYTES,
	SESSION_READ_MAX_RECORDS,
} from "./session-read.ts";
export type { SessionActivity, SessionFile, SessionHit, SessionRow } from "./session-roster.ts";
export {
	activityLabel,
	formatSessionList,
	formatSessionSearch,
	listSessionFiles,
	listSessions,
	SESSION_LIST_MAX_LIMIT,
	SESSION_SEARCH_DEFAULT_MAX_FILES,
	SESSION_SEARCH_MAX_SNIPPETS_PER_FILE,
	searchSessions,
} from "./session-roster.ts";
export {
	FENCE_MARKER_REMOVED,
	fenceUntrusted,
	frontmatter,
	parseFrontmatter,
	readJson,
	readText,
	redactSecrets,
	writeJson,
	writeText,
} from "./store.ts";
export type { PackedSynthesizeNotes, SemanticNoteRecord, SynthesizeSkip } from "./synthesize-budget.ts";
export {
	CHARS_PER_TOKEN,
	DEFAULT_SYNTHESIZE_MAX_TOKENS,
	DEFAULT_SYNTHESIZE_WINDOW_TOKENS,
	listSemanticNotes,
	packSynthesizeNotes,
	SYNTHESIZE_PACK_RATIO,
	synthesizeLimits,
	synthesizeNoteBudgetChars,
} from "./synthesize-budget.ts";
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
export {
	BUILTIN_WORKER_PROFILES,
	createPanelChairWorkerProfile,
	getBuiltinWorkerProfiles,
	PANEL_CHAIR_WORKER_NAME,
	resolvePanelChairCliPath,
	resolveWorkerModel,
	STALE_ENV_KEYS,
	type WorkerProfile,
} from "./worker-profile.ts";
export type {
	XArticleFullTextFailure,
	XArticleFullTextOptions,
	XArticleFullTextResult,
	XThreadTitleInput,
} from "./x-article.ts";
export { deriveXThreadTitle, extractJinaReaderTitle, fetchXArticleFullText } from "./x-article.ts";
