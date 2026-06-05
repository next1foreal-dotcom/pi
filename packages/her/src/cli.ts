import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type ChoiceModelUpdateResult,
	type ClaimLedgerEntry,
	type ConsolidateResult,
	createEmbeddingSearch,
	type DecaySweepResult,
	type JudgmentFields,
	loadConfig,
	Memory,
	type MemorySyncStatus,
	OpenAICompatibleModel,
	readUrlForWorldNote,
	type SelfNarrativeUpdateResult,
	type WorldNoteData,
} from "./her-core/index.ts";
import { createSummaryModel } from "./summary-model.ts";

type CliCommand =
	| { kind: "approve"; json: boolean; proposalId: string }
	| { kind: "capture"; json: boolean; text: string; project?: string; sessionId?: string; timestamp?: string }
	| { kind: "choice-model"; json: boolean }
	| { kind: "consolidate"; json: boolean; limit?: number }
	| { kind: "decay"; json: boolean; olderThanDays?: number; now?: string }
	| { kind: "help" }
	| { kind: "ideas"; json: boolean }
	| { kind: "intake-source"; data: WorldNoteData; json: boolean; updateSurfaces: boolean }
	| { kind: "intake-url"; json: boolean; maxBytes?: number; updateSurfaces: boolean; url: string }
	| { kind: "judgment"; fields: JudgmentFields; json: boolean; noteId: string }
	| { kind: "memory-status"; json: boolean; noteId: string; reason: string; status: WorldNoteData["memoryStatus"] }
	| { kind: "recall"; archive: boolean; json: boolean; k?: number; query: string }
	| { kind: "restore"; json: boolean; semanticKey: string; now?: string }
	| { kind: "self-narrative"; json: boolean }
	| { kind: "synthesize"; json: boolean; ifDue: boolean }
	| { kind: "synthesize-due"; json: boolean }
	| { kind: "status"; json: boolean }
	| { kind: "sync"; json: boolean; message?: string }
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

interface CliMemoryStatusPayload extends CliStatusPayload {
	result: {
		noteId: string;
		status: WorldNoteData["memoryStatus"];
	};
}

interface CliRecallPayload extends CliStatusPayload {
	result: Awaited<ReturnType<Memory["recall"]>>;
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
	if (command === "capture") return parseCapture(rest);
	if (command === "choice-model") return parseJsonOnly("choice-model", rest);
	if (command === "consolidate") return parseConsolidate(rest);
	if (command === "decay") return parseDecay(rest);
	if (command === "ideas") return parseJsonOnly("ideas", rest);
	if (command === "intake-source") return parseIntakeSource(rest);
	if (command === "intake-url") return parseIntakeUrl(rest);
	if (command === "judgment") return parseJudgment(rest);
	if (command === "memory-status") return parseMemoryStatusCommand(rest);
	if (command === "recall") return parseRecall(rest);
	if (command === "restore") return parseRestore(rest);
	if (command === "self-narrative") return parseJsonOnly("self-narrative", rest);
	if (command === "synthesize") return parseSynthesize(rest);
	if (command === "synthesize-due") return parseJsonOnly("synthesize-due", rest);
	if (command === "status") return parseStatus(rest);
	if (command === "sync") return parseSync(rest);
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

	if (command.kind === "restore") {
		const result = await memory.restoreArchivedSemantic(command.semanticKey, { now: command.now });
		const payload = { ...(await buildStatusPayload(memoryDir, memory)), result };
		writePayload(io.stdout, payload, command.json, renderRestore);
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
			maxBytes: command.maxBytes,
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

	if (command.kind === "memory-status") {
		await memory.setMemoryStatus(command.noteId, command.status, command.reason);
		const payload = {
			...(await buildStatusPayload(memoryDir, memory)),
			result: { noteId: command.noteId, status: command.status },
		};
		writePayload(io.stdout, payload, command.json, renderMemoryStatus);
		return payload.status.status === "unknown" ? 1 : 0;
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

function parseJsonOnly(
	kind: "choice-model" | "ideas" | "self-narrative" | "synthesize-due" | "topic-maps",
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

async function buildStatusPayload(memoryDir: string, memory: Memory): Promise<CliStatusPayload> {
	const status = await memory.syncStatus();
	return {
		memoryDir,
		status,
		lastSyncedAt: status.lastSyncedAt ?? null,
		lastSyncedAtError: status.lastSyncedAtError,
	};
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

function renderRestore(payload: CliRestorePayload): string {
	return [`Her memory restored archived semantic note: ${payload.result.key}`, "", renderStatus(payload)].join("\n");
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

function renderMemoryStatus(payload: CliMemoryStatusPayload): string {
	return [
		`Her memory status set for world note: ${payload.result.noteId} -> ${payload.result.status}`,
		"",
		renderStatus(payload),
	].join("\n");
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
  her capture --text <text> [--project <name>] [--session <id>] [--timestamp <ISO>] [--json]
  her choice-model [--json]
  her consolidate [--limit <n>] [--json]
  her decay [--older-than-days <days>] [--now <YYYY-MM-DD>] [--json]
  her ideas [--json]
  her intake-source --title <title> --source-url <url> --source-type <kind> --extracted <text> --coverage <text> --read <text> --take <text> [--memory-status active|archive_only|needs_deep_read] [--memory-status-reason <text>] [--claim-json <json>] [--steal <text>] [--connection <id>] [--possible-move <text>] [--update-surfaces] [--json]
  her intake-url --url <url> [--max-bytes <n>] [--update-surfaces] [--json]
  her judgment --note <id> [--choice <text>] [--correction <text>] [--reason <text>] [--attraction <text>] [--inferred-intent <text>] [--rejection <text>] [--hesitation <text>] [--outcome <text>] [--json]
  her memory-status --note <id> --status active|archive_only|needs_deep_read --reason <text> [--json]
  her recall --query <text> [--k <n>] [--archive] [--json]
  her restore --semantic <key> [--now <YYYY-MM-DD>] [--json]
  her self-narrative [--json]
  her synthesize [--if-due] [--json]
  her synthesize-due [--json]
  her sync --status [--json]
  her sync [--message <message>] [--json]
  her status [--json]
  her topic-maps [--json]

Memory root:
  HER_MEMORY_DIR, defaulting to ../her-memory from the current working directory.`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parsePositiveNumber(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`${option} must be a positive number`);
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

function parseMemoryStatus(value: string): WorldNoteData["memoryStatus"] {
	if (value === "active" || value === "archive_only" || value === "needs_deep_read") return value;
	throw new UsageError("--memory-status must be active, archive_only, or needs_deep_read");
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
