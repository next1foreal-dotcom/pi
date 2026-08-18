import { readDrainState, startDrain, stopDrain, waitForQuiet } from "../her-core/drain.ts";
import { sendTelegramMessage } from "../her-core/telegram.ts";
import { writeLine } from "./render.ts";
import type { CliIo } from "./types.ts";
import { errorMessage, requireOptionValue, UsageError } from "./utils.ts";

export async function runDrainStartCommand(
	args: string[],
	memoryDir: string,
	io: CliIo,
	env: NodeJS.ProcessEnv,
): Promise<number> {
	try {
		const parsed = parseStartArgs(args);
		const result = await startDrain({
			by: parsed.by,
			memoryDir,
			notify: parsed.notify,
			reason: parsed.reason,
			sendNotify: parsed.notify ? (text) => notifyTelegram(env, text) : undefined,
			ttlMinutes: parsed.ttlMinutes,
		});
		if (result.overwritten) writeLine(io.stderr, "warning: overwriting active drain flag");
		if (result.ttlWarning) writeLine(io.stderr, `warning: ${result.ttlWarning}`);
		if (result.notifyWarning) writeLine(io.stderr, result.notifyWarning);
		if (parsed.json) {
			writeLine(
				io.stdout,
				JSON.stringify({
					active: true,
					expiresAt: result.flag.expiresAt,
					reason: result.flag.reason,
					remainingSeconds: Math.max(0, Math.floor((Date.parse(result.flag.expiresAt) - Date.now()) / 1000)),
				}),
			);
		} else {
			writeLine(io.stdout, `drain: active`);
			writeLine(io.stdout, `reason: ${result.flag.reason}`);
			writeLine(io.stdout, `by: ${result.flag.by}`);
			writeLine(io.stdout, `expires: ${result.flag.expiresAt}`);
		}
		return 0;
	} catch (error) {
		return fail(io, error);
	}
}

export async function runDrainStopCommand(
	args: string[],
	memoryDir: string,
	io: CliIo,
	env: NodeJS.ProcessEnv,
): Promise<number> {
	try {
		const parsed = parseFlagArgs(args, "drain-stop");
		const result = await stopDrain({
			memoryDir,
			notify: parsed.notify,
			sendNotify: parsed.notify ? (text) => notifyTelegram(env, text) : undefined,
		});
		if (result.notifyWarning) writeLine(io.stderr, result.notifyWarning);
		if (parsed.json) {
			writeLine(io.stdout, JSON.stringify({ existed: result.existed }));
		} else if (result.existed) {
			writeLine(io.stdout, "drain: stopped (was active)");
		} else {
			writeLine(io.stdout, "drain: already inactive");
		}
		return 0;
	} catch (error) {
		return fail(io, error);
	}
}

export async function runDrainStatusCommand(args: string[], memoryDir: string, io: CliIo): Promise<number> {
	try {
		const json = parseJsonOnly(args, "drain-status");
		const state = await readDrainState(memoryDir);
		if (state.warning) writeLine(io.stderr, `warning: ${state.warning}`);
		if (json) {
			writeLine(
				io.stdout,
				JSON.stringify({
					active: state.active,
					expiresAt: state.active ? (state.expiresAt ?? null) : null,
					reason: state.active ? (state.reason ?? null) : null,
					remainingSeconds: state.active ? state.remainingSeconds : 0,
				}),
			);
		} else if (state.active) {
			writeLine(io.stdout, "drain: active");
			writeLine(io.stdout, `reason: ${state.reason}`);
			writeLine(io.stdout, `expires: ${state.expiresAt}`);
			writeLine(io.stdout, `remaining-seconds: ${state.remainingSeconds}`);
		} else {
			writeLine(io.stdout, "drain: inactive");
		}
		return 0;
	} catch (error) {
		return fail(io, error);
	}
}

export async function runDrainWaitCommand(args: string[], memoryDir: string, io: CliIo): Promise<number> {
	try {
		const parsed = parseWaitArgs(args);
		const result = await waitForQuiet({
			memoryDir,
			timeoutSeconds: parsed.timeoutSeconds,
		});
		if (parsed.json) {
			writeLine(
				io.stdout,
				JSON.stringify({
					elapsedSeconds: result.elapsedSeconds,
					ok: result.ok,
					...(result.ok ? {} : { running: result.running }),
				}),
			);
		} else if (result.ok) {
			writeLine(io.stdout, `quiet after ${result.elapsedSeconds}s`);
		} else {
			writeLine(io.stdout, `timeout after ${result.elapsedSeconds}s`);
			for (const task of result.running) writeLine(io.stdout, `running: ${task.id}`);
		}
		return result.ok ? 0 : 2;
	} catch (error) {
		return fail(io, error);
	}
}

function parseStartArgs(args: string[]): {
	by?: string;
	json: boolean;
	notify: boolean;
	reason: string;
	ttlMinutes?: number;
} {
	let by: string | undefined;
	let json = false;
	let notify = false;
	let reason: string | undefined;
	let ttlMinutes: number | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--reason") {
			reason = requireOptionValue(args[++i], arg);
			continue;
		}
		if (arg === "--by") {
			by = requireOptionValue(args[++i], arg);
			continue;
		}
		if (arg === "--ttl-minutes") {
			ttlMinutes = Number(requireOptionValue(args[++i], arg));
			continue;
		}
		if (arg === "--notify") {
			notify = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		throw new UsageError(`unknown drain-start option: ${arg}`);
	}
	if (!reason || reason.trim() === "") throw new UsageError("drain-start requires --reason");
	return { by, json, notify, reason, ttlMinutes };
}

function parseFlagArgs(args: string[], command: string): { json: boolean; notify: boolean } {
	let json = false;
	let notify = false;
	for (const arg of args) {
		if (arg === "--notify") {
			notify = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		throw new UsageError(`unknown ${command} option: ${arg}`);
	}
	return { json, notify };
}

function parseJsonOnly(args: string[], command: string): boolean {
	let json = false;
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		throw new UsageError(`unknown ${command} option: ${arg}`);
	}
	return json;
}

function parseWaitArgs(args: string[]): { json: boolean; timeoutSeconds: number } {
	let json = false;
	let timeoutSeconds = 1800;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--timeout-seconds") {
			timeoutSeconds = Number(requireOptionValue(args[++i], arg));
			if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
				throw new UsageError("--timeout-seconds must be a non-negative number");
			}
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		throw new UsageError(`unknown drain-wait option: ${arg}`);
	}
	return { json, timeoutSeconds };
}

async function notifyTelegram(env: NodeJS.ProcessEnv, text: string): Promise<void> {
	await sendTelegramMessage({
		baseUrl: env.HER_TELEGRAM_BASE_URL,
		chatId: env.HER_TELEGRAM_CHAT_ID ?? "",
		text,
		token: env.HER_TELEGRAM_BOT_TOKEN ?? "",
	});
}

function fail(io: CliIo, error: unknown): number {
	writeLine(io.stderr, errorMessage(error));
	return error instanceof UsageError ? 2 : 1;
}
