import type { ClaimLedgerEntry, LongTaskStatus, PriorMode, WorldNoteData } from "../her-core/index.ts";
import {
	parseJournal,
	parseJudgment,
	parseMemoryStatusCommand,
	parsePrivacyCheck,
	parseTaste,
} from "./parse-personal.ts";
import type { CliCommand, TelegramReplyMode } from "./types.ts";
import {
	intakeContentHash,
	parseClaimJson,
	parseGoalCheckpointStatus,
	parseGoalStatus,
	parseMemoryStatus,
	parseNonNegativeNumber,
	parsePositiveNumber,
	requireNonBlank,
	requireOptionValue,
	UsageError,
} from "./utils.ts";

export function parseArgs(argv: string[]): CliCommand {
	const [command, ...rest] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") return { kind: "help" };
	if (command === "approve") return parseApprove(rest);
	if (command === "backfill") return parseBackfill(rest);
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
	if (command === "prior") return parsePrior(rest);
	if (command === "recall") return parseRecall(rest);
	if (command === "review-narrative") return parseReviewNarrative(rest);
	if (command === "restore") return parseRestore(rest);
	if (command === "self-narrative") return parseJsonOnly("self-narrative", rest);
	if (command === "surface") return parseJsonOnly("surface", rest);
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

function parseJsonOnly(
	kind: "choice-model" | "ideas" | "privacy-audit" | "self-narrative" | "surface" | "synthesize-due" | "topic-maps",
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

function parseBackfill(argv: string[]): CliCommand {
	let batchSize: number | undefined;
	let budgetUsd: number | undefined;
	let dryRun = false;
	let finalize = false;
	let json = false;
	let maxBatches: number | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--batch-size") {
			batchSize = parsePositiveNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		if (arg === "--budget-usd") {
			budgetUsd = parsePositiveNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--finalize") {
			finalize = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--max-batches") {
			maxBatches = parsePositiveNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		throw new UsageError(`unknown backfill option: ${arg}`);
	}
	if (!dryRun && budgetUsd === undefined) throw new UsageError("backfill requires --budget-usd unless --dry-run");
	return { batchSize, budgetUsd, dryRun, finalize, json, kind: "backfill", maxBatches };
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

function parseReviewNarrative(argv: string[]): CliCommand {
	let action: "list" | "keep" | "revert" = "list";
	let id: string | undefined;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--keep" || arg === "--revert") {
			if (action !== "list") throw new UsageError("review-narrative accepts only one action");
			action = arg === "--keep" ? "keep" : "revert";
			id = requireNonBlank(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		throw new UsageError(`unknown review-narrative option: ${arg}`);
	}
	return { action, id, json, kind: "review-narrative" };
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

function parsePrior(argv: string[]): CliCommand {
	let budget: number | undefined;
	let json = false;
	let mode: PriorMode = "full";
	let task: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--task") {
			task = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--budget") {
			budget = parsePositiveNumber(requireOptionValue(argv[++i], arg), arg);
			continue;
		}
		if (arg === "--off") {
			if (mode !== "full") throw new UsageError("prior accepts only one mode flag");
			mode = "off";
			continue;
		}
		if (arg === "--her-only") {
			if (mode !== "full") throw new UsageError("prior accepts only one mode flag");
			mode = "her-only";
			continue;
		}
		throw new UsageError(`unknown prior option: ${arg}`);
	}
	return { budget, json, kind: "prior", mode, task };
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
