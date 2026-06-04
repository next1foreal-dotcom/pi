import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Memory, type MemorySyncStatus } from "./her-core/index.ts";

const execFileAsync = promisify(execFile);

type CliCommand =
	| { kind: "help" }
	| { kind: "status"; json: boolean }
	| { kind: "sync"; json: boolean; message?: string };

interface CliStatusPayload {
	memoryDir: string;
	status: MemorySyncStatus;
	lastSyncedAt: string | null;
	lastSyncedAtError?: string;
}

interface CliSyncPayload extends CliStatusPayload {
	result: Awaited<ReturnType<Memory["sync"]>>;
}

interface CliIo {
	stdout: NodeJS.WritableStream;
	stderr: NodeJS.WritableStream;
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): CliCommand {
	const [command, ...rest] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") return { kind: "help" };
	if (command === "status") return parseStatus(rest);
	if (command === "sync") return parseSync(rest);
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
	const memory = new Memory(memoryDir);

	if (command.kind === "status") {
		const payload = await buildStatusPayload(memoryDir, memory);
		writePayload(io.stdout, payload, command.json, renderStatus);
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
  her sync --status [--json]
  her sync [--message <message>] [--json]
  her status [--json]

Memory root:
  HER_MEMORY_DIR, defaulting to ../her-memory from the current working directory.`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedUrl) {
	process.exitCode = await runHerCli();
}
