import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

export interface EvaluationProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	error?: string;
}

/** Executes HOST-TRUSTED evaluator code, never a script supplied by the candidate.
 * Child separation, an empty environment and byte/time limits are not an OS sandbox.
 */
export async function runEvaluationProcess(opts: {
	evaluatorFile: string;
	request: string;
	timeoutMs: number;
	maxOutputBytes: number;
	signal?: AbortSignal;
}): Promise<EvaluationProcessResult> {
	if (opts.signal?.aborted) throw new Error("evaluation aborted");
	const start = performance.now();
	return new Promise((resolve) => {
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let error: string | undefined;
		const grouped = process.platform !== "win32";
		const child = spawn(process.execPath, [opts.evaluatorFile], {
			cwd: dirname(opts.evaluatorFile),
			env: {},
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			detached: grouped,
			windowsHide: true,
		});
		const stop = (reason: string) => {
			error ??= reason;
			try {
				if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch (caught) {
				if ((caught as NodeJS.ErrnoException).code !== "ESRCH") error += "; process cleanup failed";
			}
		};
		const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
			const remaining = Math.max(0, opts.maxOutputBytes - stdout.length - stderr.length);
			const kept = chunk.subarray(0, remaining);
			if (stream === "stdout") stdout = Buffer.concat([stdout, kept]);
			else stderr = Buffer.concat([stderr, kept]);
			if (chunk.length > remaining) stop("evaluation output limit exceeded");
		};
		const abort = () => stop("evaluation aborted");
		const timer = setTimeout(() => stop("evaluation timed out"), opts.timeoutMs);
		opts.signal?.addEventListener("abort", abort, { once: true });
		if (opts.signal?.aborted) abort();
		child.stdout.on("data", (data: Buffer) => collect(data, "stdout"));
		child.stderr.on("data", (data: Buffer) => collect(data, "stderr"));
		child.on("error", () => stop("evaluation process failed to start"));
		child.stdin.on("error", () => stop("evaluation input delivery failed"));
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", abort);
			// Clean up descendants in the evaluator process group on supported hosts.
			if (grouped && child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					/* Already exited. */
				}
			}
			if (
				!Buffer.from(stdout.toString("utf8")).equals(stdout) ||
				!Buffer.from(stderr.toString("utf8")).equals(stderr)
			) {
				error ??= "evaluator emitted invalid UTF-8";
			}
			resolve({
				exitCode,
				stdout: stdout.toString("utf8"),
				stderr: stderr.toString("utf8"),
				durationMs: performance.now() - start,
				...(error ? { error } : {}),
			});
		});
		child.stdin.end(opts.request);
	});
}
