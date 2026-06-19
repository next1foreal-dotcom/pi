import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	type ChoiceModelUpdateResult,
	type ClaimLedgerEntry,
	type ConsolidateResult,
	checkMemoryExport,
	checkpointLongTask,
	claimNextLongTask,
	classifyMemoryCorpus,
	collectPathIntakeFiles,
	completeLongTask,
	createEmbeddingSearch,
	createTelegramConfirmationRequest,
	type DecaySweepResult,
	type GoldenEvalReport,
	type JudgmentFields,
	type LongTaskRecord,
	type LongTaskStatus,
	listLongTasks,
	loadConfig,
	longTaskStatuses,
	Memory,
	type MemoryClassificationResult,
	type MemoryExportCheckResult,
	type MemorySyncStatus,
	OpenAICompatibleModel,
	pollTelegramInbox,
	pushTelegramOutbox,
	readPathForWorldNote,
	readUrlForWorldNote,
	recordTelegramConfirmationFromText,
	runGoldenEvals,
	type SamanthaJournalKind,
	type SelfNarrativeUpdateResult,
	sendTelegramMessage,
	startLongTask,
	type TelegramConfirmationRequest,
	type TelegramConfirmationResult,
	type TelegramOutboxResult,
	type TelegramPollResult,
	type UrlMarkdownReader,
	type WorldNoteData,
} from "./her-core/index.ts";
import { createSummaryModel } from "./summary-model.ts";

const execFileAsync = promisify(execFile);
type TelegramReplyMode = "ack" | "pi";
const defaultTelegramResponderTools = ["her_status", "her_recall"] as const;
const telegramResponderReadOnlyTools = new Set<string>(defaultTelegramResponderTools);

type CliCommand =
	| { kind: "approve"; json: boolean; proposalId: string }
	| { kind: "bootstrap-feed"; json: boolean; maxBytes?: number; paths: string[]; updateSurfaces: boolean }
	| { kind: "capture"; json: boolean; text: string; project?: string; sessionId?: string; timestamp?: string }
	| { kind: "choice-model"; json: boolean }
	| { kind: "consolidate"; json: boolean; limit?: number }
	| { kind: "decay"; json: boolean; olderThanDays?: number; now?: string }
	| { kind: "eval-golden"; json: boolean; now?: string; writeBaseline: boolean }
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
	| { kind: "recall"; archive: boolean; json: boolean; k?: number; query: string }
	| { kind: "restore"; json: boolean; semanticKey: string; now?: string }
	| { kind: "self-narrative"; json: boolean }
	| { kind: "synthesize"; json: boolean; ifDue: boolean }
	| { kind: "synthesize-due"; json: boolean }
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
	| { kind: "topic-maps"; json: boolean };

interface CliStatusPayload {
	memoryDir: string;
	status: MemorySyncStatus;
	lastSyncedAt: string | null;
	lastSyncedAtError?: string;
}

interface CliSyncPayload extends CliStatusPayload {
	result: Awaited<ReturnType<Memory["sync"]>>;
}

interface CliDecayPayload extends CliStatusPayload {
	result: DecaySweepResult;
}

interface CliGoldenEvalPayload extends CliStatusPayload {
	result: GoldenEvalReport;
}

interface CliConsolidatePayload extends CliStatusPayload {
	result: ConsolidateResult;
}

interface CliRestorePayload extends CliStatusPayload {
	result: Awaited<ReturnType<Memory["restoreArchivedSemantic"]>>;
}

interface CliApprovePayload extends CliStatusPayload {
	result: {
		proposalId: string;
		approved: true;
	};
}

interface CliCapturePayload extends CliStatusPayload {
	result: {
		id: string;
	};
}

interface CliSynthesizePayload extends CliStatusPayload {
	result: {
		proposalId: string | null;
		due?: Awaited<ReturnType<Memory["synthesizeDue"]>>;
	};
}

interface CliSynthesizeDuePayload extends CliStatusPayload {
	result: Awaited<ReturnType<Memory["synthesizeDue"]>>;
}

interface CliChoiceModelPayload extends CliStatusPayload {
	result: ChoiceModelUpdateResult;
}

interface CliSelfNarrativePayload extends CliStatusPayload {
	result: SelfNarrativeUpdateResult;
}

interface CliIntakeSourcePayload extends CliStatusPayload {
	result: {
		noteId: string;
		contentHash: string;
		recall: Array<{ id: string; kind: string; path: string }>;
		surfaces: CliSurfaceUpdateResult;
	};
}

interface CliIntakeUrlPayload extends CliStatusPayload {
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

interface CliIntakePathPayload extends CliStatusPayload {
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

interface CliBootstrapFeedPayload extends CliStatusPayload {
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

interface CliSurfaceUpdateResult {
	status: "skipped" | "updated" | "failed";
	topicMaps: string[];
	ideas: Array<{ id: string; title: string; kind: string }>;
	error?: string;
	reason?: string;
}

interface CliJudgmentPayload extends CliStatusPayload {
	result: {
		noteId: string;
		recorded: true;
	};
}

interface CliJournalPayload extends CliStatusPayload {
	result: {
		id: string;
		kind: SamanthaJournalKind;
		path: string;
	};
}

interface CliTastePayload extends CliStatusPayload {
	result: {
		id: string;
		path: string;
	};
}

interface CliMemoryStatusPayload extends CliStatusPayload {
	result: {
		noteId: string;
		status: WorldNoteData["memoryStatus"];
	};
}

interface CliPrivacyAuditPayload extends CliStatusPayload {
	result: MemoryClassificationResult;
}

interface CliPrivacyCheckPayload extends CliStatusPayload {
	result: MemoryExportCheckResult;
}

interface CliGoalPayload extends CliStatusPayload {
	result: LongTaskRecord;
}

interface CliGoalCompletePayload extends CliStatusPayload {
	result: {
		task: LongTaskRecord;
		memoryNoteId?: string;
	};
}

interface CliGoalListPayload extends CliStatusPayload {
	result: LongTaskRecord[];
}

interface CliGoalNextPayload extends CliStatusPayload {
	result: LongTaskRecord | null;
}

interface CliRecallPayload extends CliStatusPayload {
	result: Awaited<ReturnType<Memory["recall"]>>;
}

interface CliTelegramPollPayload extends CliStatusPayload {
	result: TelegramPollResult;
}

interface CliTelegramOutboxPayload extends CliStatusPayload {
	result: TelegramOutboxResult;
}

interface TelegramBridgeAcknowledgement {
	messageId?: number;
	path: string;
	sentAt: string;
	updateId?: number;
}

interface TelegramBridgeReply {
	messageId?: number;
	path: string;
	responder: "pi";
	sentAt: string;
	updateId?: number;
}

interface TelegramBridgeCycleResult {
	acknowledgements: TelegramBridgeAcknowledgement[];
	confirmations: TelegramConfirmationResult[];
	outbox: TelegramOutboxResult;
	poll: TelegramPollResult;
	replies: TelegramBridgeReply[];
}

interface CliTelegramBridgePayload extends CliStatusPayload {
	result: TelegramBridgeCycleResult;
}

interface CliTelegramConfirmationPayload extends CliStatusPayload {
	result: TelegramConfirmationRequest;
}

interface CliIo {
	stdout: NodeJS.WritableStream;
	stderr: NodeJS.WritableStream;
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): CliCommand {
	const [command, ...rest] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") return { kind: "help" };
	if (command === "approve") return parseApprove(rest);
	if (command === "bootstrap-feed") return parseBootstrapFeed(rest);
	if (command === "capture") return parseCapture(rest);
	if (command === "choice-model") return parseJsonOnly("choice-model", rest);
	if (command === "consolidate") return parseConsolidate(rest);
	if (command === "decay") return parseDecay(rest);
	if (command === "eval-golden") return parseEvalGolden(rest);
	if (command === "goal-checkpoint") return parseGoalCheckpoint(rest);
	if (command === "goal-complete") return parseGoalComplete(rest);
	if (command === "goal-list") return parseGoalList(rest);
	if (command === "goal-next") return parseGoalNext(rest);
	if (command === "goal-start") return parseGoalStart(rest);
	if (command === "ideas") return parseJsonOnly("ideas", rest);
	if (command === "intake-path") return parseIntakePath(rest);
	if (command === "intake-source") return parseIntakeSource(rest);
	if (command === "intake-url") return parseIntakeUrl(rest);
	if (command === "judgment") return parseJudgment(rest);
	if (command === "journal") return parseJournal(rest);
	if (command === "memory-status") return parseMemoryStatusCommand(rest);
	if (command === "privacy-audit") return parseJsonOnly("privacy-audit", rest);
	if (command === "privacy-check") return parsePrivacyCheck(rest);
	if (command === "recall") return parseRecall(rest);
	if (command === "restore") return parseRestore(rest);
	if (command === "self-narrative") return parseJsonOnly("self-narrative", rest);
	if (command === "synthesize") return parseSynthesize(rest);
	if (command === "synthesize-due") return parseJsonOnly("synthesize-due", rest);
	if (command === "status") return parseStatus(rest);
	if (command === "sync") return parseSync(rest);
	if (command === "taste") return parseTaste(rest);
	if (command === "telegram-bridge") return parseTelegramBridge(rest);
	if (command === "telegram-confirm-request") return parseTelegramConfirmRequest(rest);
	if (command === "telegram-poll") return parseTelegramPoll(rest);
	if (command === "telegram-push-outbox") return parseTelegramPushOutbox(rest);
	if (command === "topic-maps") return parseJsonOnly("topic-maps", rest);
	throw new UsageError(`unknown Her command: ${command}`);
}

export async function runHerCli(
	argv = process.argv.slice(2),
	env: NodeJS.ProcessEnv = process.env,
	cwd = process.cwd(),
	io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
	let command: CliCommand;
	try {
		command = parseArgs(argv);
	} catch (error) {
		writeLine(io.stderr, errorMessage(error));
		writeLine(io.stderr, usage());
		return 2;
	}

	if (command.kind === "help") {
		writeLine(io.stdout, usage());
		return 0;
	}

	const memoryDir = getMemoryDir(env, cwd);

	if (command.kind === "telegram-poll") {
		const result = await pollTelegramInbox(memoryDir, {
			allowedChatId: requireEnv(env, "HER_TELEGRAM_CHAT_ID"),
			baseUrl: env.HER_TELEGRAM_BASE_URL,
			limit: command.limit,
			offset: command.offset,
			timeoutSeconds: command.timeoutSeconds,
			token: requireEnv(env, "HER_TELEGRAM_BOT_TOKEN"),
		});
		const payload = { ...(await buildFreshStatusPayload(memoryDir, env)), result };
		writePayload(io.stdout, payload, command.json, renderTelegramPoll);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "telegram-bridge") {
		const options = {
			ackText: command.ackText,
			allowedChatId: requireEnv(env, "HER_TELEGRAM_CHAT_ID"),
			baseUrl: env.HER_TELEGRAM_BASE_URL,
			chatId: requireEnv(env, "HER_TELEGRAM_CHAT_ID"),
			cwd,
			env,
			limit: command.limit,
			memoryDir,
			replyMode: command.replyMode,
			timeoutSeconds: command.timeoutSeconds,
			token: requireEnv(env, "HER_TELEGRAM_BOT_TOKEN"),
		};

		for (;;) {
			const result = await runTelegramBridgeCycle(memoryDir, options);
			const payload = { ...(await buildFreshStatusPayload(memoryDir, env)), result };
			writePayload(io.stdout, payload, command.json, renderTelegramBridge);
			if (command.once) return payload.status.status === "unknown" ? 1 : 0;
			await sleep(command.intervalSeconds * 1000);
		}
	}

	if (command.kind === "telegram-push-outbox") {
		const result = await pushTelegramOutbox(memoryDir, {
			baseUrl: env.HER_TELEGRAM_BASE_URL,
			chatId: requireEnv(env, "HER_TELEGRAM_CHAT_ID"),
			dryRun: command.dryRun,
			limit: command.limit,
			token: requireEnv(env, "HER_TELEGRAM_BOT_TOKEN"),
		});
		const payload = { ...(await buildFreshStatusPayload(memoryDir, env)), result };
		writePayload(io.stdout, payload, command.json, renderTelegramOutbox);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "telegram-confirm-request") {
		const result = await createTelegramConfirmationRequest(memoryDir, {
			actionId: command.actionId,
			code: command.code,
			expiresAt: command.expiresAt,
			summary: command.summary,
			tier: command.tier,
		});
		const payload = { ...(await buildFreshStatusPayload(memoryDir, env)), result };
		writePayload(io.stdout, payload, command.json, renderTelegramConfirmation);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	const memory = createCliMemory(memoryDir, env);

	if (command.kind === "status") {
		const payload = await buildStatusPayload(memoryDir, memory);
		writePayload(io.stdout, payload, command.json, renderStatus);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "consolidate") {
		const result = await memory.consolidate(command.limit);
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderConsolidate);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "decay") {
		const result = await memory.decaySweep({ olderThanDays: command.olderThanDays, now: command.now });
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderDecay);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "eval-golden") {
		const result = await runGoldenEvals(memoryDir, { now: command.now, writeBaseline: command.writeBaseline });
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderGoldenEval);
		if (payload.status.status === "unknown") return 1;
		return result.status === "pass" ? 0 : 1;
	}

	if (command.kind === "restore") {
		const result = await memory.restoreArchivedSemantic(command.semanticKey, { now: command.now });
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderRestore);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "goal-start") {
		const result = await startLongTask(memoryDir, command);
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderGoal);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "goal-checkpoint") {
		const result = await checkpointLongTask(memoryDir, command.id, command);
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderGoal);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "goal-complete") {
		const task = await completeLongTask(memoryDir, command.id, command);
		const memoryNoteId = command.remember ? await memory.remember(command.remember, "long-task") : undefined;
		const payload = {
			...(await buildStatusPayload(memoryDir, memory)),
			result: { task, ...(memoryNoteId ? { memoryNoteId } : {}) },
		};
		writePayload(io.stdout, payload, command.json, renderGoalComplete);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "goal-list") {
		const result = await listLongTasks(memoryDir, command.status);
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderGoalList);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "goal-next") {
		const result = (await claimNextLongTask(memoryDir, command)) ?? null;
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderGoalNext);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "approve") {
		await memory.approve(command.proposalId);
		const payload = {
			...(await buildStatusPayload(memoryDir, memory)),
			result: { proposalId: command.proposalId, approved: true as const },
		};
		writePayload(io.stdout, payload, command.json, renderApprove);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "capture") {
		const id = await memory.capture(command.text, {
			project: command.project ?? "her-cli",
			sessionId: command.sessionId,
			timestamp: command.timestamp,
		});
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result: { id } };
		writePayload(io.stdout, payload, command.json, renderCapture);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "recall") {
		const result = command.archive
			? await memory.recallArchive(command.query, { k: command.k })
			: await memory.recall(command.query, { k: command.k });
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderRecall);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "synthesize-due") {
		const result = await memory.synthesizeDue();
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderSynthesizeDue);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "synthesize") {
		const due = command.ifDue ? await memory.synthesizeDue() : undefined;
		const proposalId = due?.due === false ? null : await memory.synthesize();
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result: { proposalId, due } };
		writePayload(io.stdout, payload, command.json, renderSynthesize);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "topic-maps") {
		const result = await memory.buildTopicMaps();
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderTopicMaps);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "ideas") {
		const result = await memory.generateIdeas();
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderIdeas);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "intake-path") {
		const intake = await readPathForWorldNote(resolve(cwd, command.path), {
			maxBytes: command.maxBytes,
			rootDir: cwd,
			sourceType: command.sourceType,
		});
		const noteId = await memory.writeWorldNote(intake.data);
		const recall = await memory.recall(`${intake.data.title} ${intake.data.sourceUrl} ${intake.data.take}`, {
			k: 3,
		});
		const surfaces = await updateSurfaces(memory, command.updateSurfaces);
		const payload = {
			...(await buildStatusPayload(memoryDir, memory)),
			result: {
				bytesRead: intake.bytesRead,
				contentHash: intake.data.contentHash,
				memoryStatus: intake.data.memoryStatus,
				noteId,
				path: intake.path,
				recall: recall.map((note) => ({ id: note.id, kind: note.kind, path: note.path })),
				sourceType: intake.data.sourceType,
				sourceUrl: intake.data.sourceUrl,
				title: intake.data.title,
				truncated: intake.truncated,
				surfaces,
			},
		};
		writePayload(io.stdout, payload, command.json, renderIntakePath);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "bootstrap-feed") {
		const files = await collectPathIntakeFiles(command.paths.map((path) => resolve(cwd, path)));
		const results: CliBootstrapFeedPayload["result"]["files"] = [];
		for (const file of files) {
			const intake = await readPathForWorldNote(file, { maxBytes: command.maxBytes, rootDir: cwd });
			const noteId = await memory.writeWorldNote(intake.data);
			results.push({
				bytesRead: intake.bytesRead,
				memoryStatus: intake.data.memoryStatus,
				noteId,
				path: intake.path,
				title: intake.data.title,
				truncated: intake.truncated,
			});
		}
		const surfaces = await updateSurfaces(memory, command.updateSurfaces);
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result: { files: results, surfaces } };
		writePayload(io.stdout, payload, command.json, renderBootstrapFeed);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "intake-source") {
		const noteId = await memory.writeWorldNote(command.data);
		const recall = await memory.recall(`${command.data.title} ${command.data.sourceUrl} ${command.data.take}`, {
			k: 3,
		});
		const surfaces = await updateSurfaces(memory, command.updateSurfaces);
		const payload = {
			...(await buildStatusPayload(memoryDir, memory)),
			result: {
				noteId,
				contentHash: command.data.contentHash,
				recall: recall.map((note) => ({ id: note.id, kind: note.kind, path: note.path })),
				surfaces,
			},
		};
		writePayload(io.stdout, payload, command.json, renderIntakeSource);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "intake-url") {
		const intake = await readUrlForWorldNote(command.url, {
			allowLocal: env.HER_ALLOW_LOCAL_URLS === "1" || env.HER_ALLOW_LOCAL_INTAKE === "1",
			markdownReader: createArticleMarkdownReader(env, cwd),
			maxBytes: command.maxBytes,
			xMarkdownReader: createDefuddleMarkdownReader(env, cwd),
		});
		const noteId = await memory.writeWorldNote(intake.data);
		const recall = await memory.recall(`${intake.data.title} ${intake.data.sourceUrl} ${intake.data.take}`, {
			k: 3,
		});
		const surfaces = await updateSurfaces(memory, command.updateSurfaces);
		const payload = {
			...(await buildStatusPayload(memoryDir, memory)),
			result: {
				bytesRead: intake.bytesRead,
				contentHash: intake.data.contentHash,
				memoryStatus: intake.data.memoryStatus,
				noteId,
				recall: recall.map((note) => ({ id: note.id, kind: note.kind, path: note.path })),
				sourceType: intake.data.sourceType,
				sourceUrl: intake.data.sourceUrl,
				title: intake.data.title,
				truncated: intake.truncated,
				surfaces,
			},
		};
		writePayload(io.stdout, payload, command.json, renderIntakeUrl);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "judgment") {
		await memory.recordJudgment(command.noteId, command.fields);
		const payload = {
			...(await buildStatusPayload(memoryDir, memory)),
			result: { noteId: command.noteId, recorded: true as const },
		};
		writePayload(io.stdout, payload, command.json, renderJudgment);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "journal") {
		const result = await memory.writeSamanthaJournal({
			kind: command.journalKind,
			content: command.content,
			...(command.runPath ? { runPath: command.runPath } : {}),
			...(command.source ? { source: command.source } : {}),
			...(command.timestamp ? { timestamp: command.timestamp } : {}),
			...(command.title ? { title: command.title } : {}),
		});
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderJournal);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "taste") {
		const result = await memory.writeSamanthaTasteJudgment({
			title: command.title,
			judgment: command.judgment,
			reason: command.reason,
			...(command.differsFromFeiRule ? { differsFromFeiRule: command.differsFromFeiRule } : {}),
			...(command.source ? { source: command.source } : {}),
			...(command.timestamp ? { timestamp: command.timestamp } : {}),
		});
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderTaste);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "memory-status") {
		await memory.setMemoryStatus(command.noteId, command.status, command.reason);
		const payload = {
			...(await buildStatusPayload(memoryDir, memory)),
			result: { noteId: command.noteId, status: command.status },
		};
		writePayload(io.stdout, payload, command.json, renderMemoryStatus);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "privacy-audit") {
		const result = await classifyMemoryCorpus(memoryDir);
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderPrivacyAudit);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "privacy-check") {
		const result = await checkMemoryExport(memoryDir, command.refs);
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderPrivacyCheck);
		return result.allowed && payload.status.status !== "unknown" ? 0 : 1;
	}

	if (command.kind === "choice-model") {
		const result = await memory.synthesizeChoiceModel();
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderChoiceModel);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "self-narrative") {
		const result = await memory.synthesizeSelfNarrative();
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderSelfNarrative);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	try {
		const result = await memory.sync(command.message ?? `memory(sync): cli ${new Date().toISOString()}`);
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderSync);
		return payload.status.status === "unknown" ? 1 : 0;
	} catch (error) {
		writeLine(io.stderr, `Her memory sync failed: ${errorMessage(error)}`);
		return 1;
	}
}

export function getMemoryDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
	return resolve(env.HER_MEMORY_DIR ?? resolve(cwd, "..", "her-memory"));
}

function createCliMemory(memoryDir: string, env: NodeJS.ProcessEnv): Memory {
	const model =
		createSummaryModel(env) ?? new OpenAICompatibleModel(loadConfig(join(memoryDir, ".her", "config.yaml")), env);
	return new Memory(memoryDir, { model, semanticSearch: createEmbeddingSearch(env) });
}

function createArticleMarkdownReader(env: NodeJS.ProcessEnv, cwd: string): UrlMarkdownReader | undefined {
	return composeMarkdownReaders(createCurlMdMarkdownReader(env), createDefuddleMarkdownReader(env, cwd));
}

function composeMarkdownReaders(...readers: Array<UrlMarkdownReader | undefined>): UrlMarkdownReader | undefined {
	const activeReaders = readers.filter((reader): reader is UrlMarkdownReader => Boolean(reader));
	if (activeReaders.length === 0) return undefined;
	return async (url, opts) => {
		for (const reader of activeReaders) {
			const result = await reader(url, opts);
			if (result?.markdown?.trim()) return result;
		}
		return undefined;
	};
}

function createCurlMdMarkdownReader(env: NodeJS.ProcessEnv): UrlMarkdownReader | undefined {
	if (env.HER_CURL_MD_ENABLED === "0") return undefined;
	const explicitCommand = env.HER_CURL_MD_BIN?.trim();
	const commands = explicitCommand ? [explicitCommand] : ["curl.md"];
	return async (url, opts) => {
		for (const command of commands) {
			try {
				const { stdout } = await execFileAsync(command, [url.href, "--mode", "smart"], {
					env,
					maxBuffer: Math.max(opts.maxBytes * 2, 256_000),
					shell: process.platform === "win32",
					timeout: 60_000,
				});
				const markdown = stdout.trim();
				if (markdown) return { finalUrl: url.href, markdown, source: "curl.md" };
			} catch {
				// curl.md is an optional public-URL reader; failures fall through to Her's safe fetch path.
			}
		}
		return undefined;
	};
}

function createDefuddleMarkdownReader(env: NodeJS.ProcessEnv, cwd: string): UrlMarkdownReader | undefined {
	if (env.HER_DEFUDDLE_ENABLED === "0") return undefined;
	const commands = commandCandidates(env.HER_DEFUDDLE_BIN, "defuddle", cwd);
	return async (url, opts) => {
		for (const command of commands) {
			try {
				const { stdout } = await execFileAsync(command, ["parse", url.href, "--markdown"], {
					env,
					maxBuffer: Math.max(opts.maxBytes * 2, 512_000),
					shell: process.platform === "win32",
					timeout: 60_000,
				});
				const markdown = stdout.trim();
				if (markdown) return { finalUrl: url.href, markdown, source: "defuddle" };
			} catch {
				// Defuddle is an optional public-URL distiller; failures fall through to the next reader.
			}
		}
		return undefined;
	};
}

function commandCandidates(explicitCommand: string | undefined, commandName: string, cwd: string): string[] {
	if (explicitCommand?.trim()) return [explicitCommand.trim()];
	const suffix = process.platform === "win32" ? ".cmd" : "";
	const localCommand = resolve(cwd, "node_modules", ".bin", `${commandName}${suffix}`);
	const commands = existsSync(localCommand) ? [localCommand, commandName] : [commandName];
	return [...new Set(commands)];
}

function parseJsonOnly(
	kind: "choice-model" | "ideas" | "privacy-audit" | "self-narrative" | "synthesize-due" | "topic-maps",
	argv: string[],
): CliCommand {
	let json = false;
	for (const arg of argv) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		throw new UsageError(`unknown ${kind} option: ${arg}`);
	}
	return { kind, json };
}

function parseApprove(argv: string[]): CliCommand {
	let json = false;
	let proposalId: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--proposal") {
			const value = argv[++i];
			if (!value) throw new UsageError(`${arg} requires a value`);
			proposalId = value;
			continue;
		}
		throw new UsageError(`unknown approve option: ${arg}`);
	}
	if (!proposalId) throw new UsageError("approve requires --proposal <id>");
	return { kind: "approve", json, proposalId };
}

function parseCapture(argv: string[]): CliCommand {
	let json = false;
	let text: string | undefined;
	let project: string | undefined;
	let sessionId: string | undefined;
	let timestamp: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--text") {
			const value = argv[++i];
			if (!value) throw new UsageError(`${arg} requires a value`);
			text = value;
			continue;
		}
		if (arg === "--project") {
			const value = argv[++i];
			if (!value) throw new UsageError(`${arg} requires a value`);
			project = value;
			continue;
		}
		if (arg === "--session" || arg === "--session-id") {
			const value = argv[++i];
			if (!value) throw new UsageError(`${arg} requires a value`);
			sessionId = value;
			continue;
		}
		if (arg === "--timestamp") {
			const value = argv[++i];
			if (!value) throw new UsageError(`${arg} requires a value`);
			timestamp = value;
			continue;
		}
		throw new UsageError(`unknown capture option: ${arg}`);
	}
	if (!text?.trim()) throw new UsageError("capture requires --text <text>");
	return { kind: "capture", json, text, project, sessionId, timestamp };
}

function parseConsolidate(argv: string[]): CliCommand {
	let json = false;
	let limit: number | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--limit") {
			const value = argv[++i];
			if (!value) throw new UsageError(`${arg} requires a value`);
			limit = parsePositiveNumber(value, arg);
			continue;
		}
		throw new UsageError(`unknown consolidate option: ${arg}`);
	}
	return { kind: "consolidate", json, limit };
}

function parseSynthesize(argv: string[]): CliCommand {
	let json = false;
	let ifDue = false;
	for (const arg of argv) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--if-due") {
			ifDue = true;
			continue;
		}
		throw new UsageError(`unknown synthesize option: ${arg}`);
	}
	return { kind: "synthesize", json, ifDue };
}

function parseStatus(argv: string[]): CliCommand {
	let json = false;
	for (const arg of argv) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		throw new UsageError(`unknown status option: ${arg}`);
	}
	return { kind: "status", json };
}

function parseSync(argv: string[]): CliCommand {
	let json = false;
	let status = false;
	let message: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--status" || arg === "status") {
			status = true;
			continue;
		}
		if (arg === "--message" || arg === "-m") {
			const value = argv[++i];
			if (!value) throw new UsageError(`${arg} requires a value`);
			message = value;
			continue;
		}
		throw new UsageError(`unknown sync option: ${arg}`);
	}
	return status ? { kind: "status", json } : { kind: "sync", json, message };
}

function parseTelegramBridge(argv: string[]): CliCommand {
	let ackText: string | undefined;
	let intervalSeconds = 1;
	let json = false;
	let limit: number | undefined;
	let once = false;
	let replyMode: TelegramReplyMode = "ack";
	let timeoutSeconds: number | undefined = 20;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--ack-text") {
			ackText = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--interval") {
			intervalSeconds = parseNonNegativeNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--limit") {
			limit = parsePositiveNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		if (arg === "--once") {
			once = true;
			continue;
		}
		if (arg === "--reply") {
			replyMode = "pi";
			continue;
		}
		if (arg === "--reply-mode") {
			replyMode = parseTelegramReplyMode(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		if (arg === "--timeout") {
			timeoutSeconds = parseNonNegativeNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		throw new UsageError(`unknown telegram-bridge option: ${arg}`);
	}
	return { ackText, intervalSeconds, json, kind: "telegram-bridge", limit, once, replyMode, timeoutSeconds };
}

function parseTelegramConfirmRequest(argv: string[]): CliCommand {
	let actionId: string | undefined;
	let code: string | undefined;
	let expiresAt: string | undefined;
	let json = false;
	let summary: string | undefined;
	let tier: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--action-id") {
			actionId = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--code") {
			code = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--expires-at") {
			expiresAt = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--summary") {
			summary = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--tier") {
			tier = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown telegram-confirm-request option: ${arg}`);
	}
	if (!actionId) throw new UsageError("telegram-confirm-request requires --action-id");
	if (!summary) throw new UsageError("telegram-confirm-request requires --summary");
	return { actionId, code, expiresAt, json, kind: "telegram-confirm-request", summary, tier };
}

function parseTelegramReplyMode(value: string, option: string): TelegramReplyMode {
	if (value === "ack" || value === "pi") return value;
	throw new UsageError(`${option} must be one of: ack, pi`);
}

function parseTelegramPoll(argv: string[]): CliCommand {
	let json = false;
	let limit: number | undefined;
	let offset: number | undefined;
	let timeoutSeconds: number | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--limit") {
			limit = parsePositiveNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		if (arg === "--offset") {
			offset = parseNonNegativeNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		if (arg === "--timeout") {
			timeoutSeconds = parseNonNegativeNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		throw new UsageError(`unknown telegram-poll option: ${arg}`);
	}
	return { kind: "telegram-poll", json, limit, offset, timeoutSeconds };
}

function parseTelegramPushOutbox(argv: string[]): CliCommand {
	let dryRun = false;
	let json = false;
	let limit: number | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--limit") {
			limit = parsePositiveNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		throw new UsageError(`unknown telegram-push-outbox option: ${arg}`);
	}
	return { kind: "telegram-push-outbox", dryRun, json, limit };
}

function parseDecay(argv: string[]): CliCommand {
	let json = false;
	let olderThanDays: number | undefined;
	let now: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--older-than-days") {
			const value = argv[++i];
			if (!value) throw new UsageError(`${arg} requires a value`);
			olderThanDays = parsePositiveNumber(value, arg);
			continue;
		}
		if (arg === "--now") {
			const value = argv[++i];
			if (!value) throw new UsageError(`${arg} requires a value`);
			now = value;
			continue;
		}
		throw new UsageError(`unknown decay option: ${arg}`);
	}
	return { kind: "decay", json, olderThanDays, now };
}

function parseEvalGolden(argv: string[]): CliCommand {
	let json = false;
	let now: string | undefined;
	let writeBaseline = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--write-baseline") {
			writeBaseline = true;
			continue;
		}
		if (arg === "--now") {
			now = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown eval-golden option: ${arg}`);
	}
	return { kind: "eval-golden", json, now, writeBaseline };
}

function parseRestore(argv: string[]): CliCommand {
	let json = false;
	let semanticKey: string | undefined;
	let now: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--semantic") {
			const value = argv[++i];
			if (!value) throw new UsageError(`${arg} requires a value`);
			semanticKey = value;
			continue;
		}
		if (arg === "--now") {
			const value = argv[++i];
			if (!value) throw new UsageError(`${arg} requires a value`);
			now = value;
			continue;
		}
		throw new UsageError(`unknown restore option: ${arg}`);
	}
	if (!semanticKey) throw new UsageError("restore requires --semantic <key>");
	return { kind: "restore", json, semanticKey, now };
}

function parseGoalStart(argv: string[]): CliCommand {
	let json = false;
	let objective: string | undefined;
	let owner: string | undefined;
	let source: string | undefined;
	let nextContinuation: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--objective") {
			objective = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--owner") {
			owner = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--source") {
			source = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--next") {
			nextContinuation = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown goal-start option: ${arg}`);
	}
	if (!objective?.trim()) throw new UsageError("goal-start requires --objective <text>");
	return {
		kind: "goal-start",
		json,
		objective,
		...(owner ? { owner } : {}),
		...(source ? { source } : {}),
		...(nextContinuation ? { nextContinuation } : {}),
	};
}

function parseGoalCheckpoint(argv: string[]): CliCommand {
	let json = false;
	let id: string | undefined;
	let summary: string | undefined;
	let status: Extract<LongTaskStatus, "active" | "blocked"> | undefined;
	let nextContinuation: string | undefined;
	const evidence: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--id") {
			id = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--summary") {
			summary = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--status") {
			status = parseGoalCheckpointStatus(requireOptionValue(argv[++i], arg));
			continue;
		}
		if (arg === "--next") {
			nextContinuation = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--evidence") {
			evidence.push(requireOptionValue(argv[++i], arg));
			continue;
		}
		throw new UsageError(`unknown goal-checkpoint option: ${arg}`);
	}
	if (!id?.trim()) throw new UsageError("goal-checkpoint requires --id <id>");
	if (!summary?.trim()) throw new UsageError("goal-checkpoint requires --summary <text>");
	return {
		kind: "goal-checkpoint",
		json,
		id,
		summary,
		evidence,
		...(status ? { status } : {}),
		...(nextContinuation ? { nextContinuation } : {}),
	};
}

function parseGoalComplete(argv: string[]): CliCommand {
	let json = false;
	let id: string | undefined;
	let outcome: string | undefined;
	let remember: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--id") {
			id = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--outcome") {
			outcome = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--remember") {
			remember = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown goal-complete option: ${arg}`);
	}
	if (!id?.trim()) throw new UsageError("goal-complete requires --id <id>");
	if (!outcome?.trim()) throw new UsageError("goal-complete requires --outcome <text>");
	return { kind: "goal-complete", json, id, outcome, ...(remember ? { remember } : {}) };
}

function parseGoalList(argv: string[]): CliCommand {
	let json = false;
	let status: LongTaskStatus | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--status") {
			status = parseGoalStatus(requireOptionValue(argv[++i], arg));
			continue;
		}
		throw new UsageError(`unknown goal-list option: ${arg}`);
	}
	return { kind: "goal-list", json, ...(status ? { status } : {}) };
}

function parseGoalNext(argv: string[]): CliCommand {
	let json = false;
	let leaseMinutes: number | undefined;
	let now: string | undefined;
	let runner: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--lease-minutes") {
			leaseMinutes = parsePositiveNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		if (arg === "--now") {
			now = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--runner") {
			runner = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown goal-next option: ${arg}`);
	}
	return {
		kind: "goal-next",
		json,
		...(leaseMinutes ? { leaseMinutes } : {}),
		...(now ? { now } : {}),
		...(runner ? { runner } : {}),
	};
}

function parseRecall(argv: string[]): CliCommand {
	let archive = false;
	let json = false;
	let k: number | undefined;
	let query: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--archive") {
			archive = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--k") {
			k = parsePositiveNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		if (arg === "--query") {
			query = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown recall option: ${arg}`);
	}
	if (!query?.trim()) throw new UsageError("recall requires --query <text>");
	return { kind: "recall", archive, json, k, query };
}

function parseIntakeSource(argv: string[]): CliCommand {
	let json = false;
	let updateSurfaces = false;
	let title: string | undefined;
	let sourceUrl: string | undefined;
	let sourceType: string | undefined;
	let extracted: string | undefined;
	let coverage: string | undefined;
	let read: string | undefined;
	let take: string | undefined;
	let memoryStatus: WorldNoteData["memoryStatus"] = "active";
	let memoryStatusReason: string | undefined;
	const claims: ClaimLedgerEntry[] = [];
	const steal: string[] = [];
	const connections: string[] = [];
	const possibleMoves: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--update-surfaces") {
			updateSurfaces = true;
			continue;
		}
		if (arg === "--title") {
			title = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--source-url") {
			sourceUrl = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--source-type") {
			sourceType = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--extracted") {
			extracted = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--coverage") {
			coverage = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--read") {
			read = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--take") {
			take = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--memory-status") {
			memoryStatus = parseMemoryStatus(requireOptionValue(argv[++i], arg));
			continue;
		}
		if (arg === "--memory-status-reason") {
			memoryStatusReason = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--claim-json") {
			claims.push(parseClaimJson(requireOptionValue(argv[++i], arg)));
			continue;
		}
		if (arg === "--steal") {
			steal.push(requireOptionValue(argv[++i], arg));
			continue;
		}
		if (arg === "--connection") {
			connections.push(requireOptionValue(argv[++i], arg));
			continue;
		}
		if (arg === "--possible-move") {
			possibleMoves.push(requireOptionValue(argv[++i], arg));
			continue;
		}
		throw new UsageError(`unknown intake-source option: ${arg}`);
	}

	const data = {
		title: requireNonBlank(title, "--title"),
		sourceUrl: requireNonBlank(sourceUrl, "--source-url"),
		sourceType: requireNonBlank(sourceType, "--source-type"),
		extracted: requireNonBlank(extracted, "--extracted"),
		coverage: requireNonBlank(coverage, "--coverage"),
		read: requireNonBlank(read, "--read"),
		take: requireNonBlank(take, "--take"),
		memoryStatus,
		...(memoryStatusReason ? { memoryStatusReason } : {}),
		claims,
		steal,
		connections,
		possibleMoves,
	} satisfies Omit<WorldNoteData, "contentHash">;
	return {
		kind: "intake-source",
		json,
		updateSurfaces,
		data: { ...data, contentHash: intakeContentHash(data.sourceUrl, data.extracted) },
	};
}

function parseIntakePath(argv: string[]): CliCommand {
	let json = false;
	let maxBytes: number | undefined;
	let path: string | undefined;
	let sourceType: string | undefined;
	let updateSurfaces = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--update-surfaces") {
			updateSurfaces = true;
			continue;
		}
		if (arg === "--path") {
			path = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--source-type") {
			sourceType = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--max-bytes") {
			maxBytes = parsePositiveNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		throw new UsageError(`unknown intake-path option: ${arg}`);
	}

	return {
		kind: "intake-path",
		json,
		path: requireNonBlank(path, "--path"),
		updateSurfaces,
		...(maxBytes ? { maxBytes } : {}),
		...(sourceType ? { sourceType } : {}),
	};
}

function parseBootstrapFeed(argv: string[]): CliCommand {
	let json = false;
	let maxBytes: number | undefined;
	const paths: string[] = [];
	let updateSurfaces = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--update-surfaces") {
			updateSurfaces = true;
			continue;
		}
		if (arg === "--path") {
			paths.push(requireOptionValue(argv[++i], arg));
			continue;
		}
		if (arg === "--max-bytes") {
			maxBytes = parsePositiveNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		throw new UsageError(`unknown bootstrap-feed option: ${arg}`);
	}

	if (paths.length === 0) throw new UsageError("bootstrap-feed requires at least one --path <file-or-dir>");
	return { kind: "bootstrap-feed", json, paths, updateSurfaces, ...(maxBytes ? { maxBytes } : {}) };
}

function parseIntakeUrl(argv: string[]): CliCommand {
	let json = false;
	let maxBytes: number | undefined;
	let updateSurfaces = false;
	let url: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--update-surfaces") {
			updateSurfaces = true;
			continue;
		}
		if (arg === "--url") {
			url = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--max-bytes") {
			maxBytes = parsePositiveNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		throw new UsageError(`unknown intake-url option: ${arg}`);
	}

	return { kind: "intake-url", json, maxBytes, updateSurfaces, url: requireNonBlank(url, "--url") };
}

function parseJudgment(argv: string[]): CliCommand {
	let json = false;
	let noteId: string | undefined;
	const fields: JudgmentFields = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--note") {
			noteId = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--attraction") {
			fields.attraction = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--inferred-intent") {
			fields.inferredIntent = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--choice") {
			fields.choice = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--rejection") {
			fields.rejection = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--hesitation") {
			fields.hesitation = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--reason") {
			fields.reason = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--outcome") {
			fields.outcome = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--correction") {
			fields.correction = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown judgment option: ${arg}`);
	}
	if (!noteId?.trim()) throw new UsageError("judgment requires --note <id>");
	if (!Object.values(fields).some((value) => value?.trim())) {
		throw new UsageError("judgment requires at least one judgment field");
	}
	return { kind: "judgment", fields, json, noteId };
}

function parseJournal(argv: string[]): CliCommand {
	let json = false;
	let journalKind: SamanthaJournalKind | undefined;
	let content: string | undefined;
	let runPath: string | undefined;
	let source: string | undefined;
	let timestamp: string | undefined;
	let title: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--kind") {
			const value = requireOptionValue(argv[++i], arg);
			if (value !== "daily" && value !== "weekly") throw new UsageError("--kind must be daily or weekly");
			journalKind = value;
			continue;
		}
		if (arg === "--text") {
			content = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--run" || arg === "--heartbeat-run") {
			runPath = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--source") {
			source = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--timestamp") {
			timestamp = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--title") {
			title = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown journal option: ${arg}`);
	}
	if (!journalKind) throw new UsageError("journal requires --kind daily|weekly");
	return {
		kind: "journal",
		content: requireNonBlank(content, "--text"),
		journalKind,
		json,
		runPath,
		source,
		timestamp,
		title,
	};
}

function parseTaste(argv: string[]): CliCommand {
	let differsFromFeiRule: string | undefined;
	let judgment: string | undefined;
	let json = false;
	let reason: string | undefined;
	let source: string | undefined;
	let timestamp: string | undefined;
	let title: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--title") {
			title = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--judgment") {
			judgment = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--reason") {
			reason = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--differs-from-fei-rule") {
			differsFromFeiRule = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--source") {
			source = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--timestamp") {
			timestamp = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown taste option: ${arg}`);
	}
	return {
		kind: "taste",
		title: requireNonBlank(title, "--title"),
		judgment: requireNonBlank(judgment, "--judgment"),
		reason: requireNonBlank(reason, "--reason"),
		json,
		...(differsFromFeiRule ? { differsFromFeiRule } : {}),
		...(source ? { source } : {}),
		...(timestamp ? { timestamp } : {}),
	};
}

function parseMemoryStatusCommand(argv: string[]): CliCommand {
	let json = false;
	let noteId: string | undefined;
	let status: WorldNoteData["memoryStatus"] | undefined;
	let reason: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--note") {
			noteId = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--status") {
			status = parseMemoryStatus(requireOptionValue(argv[++i], arg));
			continue;
		}
		if (arg === "--reason") {
			reason = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown memory-status option: ${arg}`);
	}
	if (!noteId?.trim()) throw new UsageError("memory-status requires --note <id>");
	if (!status) throw new UsageError("memory-status requires --status <active|archive_only|needs_deep_read>");
	return {
		kind: "memory-status",
		json,
		noteId,
		reason: requireNonBlank(reason, "--reason"),
		status,
	};
}

function parsePrivacyCheck(argv: string[]): CliCommand {
	let json = false;
	const refs: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--ref") {
			refs.push(requireOptionValue(argv[++i], arg));
			continue;
		}
		throw new UsageError(`unknown privacy-check option: ${arg}`);
	}
	if (refs.length === 0) throw new UsageError("privacy-check requires at least one --ref <memory-path>");
	return { kind: "privacy-check", json, refs };
}

async function buildStatusPayload(memoryDir: string, memory: Memory): Promise<CliStatusPayload> {
	const status = await memory.syncStatus();
	return {
		memoryDir,
		status,
		lastSyncedAt: status.lastSyncedAt ?? null,
		lastSyncedAtError: status.lastSyncedAtError,
	};
}

async function buildFreshStatusPayload(memoryDir: string, env: NodeJS.ProcessEnv): Promise<CliStatusPayload> {
	return buildStatusPayload(memoryDir, createCliMemory(memoryDir, env));
}

async function updateSurfaces(memory: Memory, enabled: boolean): Promise<CliSurfaceUpdateResult> {
	if (!enabled) {
		return {
			status: "skipped",
			topicMaps: [],
			ideas: [],
			reason: "pass --update-surfaces to refresh related topics and ideas after intake",
		};
	}
	const topicMaps: string[] = [];
	try {
		topicMaps.push(...(await memory.buildTopicMaps()));
		const ideas = await memory.generateIdeas();
		return { status: "updated", topicMaps, ideas };
	} catch (error) {
		return { status: "failed", topicMaps, ideas: [], error: errorMessage(error) };
	}
}

async function runTelegramBridgeCycle(
	memoryDir: string,
	opts: {
		ackText?: string;
		allowedChatId: string;
		baseUrl?: string;
		chatId: string;
		cwd: string;
		env: NodeJS.ProcessEnv;
		limit?: number;
		replyMode: TelegramReplyMode;
		timeoutSeconds?: number;
		token: string;
	},
): Promise<TelegramBridgeCycleResult> {
	const poll = await pollTelegramInbox(memoryDir, {
		allowedChatId: opts.allowedChatId,
		baseUrl: opts.baseUrl,
		limit: opts.limit,
		timeoutSeconds: opts.timeoutSeconds,
		token: opts.token,
	});
	const acknowledgements: TelegramBridgeAcknowledgement[] = [];
	const confirmations: TelegramConfirmationResult[] = [];
	const replies: TelegramBridgeReply[] = [];
	for (const queued of poll.queued) {
		const sentAt = new Date().toISOString();
		const confirmation = await recordTelegramConfirmationFromText(memoryDir, queued.text, { now: sentAt });
		if (confirmation.status !== "ignored" || confirmation.code) {
			confirmations.push(confirmation);
			const text =
				confirmation.status === "approved"
					? `已记录确认：${confirmation.actionId ?? confirmation.code}。\n安全规则：Telegram 只记录批准，不会直接执行动作。`
					: confirmation.status === "rejected"
						? `已记录拒绝：${confirmation.actionId ?? confirmation.code}。`
						: `确认没有生效：${confirmation.reason ?? "无法匹配确认请求"}。`;
			const message = await sendTelegramMessage({
				baseUrl: opts.baseUrl,
				chatId: opts.chatId,
				text,
				token: opts.token,
			});
			acknowledgements.push({
				messageId: message.message_id,
				path: queued.path ?? "",
				sentAt,
				updateId: queued.updateId,
			});
			continue;
		}
		if (opts.replyMode === "pi") {
			const text = await generatePiTelegramReply({
				cwd: opts.cwd,
				env: opts.env,
				memoryDir,
				messageText: queued.text ?? "",
				queuedPath: queued.path ?? "",
			});
			const message = await sendTelegramMessage({
				baseUrl: opts.baseUrl,
				chatId: opts.chatId,
				text: trimTelegramBridgeText(text),
				token: opts.token,
			});
			replies.push({
				messageId: message.message_id,
				path: queued.path ?? "",
				responder: "pi",
				sentAt,
				updateId: queued.updateId,
			});
			continue;
		}
		const text =
			opts.ackText ??
			[
				"收到，已进入 Her inbox。",
				queued.path ? `path: ${queued.path}` : undefined,
				"安全规则：Telegram 消息只入队，不会被自动执行。",
			]
				.filter(Boolean)
				.join("\n");
		const message = await sendTelegramMessage({
			baseUrl: opts.baseUrl,
			chatId: opts.chatId,
			text,
			token: opts.token,
		});
		acknowledgements.push({
			messageId: message.message_id,
			path: queued.path ?? "",
			sentAt,
			updateId: queued.updateId,
		});
	}
	const outbox = await pushTelegramOutbox(memoryDir, {
		baseUrl: opts.baseUrl,
		chatId: opts.chatId,
		limit: opts.limit,
		token: opts.token,
	});
	return { acknowledgements, confirmations, outbox, poll, replies };
}

async function generatePiTelegramReply(opts: {
	cwd: string;
	env: NodeJS.ProcessEnv;
	memoryDir: string;
	messageText: string;
	queuedPath: string;
}): Promise<string> {
	const cli = resolve(opts.cwd, opts.env.HER_TELEGRAM_PI_CLI ?? join("packages", "coding-agent", "dist", "cli.js"));
	const tools = parseTelegramResponderTools(opts.env.HER_TELEGRAM_PI_TOOLS);
	const args = [
		cli,
		"--approve",
		"--provider",
		opts.env.HER_TELEGRAM_PI_PROVIDER?.trim() || "openai-codex",
		"--model",
		opts.env.HER_TELEGRAM_PI_MODEL?.trim() || "gpt-5.4-mini:low",
		"--print",
		"--no-builtin-tools",
		"--tools",
		tools,
		buildTelegramPiPrompt({
			messageText: opts.messageText,
			queuedPath: opts.queuedPath,
			tools,
		}),
	];
	const timeout = parseOptionalPositiveNumber(opts.env.HER_TELEGRAM_PI_TIMEOUT_MS) ?? 180_000;
	const childEnv: NodeJS.ProcessEnv = { ...process.env, ...opts.env, HER_MEMORY_DIR: opts.memoryDir };
	const stdout = await runPiTelegramProcess(args, {
		cwd: opts.cwd,
		env: childEnv,
		timeout,
	});
	const reply = stdout.trim();
	if (!reply) throw new Error("Pi Telegram responder returned an empty reply");
	return reply;
}

function runPiTelegramProcess(
	args: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Pi Telegram responder timed out after ${opts.timeout}ms`));
		}, opts.timeout);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				resolvePromise(stdout);
				return;
			}
			const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
			reject(new Error(`Pi Telegram responder exited ${signal ?? code}${detail}`));
		});
	});
}

function buildTelegramPiPrompt(opts: { messageText: string; queuedPath: string; tools: string }): string {
	return [
		"你是 Samantha/Her 的 Telegram 正式聊天入口。",
		"任务：回答 Fei 从 Telegram 发来的消息。",
		"",
		"安全边界：",
		`- 只允许使用这些 Her tools：${opts.tools}`,
		"- 不要运行 shell、读写任意文件、git、安装依赖、修改代码或操作系统。",
		"- 如果用户要求远程执行高风险动作，只说明需要回到本地 Codex/Pi 会话确认。",
		"",
		"回答风格：",
		"- 中文。",
		"- 第一段先给结论。",
		"- 默认不超过 120 字。",
		"- 必要时可以说明你查了哪些记忆。",
		"- 不要只回复“收到”。",
		"",
		`Inbox path: ${opts.queuedPath || "(unknown)"}`,
		"",
		"Telegram message:",
		opts.messageText || "(empty)",
	].join("\n");
}

function trimTelegramBridgeText(text: string): string {
	const limit = 4096;
	if (text.length <= limit) return text;
	const suffix = "\n\n[trimmed for Telegram message limit]";
	return `${text.slice(0, limit - suffix.length)}${suffix}`;
}

function parseTelegramResponderTools(raw: string | undefined): string {
	const values = (raw?.trim() ? raw : defaultTelegramResponderTools.join(","))
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	if (values.length === 0) {
		throw new UsageError("HER_TELEGRAM_PI_TOOLS must include at least one read-only Telegram responder tool");
	}
	const rejected = values.filter((tool) => !telegramResponderReadOnlyTools.has(tool));
	if (rejected.length > 0) {
		throw new UsageError(
			`HER_TELEGRAM_PI_TOOLS may only include read-only Telegram responder tools: ${defaultTelegramResponderTools.join(", ")}. Rejected: ${rejected.join(", ")}`,
		);
	}
	return [...new Set(values)].join(",");
}

function renderStatus(payload: CliStatusPayload): string {
	return [
		`Her memory sync: ${payload.status.status}`,
		`memory dir: ${payload.memoryDir}`,
		`branch: ${payload.status.branch ?? "(unknown)"}`,
		`last successful push: ${payload.lastSyncedAt ?? "(unknown)"}`,
		`pending local memories: ${payload.status.pending}`,
		`dirty files: ${payload.status.dirtyFiles}`,
		`ahead commits: ${payload.status.aheadCommits}`,
		payload.lastSyncedAtError ? `last sync timestamp error: ${payload.lastSyncedAtError}` : undefined,
		payload.status.error ? `error: ${payload.status.error}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

function renderSync(payload: CliSyncPayload): string {
	const result =
		payload.result.status === "clean"
			? "Her memory is already synced."
			: `Her memory pushed: ${payload.result.commit}`;
	return `${result}\n\n${renderStatus(payload)}`;
}

function renderConsolidate(payload: CliConsolidatePayload): string {
	return [
		`Her memory consolidated ${payload.result.episodes} episode(s).`,
		`notes touched: ${payload.result.notesTouched}`,
		`becoming moments: ${payload.result.moments}`,
		"",
		renderStatus(payload),
	].join("\n");
}

function renderDecay(payload: CliDecayPayload): string {
	const archived = payload.result.archivedKeys.length > 0 ? payload.result.archivedKeys.join(", ") : "(none archived)";
	return [
		`Her memory decay sweep archived ${payload.result.archived} note(s).`,
		`archived keys: ${archived}`,
		`kept notes: ${payload.result.kept}`,
		"",
		renderStatus(payload),
	].join("\n");
}

function renderGoldenEval(payload: CliGoldenEvalPayload): string {
	const categories = payload.result.categories
		.map((category) => `- ${category.category}: ${category.score}/${category.maxScore}`)
		.join("\n");
	const alerts = payload.result.alerts.length
		? payload.result.alerts.map((alert) => `- ${alert.kind}: ${alert.message}`).join("\n")
		: "- none";
	return [
		`Her golden evals ${payload.result.status}: ${payload.result.score}/${payload.result.maxScore}`,
		categories,
		"",
		"Alerts:",
		alerts,
		"",
		renderStatus(payload),
	].join("\n");
}

function renderRestore(payload: CliRestorePayload): string {
	return [`Her memory restored archived semantic note: ${payload.result.key}`, "", renderStatus(payload)].join("\n");
}

function renderGoal(payload: CliGoalPayload): string {
	return [
		`Her long task ${payload.result.status}: ${payload.result.id}`,
		`objective: ${payload.result.objective}`,
		`path: ${payload.result.path}`,
		`next: ${payload.result.nextContinuation ?? "(none)"}`,
		"",
		renderStatus(payload),
	].join("\n");
}

function renderGoalComplete(payload: CliGoalCompletePayload): string {
	return [
		`Her long task completed: ${payload.result.task.id}`,
		`path: ${payload.result.task.path}`,
		`memory note: ${payload.result.memoryNoteId ?? "(not written)"}`,
		"",
		renderStatus(payload),
	].join("\n");
}

function renderGoalList(payload: CliGoalListPayload): string {
	const lines = payload.result.map((task) => `${task.status}\t${task.id}\t${task.objective}`);
	return [
		`Her long tasks: ${payload.result.length}`,
		...(lines.length ? lines : ["(none)"]),
		"",
		renderStatus(payload),
	].join("\n");
}

function renderGoalNext(payload: CliGoalNextPayload): string {
	if (!payload.result) return [`Her long task next: (none)`, "", renderStatus(payload)].join("\n");
	return [
		`Her long task claimed: ${payload.result.id}`,
		`objective: ${payload.result.objective}`,
		`next: ${payload.result.nextContinuation ?? "(none)"}`,
		`claimed by: ${payload.result.claimedBy ?? "(unknown)"}`,
		`lease until: ${payload.result.claimExpiresAt ?? "(unknown)"}`,
		`path: ${payload.result.path}`,
		"",
		renderStatus(payload),
	].join("\n");
}

function renderTelegramPoll(payload: CliTelegramPollPayload): string {
	return [
		`Her Telegram poll received: ${payload.result.received}`,
		`queued: ${payload.result.queued.length}`,
		`ignored: ${payload.result.ignored.length}`,
		`rejected: ${payload.result.rejected.length}`,
		`next offset: ${payload.result.nextOffset ?? "(unchanged)"}`,
		"",
		renderStatus(payload),
	].join("\n");
}

function renderTelegramOutbox(payload: CliTelegramOutboxPayload): string {
	const sent = payload.result.sent.length > 0 ? payload.result.sent.map((item) => item.path).join(", ") : "(none)";
	const skipped =
		payload.result.skipped.length > 0
			? payload.result.skipped.map((item) => `${item.path} (${item.reason})`).join(", ")
			: "(none)";
	return [
		`Her Telegram outbox sent: ${payload.result.sent.length}`,
		`sent paths: ${sent}`,
		`skipped: ${skipped}`,
		"",
		renderStatus(payload),
	].join("\n");
}

function renderTelegramConfirmation(payload: CliTelegramConfirmationPayload): string {
	return [
		`Her Telegram confirmation created: ${payload.result.actionId}`,
		`code: ${payload.result.code}`,
		`expires: ${payload.result.expiresAt}`,
		`path: ${payload.result.path}`,
		"outbox queued: yes",
		"execution: not performed by Telegram",
		"",
		renderStatus(payload),
	].join("\n");
}

function renderTelegramBridge(payload: CliTelegramBridgePayload): string {
	return [
		`Her Telegram bridge poll received: ${payload.result.poll.received}`,
		`queued: ${payload.result.poll.queued.length}`,
		`acknowledged: ${payload.result.acknowledgements.length}`,
		`confirmations: ${payload.result.confirmations.length}`,
		`replied: ${payload.result.replies.length}`,
		`outbox sent: ${payload.result.outbox.sent.length}`,
		`rejected: ${payload.result.poll.rejected.length}`,
		`next offset: ${payload.result.poll.nextOffset ?? "(unchanged)"}`,
		"",
		renderStatus(payload),
	].join("\n");
}

function renderApprove(payload: CliApprovePayload): string {
	return [`Her proposal approved: ${payload.result.proposalId}`, "", renderStatus(payload)].join("\n");
}

function renderCapture(payload: CliCapturePayload): string {
	return [`Her memory captured: ${payload.result.id}`, "", renderStatus(payload)].join("\n");
}

function renderJudgment(payload: CliJudgmentPayload): string {
	return [`Her judgment recorded for world note: ${payload.result.noteId}`, "", renderStatus(payload)].join("\n");
}

function renderJournal(payload: CliJournalPayload): string {
	return [`Her journal saved: ${payload.result.path}`, `kind: ${payload.result.kind}`, "", renderStatus(payload)].join(
		"\n",
	);
}

function renderTaste(payload: CliTastePayload): string {
	return [`Her taste judgment saved: ${payload.result.path}`, "", renderStatus(payload)].join("\n");
}

function renderMemoryStatus(payload: CliMemoryStatusPayload): string {
	return [
		`Her memory status set for world note: ${payload.result.noteId} -> ${payload.result.status}`,
		"",
		renderStatus(payload),
	].join("\n");
}

function renderPrivacyAudit(payload: CliPrivacyAuditPayload): string {
	return [
		`Her privacy classification updated: ${payload.result.total} file(s).`,
		`frontmatter: ${payload.result.frontmatter}`,
		`sidecar inferred: ${payload.result.inferred}`,
		`ledger: ${payload.result.file}`,
		"",
		renderStatus(payload),
	].join("\n");
}

function renderPrivacyCheck(payload: CliPrivacyCheckPayload): string {
	const result = payload.result.allowed
		? `Her privacy check passed: ${payload.result.checked.length} ref(s).`
		: `Her privacy check blocked ${payload.result.blocked.length} private/intimate and ${payload.result.unknown.length} unknown ref(s).`;
	return [result, "", renderStatus(payload)].join("\n");
}

function renderRecall(payload: CliRecallPayload): string {
	const hits =
		payload.result.length > 0
			? payload.result
					.map((note, index) => {
						const excerpt = note.text.trim().replace(/\s+/g, " ").slice(0, 500);
						return `${index + 1}. ${note.id} (${note.kind}, score=${note.score.toFixed(4)})\n${excerpt}`;
					})
					.join("\n\n")
			: "(none)";
	return [`Her recall hits: ${payload.result.length}`, hits, "", renderStatus(payload)].join("\n");
}

function renderSynthesize(payload: CliSynthesizePayload): string {
	const result =
		payload.result.proposalId === null
			? "Her synthesize skipped: not due."
			: `Her narrative synthesized: ${payload.result.proposalId}`;
	return [result, "", renderStatus(payload)].join("\n");
}

function renderSynthesizeDue(payload: CliSynthesizeDuePayload): string {
	const reason = payload.result.due ? ` (${payload.result.reason})` : "";
	return [`Her synthesize due: ${payload.result.due}${reason}`, "", renderStatus(payload)].join("\n");
}

function renderTopicMaps(payload: { result: string[] } & CliStatusPayload): string {
	const written = payload.result.length > 0 ? payload.result.join(", ") : "(none)";
	return [`Her topic maps written: ${written}`, "", renderStatus(payload)].join("\n");
}

function renderIdeas(
	payload: { result: Array<{ id: string; title: string; kind: string }> } & CliStatusPayload,
): string {
	const written = payload.result.length > 0 ? payload.result.map((idea) => idea.title).join(", ") : "(none)";
	return [`Her ideas written: ${written}`, "", renderStatus(payload)].join("\n");
}

function renderIntakeSource(payload: CliIntakeSourcePayload): string {
	return [
		`Her intake source saved: ${payload.result.noteId}`,
		`content hash: ${payload.result.contentHash}`,
		`recall hits: ${payload.result.recall.map((note) => note.id).join(", ") || "(none)"}`,
		renderSurfaceUpdate(payload.result.surfaces),
		"",
		renderStatus(payload),
	].join("\n");
}

function renderIntakeUrl(payload: CliIntakeUrlPayload): string {
	return [
		`Her intake URL saved: ${payload.result.noteId}`,
		`title: ${payload.result.title}`,
		`source: ${payload.result.sourceUrl}`,
		`memory status: ${payload.result.memoryStatus}`,
		`bytes read: ${payload.result.bytesRead}${payload.result.truncated ? " (truncated)" : ""}`,
		`content hash: ${payload.result.contentHash}`,
		`recall hits: ${payload.result.recall.map((note) => note.id).join(", ") || "(none)"}`,
		renderSurfaceUpdate(payload.result.surfaces),
		"",
		renderStatus(payload),
	].join("\n");
}

function renderIntakePath(payload: CliIntakePathPayload): string {
	return [
		`Her intake path saved: ${payload.result.noteId}`,
		`title: ${payload.result.title}`,
		`path: ${payload.result.path}`,
		`memory status: ${payload.result.memoryStatus}`,
		`bytes read: ${payload.result.bytesRead}${payload.result.truncated ? " (truncated)" : ""}`,
		`content hash: ${payload.result.contentHash}`,
		`recall hits: ${payload.result.recall.map((note) => note.id).join(", ") || "(none)"}`,
		renderSurfaceUpdate(payload.result.surfaces),
		"",
		renderStatus(payload),
	].join("\n");
}

function renderBootstrapFeed(payload: CliBootstrapFeedPayload): string {
	const files =
		payload.result.files.length > 0
			? payload.result.files
					.map(
						(file, index) =>
							`${index + 1}. ${file.noteId} - ${file.title} (${file.bytesRead} bytes${file.truncated ? ", truncated" : ""})`,
					)
					.join("\n")
			: "(none)";
	return [
		`Her bootstrap feed saved ${payload.result.files.length} file(s):`,
		files,
		renderSurfaceUpdate(payload.result.surfaces),
		"",
		renderStatus(payload),
	].join("\n");
}

function renderSurfaceUpdate(result: CliSurfaceUpdateResult): string {
	const topics = result.topicMaps.length > 0 ? result.topicMaps.join(", ") : "(none)";
	const ideas = result.ideas.length > 0 ? result.ideas.map((idea) => idea.title).join(", ") : "(none)";
	const detail = result.error ? `; error: ${result.error}` : result.reason ? `; ${result.reason}` : "";
	return `surface update: ${result.status}; topics: ${topics}; ideas: ${ideas}${detail}`;
}

function renderChoiceModel(payload: CliChoiceModelPayload): string {
	return [`Her choice model synthesized: ${payload.result.commit}`, "", renderStatus(payload)].join("\n");
}

function renderSelfNarrative(payload: CliSelfNarrativePayload): string {
	return [`Her self narrative synthesized: ${payload.result.commit}`, "", renderStatus(payload)].join("\n");
}

function writePayload<T>(
	stream: NodeJS.WritableStream,
	payload: T,
	json: boolean,
	render: (payload: T) => string,
): void {
	writeLine(stream, json ? JSON.stringify(payload, null, 2) : render(payload));
}

function writeLine(stream: NodeJS.WritableStream, text: string): void {
	stream.write(`${text}\n`);
}

function usage(): string {
	return `Usage:
  her approve --proposal <id> [--json]
  her bootstrap-feed --path <file-or-dir> [--path <file-or-dir>] [--max-bytes <n>] [--update-surfaces] [--json]
  her capture --text <text> [--project <name>] [--session <id>] [--timestamp <ISO>] [--json]
  her choice-model [--json]
  her consolidate [--limit <n>] [--json]
  her decay [--older-than-days <days>] [--now <YYYY-MM-DD>] [--json]
  her eval-golden [--write-baseline] [--now <ISO>] [--json]
  her goal-start --objective <text> [--source <text>] [--owner <text>] [--next <text>] [--json]
  her goal-checkpoint --id <id> --summary <text> [--status active|blocked] [--next <text>] [--evidence <ref>] [--json]
  her goal-complete --id <id> --outcome <text> [--remember <text>] [--json]
  her goal-list [--status active|blocked|completed|cancelled] [--json]
  her goal-next [--runner <id>] [--lease-minutes <n>] [--now <ISO>] [--json]
  her ideas [--json]
  her intake-source --title <title> --source-url <url> --source-type <kind> --extracted <text> --coverage <text> --read <text> --take <text> [--memory-status active|archive_only|needs_deep_read] [--memory-status-reason <text>] [--claim-json <json>] [--steal <text>] [--connection <id>] [--possible-move <text>] [--update-surfaces] [--json]
  her intake-path --path <file> [--source-type <kind>] [--max-bytes <n>] [--update-surfaces] [--json]
  her intake-url --url <url> [--max-bytes <n>] [--update-surfaces] [--json]
  her judgment --note <id> [--choice <text>] [--correction <text>] [--reason <text>] [--attraction <text>] [--inferred-intent <text>] [--rejection <text>] [--hesitation <text>] [--outcome <text>] [--json]
  her journal --kind daily|weekly --text <text> [--title <text>] [--source <text>] [--timestamp <ISO>] [--run <memory-path>] [--json]
  her memory-status --note <id> --status active|archive_only|needs_deep_read --reason <text> [--json]
  her privacy-audit [--json]
  her privacy-check --ref <memory-path> [--ref <memory-path>] [--json]
  her recall --query <text> [--k <n>] [--archive] [--json]
  her restore --semantic <key> [--now <YYYY-MM-DD>] [--json]
  her self-narrative [--json]
  her synthesize [--if-due] [--json]
  her synthesize-due [--json]
  her sync --status [--json]
  her sync [--message <message>] [--json]
  her status [--json]
  her taste --title <title> --judgment <text> --reason <text> [--differs-from-fei-rule <text>] [--source <text>] [--timestamp <ISO>] [--json]
  her telegram-bridge [--timeout <seconds>] [--interval <seconds>] [--limit <n>] [--reply|--reply-mode ack|pi] [--ack-text <text>] [--once] [--json]
  her telegram-confirm-request --action-id <id> --summary <text> [--tier <tier>] [--expires-at <ISO>] [--code <code>] [--json]
  her telegram-poll [--timeout <seconds>] [--limit <n>] [--offset <n>] [--json]
  her telegram-push-outbox [--limit <n>] [--dry-run] [--json]
  her topic-maps [--json]

Memory root:
  HER_MEMORY_DIR, defaulting to ../her-memory from the current working directory.

Telegram:
  HER_TELEGRAM_BOT_TOKEN, HER_TELEGRAM_CHAT_ID, optional HER_TELEGRAM_BASE_URL for local tests.`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parsePositiveNumber(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`${option} must be a positive number`);
	return parsed;
}

function parseOptionalPositiveNumber(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError("HER_TELEGRAM_PI_TIMEOUT_MS must be positive");
	return parsed;
}

function parseNonNegativeNumber(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`${option} must be a non-negative number`);
	return parsed;
}

function requireOptionValue(value: string | undefined, option: string): string {
	if (!value) throw new UsageError(`${option} requires a value`);
	return value;
}

function requireNonBlank(value: string | undefined, option: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new UsageError(`${option} cannot be blank`);
	return trimmed;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
	return requireNonBlank(env[name], name);
}

function parseMemoryStatus(value: string): WorldNoteData["memoryStatus"] {
	if (value === "active" || value === "archive_only" || value === "needs_deep_read") return value;
	throw new UsageError("--memory-status must be active, archive_only, or needs_deep_read");
}

function parseGoalStatus(value: string): LongTaskStatus {
	if (longTaskStatuses.includes(value as LongTaskStatus)) return value as LongTaskStatus;
	throw new UsageError("--status must be active, blocked, completed, or cancelled");
}

function parseGoalCheckpointStatus(value: string): Extract<LongTaskStatus, "active" | "blocked"> {
	if (value === "active" || value === "blocked") return value;
	throw new UsageError("--status must be active or blocked for goal-checkpoint");
}

function parseClaimJson(value: string): ClaimLedgerEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new UsageError(`--claim-json must be valid JSON: ${errorMessage(error)}`);
	}
	if (!parsed || typeof parsed !== "object") throw new UsageError("--claim-json must be a JSON object");
	const record = parsed as Record<string, unknown>;
	const verdict = record.verdict;
	const sourceQuality = record.sourceQuality;
	if (verdict !== "supported" && verdict !== "contradicted" && verdict !== "insufficient_evidence") {
		throw new UsageError("--claim-json verdict must be supported, contradicted, or insufficient_evidence");
	}
	if (
		sourceQuality !== "primary" &&
		sourceQuality !== "secondary" &&
		sourceQuality !== "weak" &&
		sourceQuality !== "unavailable" &&
		sourceQuality !== "blocked"
	) {
		throw new UsageError("--claim-json sourceQuality must be primary, secondary, weak, unavailable, or blocked");
	}
	const claim = requireNonBlank(stringField(record, "claim"), "claim");
	const evidence = requireNonBlank(stringField(record, "evidence"), "evidence");
	const caveats = stringField(record, "caveats")?.trim();
	return {
		claim,
		verdict,
		evidence,
		sourceQuality,
		...(caveats ? { caveats } : {}),
	};
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" ? value : undefined;
}

function intakeContentHash(sourceUrl: string, extracted: string): string {
	return createHash("sha256").update(`${sourceUrl}\n${extracted}`).digest("hex");
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedUrl) {
	process.exitCode = await runHerCli();
}
