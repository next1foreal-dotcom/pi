/**
 * G-120 — detach launcher + kill-tree stop for harness background tasks.
 * Completion authority is the .done sentinel written by task-runner.mjs.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { accessSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RUNNER = fileURLToPath(new URL("./task-runner.mjs", import.meta.url));

export type PidInfo = {
	runnerPid: number;
	workerPid: number | null;
	startedAt: string;
};

export type ResolvedCommand = { file: string; args: string[]; verbatimArgs?: boolean };

/**
 * F2 (G-129.1) — quote every token unconditionally (cmd.exe's own `""` escape for an embedded
 * quote, not backslash — cmd does not treat `\"` as an escape). An unquoted token containing `&`,
 * `|`, or `^` would let cmd.exe's tokenizer treat it as a command separator/escape once it's past
 * the outer wrap; wrapping every token in quotes keeps those characters literal.
 * Residual risk accepted: `%VAR%` environment-variable expansion happens inside cmd.exe regardless
 * of quoting (quotes only suppress operator/separator parsing, not `%...%` substitution). After F1,
 * the only argv that ever reaches this function is worker/profile config argv — Fei-authored, trusted
 * static input, not a model-controlled string — so this residual is accepted rather than defended.
 */
function quoteCmdArg(arg: string): string {
	return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Build the /C payload for cmd.exe as a single pre-quoted token, then wrap the whole thing in one
 * more layer of quotes. `/S` makes cmd.exe strip only the first and last quote character of the
 * entire /C string before re-tokenizing — without the extra outer wrap, a spaced .cmd path loses its
 * protecting quotes at that step and gets split on the space (verified: it truncates at the space and
 * reports "not recognized"). The double-wrap survives that single strip and leaves the inner quoting
 * intact. Caller must spawn with `windowsVerbatimArguments: true` so Node does not re-quote this.
 */
function buildCmdExeLine(cmd: string, rest: readonly string[]): string {
	const inner = [quoteCmdArg(cmd), ...rest.map(quoteCmdArg)].join(" ");
	return `"${inner}"`;
}

/**
 * Scan PATH directly when a locked-down Windows host denies where.exe.
 */
function findPathCandidates(cmd: string): string[] {
	const names = [cmd, ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => cmd + ext)];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			try {
				accessSync(candidate);
				out.push(candidate);
			} catch {
				/* missing PATH entry */
			}
		}
	}
	return out;
}
/**
 * Resolve Windows .cmd/.bat shims so spawn(shell:false) does not throw EINVAL.
 *
 * F1 (G-129.1) — `allowComspec` (default true) gates whether resolution may hand off to
 * cmd.exe at all. Bare-command mode (spawnBgTask) calls this with `allowComspec: false`:
 * argv there can carry model-controlled strings, and letting it reach cmd.exe's `/C`
 * re-parser is exactly the injection surface D2 bans — worker/profile mode (static,
 * Fei-authored config argv) is the only trusted caller of the ComSpec chain.
 */
export function resolveWorkerCommand(command: readonly string[], opts?: { allowComspec?: boolean }): ResolvedCommand {
	if (command.length === 0) throw new Error("command required");
	const [cmd, ...rest] = command;
	if (!cmd) throw new Error("command[0] required");
	const allowComspec = opts?.allowComspec ?? true;

	if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
		if (!allowComspec) throw new Error("bare command resolves to a cmd.exe shim — use a worker profile");
		const comspec = process.env.ComSpec || "cmd.exe";
		return { file: comspec, args: ["/d", "/s", "/c", buildCmdExeLine(cmd, rest)], verbatimArgs: true };
	}

	if (process.platform === "win32" && !/[\\/]/.test(cmd) && !/\.[a-z0-9]+$/i.test(cmd)) {
		let candidates: string[] = [];
		try {
			const stdout = execFileSync("where.exe", [cmd], {
				encoding: "utf8",
				windowsHide: true,
			});
			candidates = stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
		} catch {
			// Some locked-down Windows hosts deny where.exe to child processes; inspect PATH directly.
			candidates = findPathCandidates(cmd);
		}
		// D7 — npm shims list an extensionless script ahead of the .cmd; only a real .exe/.com is
		// safe to spawn directly. Priority: .exe/.com > .cmd > ignore.
		const exeOrCom = candidates.find((candidate) => /\.(exe|com)$/i.test(candidate));
		if (exeOrCom) return { file: exeOrCom, args: rest };
		const cmdShim = candidates.find((candidate) => /\.(cmd|bat)$/i.test(candidate));
		if (cmdShim) {
			if (!allowComspec) throw new Error("bare command resolves to a cmd.exe shim — use a worker profile");
			const comspec = process.env.ComSpec || "cmd.exe";
			return { file: comspec, args: ["/d", "/s", "/c", buildCmdExeLine(cmdShim, rest)], verbatimArgs: true };
		}
	}

	return { file: cmd, args: rest };
}

export function launchTask(
	taskDir: string,
	id: string,
	command: readonly string[],
	options?: {
		env?: NodeJS.ProcessEnv;
		heartbeatMs?: number;
		cwd?: string;
		stdinPath?: string;
		allowComspec?: boolean;
		/** G-185/S5 — session that spawned this task; reaches the worker as HER_TASK_OWNER_SESSION_ID. */
		ownerSessionId?: string;
	},
): number {
	const resolved = resolveWorkerCommand(command, { allowComspec: options?.allowComspec });
	// D9 — an explicit `env` is a full replacement (worker mode's minimal allowlist), not merged
	// with the launcher's own env; bare command mode omits `env` and keeps full inheritance.
	const base = options?.env ?? process.env;
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (key.startsWith("HER_TASK_")) continue; // strip inherited residue before setting our own
		if (value !== undefined) env[key] = value;
	}
	env.HER_TASK_ID = id;
	// G-185/S5 — must be set *here*, not only in buildWorkerEnv: the loop above strips every
	// inherited HER_TASK_* key, so anything task-scoped has to be (re)placed after the strip.
	// Same shape as HER_TASK_ID, which buildWorkerEnv also sets and this line likewise re-owns.
	if (options?.ownerSessionId) {
		env.HER_TASK_OWNER_SESSION_ID = options.ownerSessionId;
	}
	if (options?.heartbeatMs) {
		env.HER_TASK_HEARTBEAT_MS = String(options.heartbeatMs);
	}
	// Worker cwd (worktree) is separate from taskDir where .pid/.log/.done live.
	if (options?.cwd) {
		env.HER_TASK_CWD = options.cwd;
	}
	if (options?.stdinPath) {
		env.HER_TASK_STDIN = options.stdinPath;
	}
	if (resolved.verbatimArgs) {
		// Tell the runner (a separate process re-parsing argv) that resolved.args is a single
		// pre-quoted cmd.exe line — see buildCmdExeLine's comment for why this is necessary.
		env.HER_TASK_VERBATIM_ARGS = "1";
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
	// The runner only writes its .pid file after its own node process boots, and stopTask
	// treats a missing .pid as "already_gone" without killing anything — so a stop issued
	// inside that boot window would orphan the runner+worker. Write a provisional record
	// here, synchronously, so stopTask can always tree-kill via runnerPid; the runner
	// atomically overwrites it with workerPid once the worker is up (runnerPid alone is
	// enough for the /T tree kill and the POSIX group kill either way).
	const pidPath = join(taskDir, `${id}.pid`);
	const tmpPath = join(taskDir, `${id}.pid.launch.tmp`);
	try {
		writeFileSync(
			tmpPath,
			JSON.stringify({ runnerPid: child.pid, workerPid: null, startedAt: new Date().toISOString() }, null, 2),
		);
		renameSync(tmpPath, pidPath);
	} catch (error) {
		try {
			child.kill();
		} catch {
			/* already gone */
		}
		throw error;
	}
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
