/**
 * G-120 — detach launcher + kill-tree stop for harness background tasks.
 * Completion authority is the .done sentinel written by task-runner.mjs.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { accessSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RUNNER = fileURLToPath(new URL("./task-runner.mjs", import.meta.url));

export type PidInfo = {
	runnerPid: number;
	workerPid: number | null;
	startedAt: string;
};

export type ResolvedCommand = { file: string; args: string[] };

/** Resolve Windows .cmd/.bat shims so spawn(shell:false) does not throw EINVAL. */
export function resolveWorkerCommand(command: readonly string[]): ResolvedCommand {
	if (command.length === 0) throw new Error("command required");
	const [cmd, ...rest] = command;
	if (!cmd) throw new Error("command[0] required");

	if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
		const comspec = process.env.ComSpec || "cmd.exe";
		return { file: comspec, args: ["/d", "/s", "/c", cmd, ...rest] };
	}

	if (process.platform === "win32" && !/[\\/]/.test(cmd) && !/\.[a-z0-9]+$/i.test(cmd)) {
		try {
			const stdout = execFileSync("where.exe", [cmd], {
				encoding: "utf8",
				windowsHide: true,
			});
			const candidates = stdout
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter(Boolean);
			const nonCmd = candidates.find((c) => !/\.(cmd|bat)$/i.test(c));
			if (nonCmd) return { file: nonCmd, args: rest };
			if (candidates[0]) {
				const comspec = process.env.ComSpec || "cmd.exe";
				return { file: comspec, args: ["/d", "/s", "/c", candidates[0], ...rest] };
			}
		} catch {
			/* fall through — spawn may still work for builtins */
		}
	}

	return { file: cmd, args: rest };
}

export function launchTask(
	taskDir: string,
	id: string,
	command: readonly string[],
	options?: { env?: NodeJS.ProcessEnv; heartbeatMs?: number; cwd?: string },
): number {
	const resolved = resolveWorkerCommand(command);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...(options?.env ?? {}),
		HER_TASK_ID: id,
	};
	if (options?.heartbeatMs) {
		env.HER_TASK_HEARTBEAT_MS = String(options.heartbeatMs);
	}
	// Worker cwd (worktree) is separate from taskDir where .pid/.log/.done live.
	if (options?.cwd) {
		env.HER_TASK_CWD = options.cwd;
	}

	const child = spawn(process.execPath, [RUNNER, taskDir, id, resolved.file, ...resolved.args], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		cwd: taskDir,
		env,
	});
	child.unref();
	if (child.pid === undefined) throw new Error(`launch failed for task ${id}`);
	return child.pid;
}

export function readPidFile(taskDir: string, id: string): PidInfo | null {
	const path = join(taskDir, `${id}.pid`);
	try {
		accessSync(path);
	} catch {
		return null;
	}
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as Partial<PidInfo>;
		if (typeof data.runnerPid !== "number") return null;
		return {
			runnerPid: data.runnerPid,
			workerPid: typeof data.workerPid === "number" ? data.workerPid : null,
			startedAt: typeof data.startedAt === "string" ? data.startedAt : "",
		};
	} catch {
		return null;
	}
}

export async function stopTask(taskDir: string, id: string): Promise<"stopped" | "already_gone"> {
	const pidInfo = readPidFile(taskDir, id);
	if (!pidInfo) return "already_gone";

	if (process.platform === "win32") {
		try {
			await execFileAsync("taskkill", ["/PID", String(pidInfo.runnerPid), "/T", "/F"], { windowsHide: true });
		} catch {
			// already dead → still success (idempotent)
		}
	} else {
		try {
			process.kill(-pidInfo.runnerPid, "SIGTERM");
		} catch {
			try {
				process.kill(pidInfo.runnerPid, "SIGTERM");
			} catch {
				/* gone */
			}
		}
	}
	return "stopped";
}
