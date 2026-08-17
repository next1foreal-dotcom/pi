import { appendEvent, HOST_RUNNERS, isHostRunner } from "../her-core/event-history.ts";
import { verifyEventHistoryPrefix } from "../her-core/event-history-verify.ts";
import { sendTelegramMessage } from "../her-core/telegram.ts";
import { writeLine } from "./render.ts";
import type { CliIo } from "./types.ts";
import { errorMessage, requireOptionValue, UsageError } from "./utils.ts";

const detailLimit = 200;

interface HostEventRequest {
	action: "run-start" | "run-end" | "restart-planned";
	runner: string;
	runId: string;
	ok?: boolean;
	exitCode?: number;
	detail?: string;
}

export async function runHostEventCommand(args: string[], memoryDir: string, io: CliIo): Promise<number> {
	let request: HostEventRequest;
	try {
		request = parseHostEventArgs(args);
	} catch (error) {
		writeLine(io.stderr, errorMessage(error));
		return 2;
	}
	try {
		await appendEvent(kindForAction(request.action), request.runner, dataForAction(request), undefined, memoryDir);
		return 0;
	} catch (error) {
		writeLine(io.stderr, `her host-event: ${errorMessage(error)}`);
		return 1;
	}
}

export async function runEventsVerifyCommand(memoryDir: string, io: CliIo, env: NodeJS.ProcessEnv): Promise<number> {
	const result = await verifyEventHistoryPrefix({
		root: memoryDir,
		sendAlert: (text) =>
			sendTelegramMessage({
				token: env.HER_TELEGRAM_BOT_TOKEN ?? "",
				chatId: env.HER_TELEGRAM_CHAT_ID ?? "",
				baseUrl: env.HER_TELEGRAM_BASE_URL,
				text,
			}),
	});
	if (result.ok) {
		writeLine(io.stdout, "event-history verify: ok");
		return 0;
	}
	writeLine(io.stderr, `event-history verify: ${result.reason ?? "red"}`);
	return 1;
}

function parseHostEventArgs(args: string[]): HostEventRequest {
	const action = args[0];
	if (action !== "run-start" && action !== "run-end" && action !== "restart-planned") {
		throw new UsageError("host-event requires run-start|run-end|restart-planned");
	}
	let runner: string | undefined;
	let runId: string | undefined;
	let ok: boolean | undefined;
	let exitCode: number | undefined;
	let detail: string | undefined;
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--actor") throw new UsageError("host-event does not accept --actor");
		if (arg === "--runner") {
			runner = requireOptionValue(args[++i], arg);
			continue;
		}
		if (arg === "--run-id") {
			runId = requireOptionValue(args[++i], arg);
			continue;
		}
		if (arg === "--ok") {
			ok = parseOk(requireOptionValue(args[++i], arg));
			continue;
		}
		if (arg === "--exit-code") {
			exitCode = parseExitCode(requireOptionValue(args[++i], arg));
			continue;
		}
		if (arg === "--detail") {
			detail = requireOptionValue(args[++i], arg).slice(0, detailLimit);
			continue;
		}
		throw new UsageError(`unknown host-event option: ${arg}`);
	}
	if (!runner || !isHostRunner(runner)) {
		throw new UsageError(`host-event --runner must be one of ${HOST_RUNNERS.join("|")}`);
	}
	if (!runId || runId.trim() === "") throw new UsageError("host-event requires --run-id");
	if (action === "run-end" && ok === undefined) throw new UsageError("host-event run-end requires --ok true|false");
	return {
		action,
		runner,
		runId,
		...(ok !== undefined ? { ok } : {}),
		...(exitCode !== undefined ? { exitCode } : {}),
		...(detail ? { detail } : {}),
	};
}

function parseOk(value: string): boolean {
	if (value === "true") return true;
	if (value === "false") return false;
	throw new UsageError("--ok must be true or false");
}

function parseExitCode(value: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || String(parsed) !== value) throw new UsageError("--exit-code must be an integer");
	return parsed;
}

function kindForAction(action: HostEventRequest["action"]): "host.run.start" | "host.run.end" | "host.restart_planned" {
	if (action === "run-start") return "host.run.start";
	if (action === "run-end") return "host.run.end";
	return "host.restart_planned";
}

function dataForAction(request: HostEventRequest): Record<string, unknown> {
	return {
		runId: request.runId,
		...(request.ok !== undefined ? { ok: request.ok } : {}),
		...(request.exitCode !== undefined ? { exitCode: request.exitCode } : {}),
		...(request.detail ? { detail: request.detail } : {}),
	};
}
