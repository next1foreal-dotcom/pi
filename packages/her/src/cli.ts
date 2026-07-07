import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseArgs } from "./cli/parse.ts";
import {
	renderApprove,
	renderBackfill,
	renderBootstrapFeed,
	renderCapture,
	renderChoiceModel,
	renderConsolidate,
	renderDecay,
	renderDispatch,
	renderEvalTrend,
	renderGoal,
	renderGoalComplete,
	renderGoalList,
	renderGoalNext,
	renderGoldenEval,
	renderIdeas,
	renderIntakePath,
	renderIntakeSource,
	renderIntakeUrl,
	renderJournal,
	renderJudgment,
	renderLint,
	renderMemoryStatus,
	renderPrior,
	renderPrivacyAudit,
	renderPrivacyCheck,
	renderRecall,
	renderRestore,
	renderReviewNarrative,
	renderSelfNarrative,
	renderStatus,
	renderSurface,
	renderSync,
	renderSynthesize,
	renderSynthesizeDue,
	renderTaste,
	renderTelegramBridge,
	renderTelegramConfirmation,
	renderTelegramOutbox,
	renderTelegramPoll,
	renderTopicMaps,
	renderVoiceTaskCompleteNotify,
	renderVoiceTaskEnqueue,
	usage,
	writeLine,
	writePayload,
} from "./cli/render.ts";
import {
	type CliBootstrapFeedPayload,
	type CliCommand,
	type CliIo,
	type CliStatusPayload,
	type CliSurfaceUpdateResult,
	type CliVoiceTaskCompleteNotifyPayload,
	type CliVoiceTaskEnqueuePayload,
	defaultTelegramResponderTools,
	type TelegramBridgeAcknowledgement,
	type TelegramBridgeCycleResult,
	type TelegramBridgeReply,
	type TelegramReplyMode,
	telegramResponderReadOnlyTools,
} from "./cli/types.ts";
import { errorMessage, parseOptionalPositiveNumber, requireEnv, UsageError } from "./cli/utils.ts";
import {
	assemblePrior,
	checkMemoryExport,
	checkpointLongTask,
	claimNextLongTask,
	classifyMemoryCorpus,
	collectPathIntakeFiles,
	completeLongTask,
	createEmbeddingSearch,
	createTelegramConfirmationRequest,
	frontmatter,
	listLongTasks,
	loadConfig,
	Memory,
	OpenAICompatibleModel,
	pollTelegramInbox,
	pushTelegramOutbox,
	readPathForWorldNote,
	readUrlForWorldNote,
	recordTelegramConfirmationFromText,
	runDispatch,
	runEvalTrend,
	runGoldenEvals,
	runMemoryLint,
	StorePaths,
	sendTelegramMessage,
	startLongTask,
	type TelegramConfirmationResult,
	trimTelegramText,
	type UrlMarkdownReader,
	writeText,
} from "./her-core/index.ts";
import { redactSecrets } from "./her-core/store.ts";
import { createSummaryModel } from "./summary-model.ts";

export { parseArgs } from "./cli/parse.ts";

const execFileAsync = promisify(execFile);

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

	if (command.kind === "prior") {
		const result = await assemblePrior({
			budget: command.budget,
			mode: command.mode,
			storeRoot: memoryDir,
			task: command.task,
		});
		writePayload(io.stdout, { memoryDir, result }, command.json, renderPrior);
		return 0;
	}

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

		const retryDelayMs =
			parseNonNegativeEnvNumber(env.HER_TELEGRAM_RETRY_DELAY_MS) ?? DEFAULT_TELEGRAM_RETRY_DELAY_MS;
		const maxConsecutiveFailures =
			parsePositiveEnvInt(env.HER_TELEGRAM_MAX_CONSECUTIVE_FAILURES) ?? DEFAULT_TELEGRAM_MAX_CONSECUTIVE_FAILURES;
		const maxCycles = parsePositiveEnvInt(env.HER_TELEGRAM_BRIDGE_MAX_CYCLES);
		let consecutiveFailures = 0;
		let cycles = 0;
		for (;;) {
			cycles += 1;
			let result: TelegramBridgeCycleResult;
			try {
				result = await runTelegramBridgeCycle(memoryDir, options);
			} catch (error) {
				consecutiveFailures += 1;
				await recordTelegramBridgeCycleFailure(memoryDir, error, io.stderr);
				if (consecutiveFailures >= maxConsecutiveFailures) {
					writeLine(
						io.stderr,
						`her telegram-bridge: ${consecutiveFailures} consecutive cycle failures (threshold ${maxConsecutiveFailures}); exiting`,
					);
					return 1;
				}
				if (command.once) return 1;
				if (maxCycles !== undefined && cycles >= maxCycles) return 1;
				await sleep(retryDelayMs);
				continue;
			}
			consecutiveFailures = 0;
			const payload = { ...(await buildFreshStatusPayload(memoryDir, env)), result };
			writePayload(io.stdout, payload, command.json, renderTelegramBridge);
			if (command.once) return payload.status.status === "unknown" ? 1 : 0;
			if (maxCycles !== undefined && cycles >= maxCycles) return payload.status.status === "unknown" ? 1 : 0;
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

	if (command.kind === "voice-task-enqueue") {
		const result = await queueVoiceTask(memoryDir, command.objective);
		const payload: CliVoiceTaskEnqueuePayload = { ...(await buildFreshStatusPayload(memoryDir, env)), result };
		writePayload(io.stdout, payload, command.json, renderVoiceTaskEnqueue);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "voice-task-notify-complete") {
		const result = await queueVoiceTaskCompletion(memoryDir, command.objective, command.outcome, command.taskPath);
		const payload: CliVoiceTaskCompleteNotifyPayload = { ...(await buildFreshStatusPayload(memoryDir, env)), result };
		writePayload(io.stdout, payload, command.json, renderVoiceTaskCompleteNotify);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	const memory = createCliMemory(memoryDir, env);

	if (command.kind === "status") {
		const payload = await buildStatusPayload(memoryDir, memory);
		writePayload(io.stdout, payload, command.json, renderStatus);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "backfill") {
		const result = await memory.backfill({
			batchSize: command.batchSize,
			budgetUsd: command.budgetUsd,
			dryRun: command.dryRun,
			finalize: command.finalize,
			maxBatches: command.maxBatches,
		});
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderBackfill);
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

	if (command.kind === "dispatch") {
		const result = await runDispatch({
			budgetUsd: command.budgetUsd,
			cwd: command.cwd ? resolve(cwd, command.cwd) : cwd,
			env,
			executor: command.executor,
			handoffPath: resolve(cwd, command.handoffPath),
			label: command.label,
			memoryDir,
			timeoutMin: command.timeoutMin,
		});
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderDispatch);
		if (payload.status.status === "unknown") return 1;
		return result.status === "completed" ? 0 : 1;
	}

	if (command.kind === "eval-golden") {
		const result = await runGoldenEvals(memoryDir, { now: command.now, writeBaseline: command.writeBaseline });
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderGoldenEval);
		if (payload.status.status === "unknown") return 1;
		return result.status === "pass" ? 0 : 1;
	}

	if (command.kind === "eval-trend") {
		const report = await runEvalTrend(memoryDir);
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), report };
		writePayload(io.stdout, payload, command.json, renderEvalTrend);
		return payload.status.status === "unknown" ? 1 : 0;
	}
	if (command.kind === "lint") {
		const result = await runMemoryLint(memoryDir);
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderLint);
		return payload.status.status === "unknown" ? 1 : 0;
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

	if (command.kind === "review-narrative") {
		if (command.action === "keep" && command.id) await memory.keepContextUpdate(command.id);
		if (command.action === "revert" && command.id) await memory.revertContextUpdate(command.id);
		const updates = await memory.reviewContextUpdates();
		const payload = {
			...(await buildStatusPayload(memoryDir, memory)),
			result: { action: command.action, ...(command.id ? { id: command.id } : {}), updates },
		};
		writePayload(io.stdout, payload, command.json, renderReviewNarrative);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "synthesize-due") {
		const result = await memory.synthesizeDue();
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderSynthesizeDue);
		return payload.status.status === "unknown" ? 1 : 0;
	}

	if (command.kind === "surface") {
		// Resurface a relevant note the user hasn't seen this session (retrieval —
		// no model call). cooldown 0 so a UI can pull one on demand.
		const note = await memory.surface({ sessionId: "samantha-ui", cooldownMinutes: 0 });
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result: { note: note ?? null } };
		writePayload(io.stdout, payload, command.json, renderSurface);
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
				const plan = await resolveShellSafeSpawnPlan(command, [url.href, "--mode", "smart"]);
				const { stdout } = await execFileAsync(plan.command, plan.args, {
					env,
					maxBuffer: Math.max(opts.maxBytes * 2, 256_000),
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
				const plan = await resolveShellSafeSpawnPlan(command, ["parse", url.href, "--markdown"]);
				const { stdout } = await execFileAsync(plan.command, plan.args, {
					env,
					maxBuffer: Math.max(opts.maxBytes * 2, 512_000),
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

const NPM_CMD_SHIM_TARGET = /"([^"]+)"\s+%\*\s*$/;

/**
 * Runs `command` with `args` as literal argv elements — never a shell-concatenated string.
 * cmd.exe's own command-line parser treats &, |, <, >, ^ as syntax even inside quoted segments
 * (this is why execFile's `shell: true`, and even a manual `cmd.exe /c` wrap, can still let a URL's
 * metacharacters be reinterpreted). Node also cannot spawn a .cmd/.bat file directly without a
 * shell, so on Windows this reads the .cmd shim's own source (developer/install-controlled, not
 * attacker-controlled) and resolves past it to the real script it wraps — the same technique
 * dispatch.ts's selectCodexSpawnPlan uses for the codex.cmd shim, generalized to any npm
 * cmd-shim-style .cmd file (curl.md, defuddle). The resolved script is then run via `node`, so
 * no shell is ever invoked on the attacker-influenced argv.
 */
export async function resolveShellSafeSpawnPlan(
	command: string,
	args: string[],
	nodePath = process.execPath,
): Promise<{ args: string[]; command: string }> {
	if (process.platform !== "win32" || !command.toLowerCase().endsWith(".cmd")) return { args, command };
	const shimText = await readFile(command, "utf8").catch(() => undefined);
	const rawTarget = shimText && NPM_CMD_SHIM_TARGET.exec(shimText)?.[1];
	if (!rawTarget) throw new Error(`could not resolve the script wrapped by cmd shim: ${command}`);
	// cmd-shim templates reference the shim's own directory as %dp0%; substitute it before resolving.
	const target = resolve(rawTarget.replace(/%dp0%/gi, dirname(command)));
	return { command: nodePath, args: [target, ...args] };
}

function commandCandidates(explicitCommand: string | undefined, commandName: string, cwd: string): string[] {
	if (explicitCommand?.trim()) return [explicitCommand.trim()];
	const suffix = process.platform === "win32" ? ".cmd" : "";
	const localCommand = resolve(cwd, "node_modules", ".bin", `${commandName}${suffix}`);
	const commands = existsSync(localCommand) ? [localCommand, commandName] : [commandName];
	return [...new Set(commands)];
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

const DEFAULT_TELEGRAM_RETRY_DELAY_MS = 5000;
const DEFAULT_TELEGRAM_MAX_CONSECUTIVE_FAILURES = 10;

async function recordTelegramBridgeCycleFailure(
	memoryDir: string,
	error: unknown,
	stderr: NodeJS.WritableStream,
): Promise<void> {
	const ts = new Date().toISOString();
	const errorClass = error instanceof Error ? error.constructor.name : "UnknownError";
	const message = errorMessage(error);
	writeLine(stderr, `her telegram-bridge: cycle failed (${errorClass}): ${message}`);
	const entry = { tool: "her_telegram_bridge_cycle", ts, status: "failed", errorClass, error: message };
	const auditDir = join(memoryDir, "audit");
	const auditFile = join(auditDir, `${ts.slice(0, 10)}.jsonl`);
	await mkdir(auditDir, { recursive: true });
	await appendFile(auditFile, `${JSON.stringify(entry)}\n`, "utf8");
}

function parseNonNegativeEnvNumber(value: string | undefined): number | undefined {
	if (!value?.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePositiveEnvInt(value: string | undefined): number | undefined {
	if (!value?.trim()) return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
				text: trimTelegramText(text),
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

async function queueVoiceTask(root: string, rawObjective: string): Promise<CliVoiceTaskEnqueuePayload["result"]> {
	const now = new Date().toISOString();
	const objective = redactSecrets(rawObjective).trim();
	if (!objective) throw new UsageError("voice-task-enqueue requires --objective <text>");
	const paths = new StorePaths(root);
	await mkdir(paths.inboxTasks, { recursive: true });
	const fileName = `${safeVoiceTimestamp(now)}-voice-${randomUUID().slice(0, 8)}.md`;
	const path = `tasks/inbox/${fileName}`;
	await writeText(
		join(paths.inboxTasks, fileName),
		[
			frontmatter({
				type: "her_voice_inbox",
				source: "voice",
				status: "queued",
				created: now,
				objective,
			}).trimEnd(),
			"",
			"# Voice Inbox Item",
			"",
			"Spoken task request queued from the voice interface; it is not active until triaged.",
			"",
			"## Objective",
			"",
			objective,
			"",
		].join("\n"),
	);
	return { created: now, objective, path, status: "queued" };
}

async function queueVoiceTaskCompletion(
	root: string,
	rawObjective: string,
	rawOutcome: string,
	taskPath?: string,
): Promise<CliVoiceTaskCompleteNotifyPayload["result"]> {
	const objective = redactSecrets(rawObjective.trim());
	const outcome = redactSecrets(rawOutcome.trim());
	if (!objective) throw new UsageError("voice-task-notify-complete requires --objective <text>");
	if (!outcome) throw new UsageError("voice-task-notify-complete requires --outcome <text>");
	const created = new Date().toISOString();
	const path = `outbox/${safeVoiceTimestamp(created)}-voice-complete-${randomUUID().slice(0, 8)}.md`;
	const safeTaskPath = taskPath?.trim() ? redactSecrets(taskPath.trim()) : undefined;
	await writeText(
		join(root, path),
		[
			`完成通知：${objective}`,
			"",
			`结果：${outcome}`,
			"",
			"来源：voice",
			safeTaskPath ? `任务：${safeTaskPath}` : undefined,
			"",
		]
			.filter((line) => line !== undefined)
			.join("\n"),
	);
	return { created, objective, outcome, path, ...(safeTaskPath ? { taskPath: safeTaskPath } : {}) };
}
function safeVoiceTimestamp(value: string): string {
	return value.replace(/[:.]/g, "-").replace(/[^A-Za-z0-9_-]/g, "-");
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

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedUrl) {
	process.exitCode = await runHerCli();
}
