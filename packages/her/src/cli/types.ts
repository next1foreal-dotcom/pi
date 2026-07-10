import type {
	BackfillRunResult,
	ChoiceModelUpdateResult,
	ConsolidateResult,
	CostBreakdown,
	DecaySweepResult,
	DispatchResult,
	EvalTrendReport,
	GoldenEvalReport,
	JudgmentFields,
	LongTaskRecord,
	LongTaskStatus,
	Memory,
	MemoryClassificationResult,
	MemoryExportCheckResult,
	MemoryLintReport,
	MemorySyncStatus,
	PriorMode,
	PriorResult,
	SamanthaJournalKind,
	SelfNarrativeUpdateResult,
	TelegramConfirmationRequest,
	TelegramConfirmationResult,
	TelegramOutboxResult,
	TelegramPollResult,
	WorldNoteData,
} from "../her-core/index.ts";

export type TelegramReplyMode = "ack" | "pi";
export const defaultTelegramResponderTools = ["her_status", "her_recall"] as const;
export const telegramResponderReadOnlyTools = new Set<string>(defaultTelegramResponderTools);

export type CliCommand =
	| { kind: "approve"; json: boolean; proposalId: string }
	| {
			batchSize?: number;
			budgetUsd?: number;
			dryRun: boolean;
			finalize: boolean;
			json: boolean;
			kind: "backfill";
			maxBatches?: number;
	  }
	| { kind: "bootstrap-feed"; json: boolean; maxBytes?: number; paths: string[]; updateSurfaces: boolean }
	| { kind: "capture"; json: boolean; text: string; project?: string; sessionId?: string; timestamp?: string }
	| { kind: "choice-model"; json: boolean }
	| { kind: "consolidate"; json: boolean; limit?: number }
	| { kind: "cost"; json: boolean; now?: string }
	| { kind: "decay"; json: boolean; olderThanDays?: number; now?: string }
	| {
			budgetUsd?: number;
			cwd?: string;
			executor: string;
			handoffPath: string;
			json: boolean;
			kind: "dispatch";
			label?: string;
			timeoutMin?: number;
	  }
	| { kind: "eval-golden"; json: boolean; now?: string; writeBaseline: boolean }
	| { kind: "eval-trend"; json: boolean }
	| {
			kind: "goal-checkpoint";
			evidence: string[];
			id: string;
			json: boolean;
			nextContinuation?: string;
			status?: Extract<LongTaskStatus, "active" | "blocked">;
			summary: string;
	  }
	| { kind: "goal-complete"; id: string; json: boolean; outcome: string; remember?: string }
	| { kind: "goal-list"; json: boolean; status?: LongTaskStatus }
	| { kind: "goal-next"; json: boolean; leaseMinutes?: number; now?: string; runner?: string }
	| {
			kind: "goal-start";
			json: boolean;
			nextContinuation?: string;
			objective: string;
			owner?: string;
			source?: string;
	  }
	| { kind: "help" }
	| { kind: "ideas"; json: boolean }
	| { kind: "intake-source"; data: WorldNoteData; json: boolean; updateSurfaces: boolean }
	| {
			kind: "intake-path";
			json: boolean;
			maxBytes?: number;
			path: string;
			sourceType?: string;
			updateSurfaces: boolean;
	  }
	| { kind: "intake-url"; json: boolean; maxBytes?: number; updateSurfaces: boolean; url: string }
	| { kind: "judgment"; fields: JudgmentFields; json: boolean; noteId: string }
	| { kind: "lint"; json: boolean }
	| {
			kind: "journal";
			content: string;
			journalKind: SamanthaJournalKind;
			json: boolean;
			runPath?: string;
			source?: string;
			timestamp?: string;
			title?: string;
	  }
	| { kind: "memory-status"; json: boolean; noteId: string; reason: string; status: WorldNoteData["memoryStatus"] }
	| { kind: "privacy-audit"; json: boolean }
	| { kind: "privacy-check"; json: boolean; refs: string[] }
	| { budget?: number; json: boolean; kind: "prior"; mode: PriorMode; task?: string }
	| { kind: "recall"; archive: boolean; json: boolean; k?: number; query: string }
	| { action: "list" | "keep" | "revert"; id?: string; json: boolean; kind: "review-narrative" }
	| { kind: "restore"; json: boolean; semanticKey: string; now?: string }
	| { kind: "self-narrative"; json: boolean }
	| { kind: "synthesize"; json: boolean; ifDue: boolean }
	| { kind: "synthesize-due"; json: boolean }
	| { kind: "surface"; json: boolean }
	| { kind: "status"; json: boolean }
	| { kind: "sync"; json: boolean; message?: string }
	| {
			kind: "taste";
			differsFromFeiRule?: string;
			judgment: string;
			json: boolean;
			reason: string;
			source?: string;
			timestamp?: string;
			title: string;
	  }
	| {
			ackText?: string;
			intervalSeconds: number;
			json: boolean;
			kind: "telegram-bridge";
			limit?: number;
			once: boolean;
			replyMode: TelegramReplyMode;
			timeoutSeconds?: number;
	  }
	| {
			actionId: string;
			code?: string;
			expiresAt?: string;
			json: boolean;
			kind: "telegram-confirm-request";
			summary: string;
			tier?: string;
	  }
	| { kind: "telegram-poll"; json: boolean; limit?: number; offset?: number; timeoutSeconds?: number }
	| { kind: "telegram-push-outbox"; dryRun: boolean; json: boolean; limit?: number }
	| { kind: "topic-maps"; json: boolean }
	| { kind: "voice-task-enqueue"; json: boolean; objective: string }
	| { kind: "voice-task-notify-complete"; json: boolean; objective: string; outcome: string; taskPath?: string };

export interface CliStatusPayload {
	memoryDir: string;
	status: MemorySyncStatus;
	lastSyncedAt: string | null;
	lastSyncedAtError?: string;
}

export interface CliVoiceTaskEnqueuePayload extends CliStatusPayload {
	result: { created: string; objective: string; path: string; status: "queued" };
}
export interface CliVoiceTaskCompleteNotifyPayload extends CliStatusPayload {
	result: { created: string; objective: string; outcome: string; path: string; taskPath?: string };
}
export interface CliSyncPayload extends CliStatusPayload {
	result: Awaited<ReturnType<Memory["sync"]>>;
}

export interface CliDecayPayload extends CliStatusPayload {
	result: DecaySweepResult;
}

export interface CliCostPayload extends CliStatusPayload {
	result: CostBreakdown;
}

export interface CliGoldenEvalPayload extends CliStatusPayload {
	result: GoldenEvalReport;
}

export interface CliEvalTrendPayload extends CliStatusPayload {
	report: EvalTrendReport;
}

export interface CliLintPayload extends CliStatusPayload {
	result: MemoryLintReport;
}

export interface CliConsolidatePayload extends CliStatusPayload {
	result: ConsolidateResult;
}

export interface CliBackfillPayload extends CliStatusPayload {
	result: BackfillRunResult;
}

export interface CliRestorePayload extends CliStatusPayload {
	result: Awaited<ReturnType<Memory["restoreArchivedSemantic"]>>;
}

export interface CliApprovePayload extends CliStatusPayload {
	result: {
		proposalId: string;
		approved: true;
	};
}

export interface CliCapturePayload extends CliStatusPayload {
	result: {
		id: string;
	};
}

export interface CliSynthesizePayload extends CliStatusPayload {
	result: {
		proposalId: string | null;
		due?: Awaited<ReturnType<Memory["synthesizeDue"]>>;
	};
}

export interface CliSynthesizeDuePayload extends CliStatusPayload {
	result: Awaited<ReturnType<Memory["synthesizeDue"]>>;
}

export interface CliChoiceModelPayload extends CliStatusPayload {
	result: ChoiceModelUpdateResult;
}

export interface CliSelfNarrativePayload extends CliStatusPayload {
	result: SelfNarrativeUpdateResult;
}

export interface CliIntakeSourcePayload extends CliStatusPayload {
	result: {
		noteId: string;
		contentHash: string;
		recall: Array<{ id: string; kind: string; path: string }>;
		surfaces: CliSurfaceUpdateResult;
	};
}

export interface CliIntakeUrlPayload extends CliStatusPayload {
	result: {
		bytesRead: number;
		contentHash: string;
		memoryStatus: WorldNoteData["memoryStatus"];
		noteId: string;
		recall: Array<{ id: string; kind: string; path: string }>;
		sourceType: string;
		sourceUrl: string;
		title: string;
		truncated: boolean;
		surfaces: CliSurfaceUpdateResult;
	};
}

export interface CliIntakePathPayload extends CliStatusPayload {
	result: {
		bytesRead: number;
		contentHash: string;
		memoryStatus: WorldNoteData["memoryStatus"];
		noteId: string;
		path: string;
		recall: Array<{ id: string; kind: string; path: string }>;
		sourceType: string;
		sourceUrl: string;
		title: string;
		truncated: boolean;
		surfaces: CliSurfaceUpdateResult;
	};
}

export interface CliBootstrapFeedPayload extends CliStatusPayload {
	result: {
		files: Array<{
			bytesRead: number;
			memoryStatus: WorldNoteData["memoryStatus"];
			noteId: string;
			path: string;
			title: string;
			truncated: boolean;
		}>;
		surfaces: CliSurfaceUpdateResult;
	};
}

export interface CliSurfaceUpdateResult {
	status: "skipped" | "updated" | "failed";
	topicMaps: string[];
	ideas: Array<{ id: string; title: string; kind: string }>;
	error?: string;
	reason?: string;
}

export interface CliJudgmentPayload extends CliStatusPayload {
	result: {
		noteId: string;
		recorded: true;
	};
}

export interface CliJournalPayload extends CliStatusPayload {
	result: {
		id: string;
		kind: SamanthaJournalKind;
		path: string;
	};
}

export interface CliTastePayload extends CliStatusPayload {
	result: {
		id: string;
		path: string;
	};
}

export interface CliMemoryStatusPayload extends CliStatusPayload {
	result: {
		noteId: string;
		status: WorldNoteData["memoryStatus"];
	};
}

export interface CliPrivacyAuditPayload extends CliStatusPayload {
	result: MemoryClassificationResult;
}

export interface CliPrivacyCheckPayload extends CliStatusPayload {
	result: MemoryExportCheckResult;
}

export interface CliPriorPayload {
	memoryDir: string;
	result: PriorResult;
}

export interface CliGoalPayload extends CliStatusPayload {
	result: LongTaskRecord;
}

export interface CliGoalCompletePayload extends CliStatusPayload {
	result: {
		task: LongTaskRecord;
		memoryNoteId?: string;
	};
}

export interface CliGoalListPayload extends CliStatusPayload {
	result: LongTaskRecord[];
}

export interface CliGoalNextPayload extends CliStatusPayload {
	result: LongTaskRecord | null;
}

export interface CliDispatchPayload extends CliStatusPayload {
	result: DispatchResult;
}

export interface CliRecallPayload extends CliStatusPayload {
	result: Awaited<ReturnType<Memory["recall"]>>;
}

export interface CliReviewNarrativePayload extends CliStatusPayload {
	result: {
		action: "list" | "keep" | "revert";
		id?: string;
		updates: Awaited<ReturnType<Memory["reviewContextUpdates"]>>;
	};
}

export interface CliTelegramPollPayload extends CliStatusPayload {
	result: TelegramPollResult;
}

export interface CliTelegramOutboxPayload extends CliStatusPayload {
	result: TelegramOutboxResult;
}

export interface TelegramBridgeAcknowledgement {
	messageId?: number;
	path: string;
	sentAt: string;
	updateId?: number;
}

export interface TelegramBridgeReply {
	messageId?: number;
	path: string;
	responder: "pi";
	sentAt: string;
	updateId?: number;
}

export interface TelegramBridgeCycleResult {
	acknowledgements: TelegramBridgeAcknowledgement[];
	confirmations: TelegramConfirmationResult[];
	outbox: TelegramOutboxResult;
	poll: TelegramPollResult;
	replies: TelegramBridgeReply[];
}

export interface CliTelegramBridgePayload extends CliStatusPayload {
	result: TelegramBridgeCycleResult;
}

export interface CliTelegramConfirmationPayload extends CliStatusPayload {
	result: TelegramConfirmationRequest;
}

export interface CliIo {
	stdout: NodeJS.WritableStream;
	stderr: NodeJS.WritableStream;
}
