import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	type ChoiceModelUpdateResult,
	type ConsolidateResult,
	type DecaySweepResult,
	loadConfig,
	Memory,
	type MemorySyncStatus,
	OpenAICompatibleModel,
	type SelfNarrativeUpdateResult,
} from "./her-core/index.ts";
import { createSummaryModel } from "./summary-model.ts";

const execFileAsync = promisify(execFile);

type CliCommand =
	| { kind: "approve"; json: boolean; proposalId: string }
	| { kind: "capture"; json: boolean; text: string; project?: string; sessionId?: string; timestamp?: string }
	| { kind: "choice-model"; json: boolean }
	| { kind: "consolidate"; json: boolean; limit?: number }
	| { kind: "decay"; json: boolean; olderThanDays?: number; now?: string }
	| { kind: "help" }
	| { kind: "ideas"; json: boolean }
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
	return new Memory(memoryDir, model);
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

async function buildStatusPayload(memoryDir: string, memory: Memory): Promise<CliStatusPayload> {
	const status = await memory.syncStatus();
	const lastSync = await readLastSyncedAt(memoryDir);
	return {
		memoryDir,
		status,
		lastSyncedAt: lastSync.value,
		lastSyncedAtError: lastSync.error,
	};
}

async function readLastSyncedAt(memoryDir: string): Promise<{ value: string | null; error?: string }> {
	try {
		// Git does not store a durable push timestamp locally; upstream HEAD time is the closest sync signal.
		const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%cI", "@{upstream}"], { cwd: memoryDir });
		return { value: stdout.trim() || null };
	} catch (error) {
		return { value: null, error: errorMessage(error) };
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

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedUrl) {
	process.exitCode = await runHerCli();
}
