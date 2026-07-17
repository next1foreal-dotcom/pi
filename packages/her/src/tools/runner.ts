import { spawn } from "node:child_process";

export interface RunResult {
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	canceled: boolean;
}

export interface RunOptions {
	timeoutMs?: number;
	cwd?: string;
	/** Caller cancellation (the tool's execute signal); combined with the timeout. */
	signal?: AbortSignal;
}

/** Runs an external binary and captures its output. Injected so tests never spawn real tools. */
export interface CommandRunner {
	run(file: string, args: string[], opts?: RunOptions): Promise<RunResult>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class SpawnRunner implements CommandRunner {
	run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
		return new Promise((resolve, reject) => {
			const child = spawn(file, args, { windowsHide: true, cwd: opts.cwd, signal });
			// We never feed stdin. Close it so a tool that unexpectedly prompts (7z asking
			// for a password, ffmpeg asking to overwrite) gets EOF and aborts instead of
			// blocking forever on a read.
			child.stdin?.end();
			let stdout = "";
			let stderr = "";
			let settled = false;
			child.stdout?.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk;
			});
			child.once("error", (error) => {
				if (settled) return;
				settled = true;
				if ((error as Error).name === "AbortError") {
					resolve({
						ok: false,
						exitCode: null,
						stdout,
						stderr,
						timedOut: timeoutSignal.aborted,
						canceled: !timeoutSignal.aborted,
					});
					return;
				}
				reject(error);
			});
			child.once("close", (exitCode) => {
				if (settled) return;
				settled = true;
				resolve({ ok: exitCode === 0, exitCode, stdout, stderr, timedOut: false, canceled: false });
			});
		});
	}
}

/** One-line stdout/stderr/exit digest for reporting a run back to the model. */
export function runSummary(result: RunResult): string {
	return [
		result.stdout.trim(),
		result.stderr.trim(),
		result.timedOut ? "(超时)" : "",
		result.canceled ? "(已取消)" : "",
		result.exitCode === 0 || result.exitCode === null ? "" : `exit ${result.exitCode}`,
	]
		.filter(Boolean)
		.join("\n")
		.trim();
}
