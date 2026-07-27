// Shared worker-run body for task-runner.mjs and warm-slot.mjs.
// Writes .pid / .heartbeat / .log / .done under taskDir for the given id.
import { spawn } from "node:child_process";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {{
 *   taskDir: string,
 *   id: string,
 *   cmd: string,
 *   args: string[],
 *   env?: NodeJS.ProcessEnv,
 *   heartbeatMs?: number,
 *   cwd?: string,
 *   stdinPath?: string,
 *   verbatimArgs?: boolean,
 * }} opts
 */
export function runTaskWorker(opts) {
	const { taskDir, id, cmd, args } = opts;
	const p = (ext) => join(taskDir, `${id}.${ext}`);
	const HEARTBEAT_MS = Number(opts.heartbeatMs ?? process.env.HER_TASK_HEARTBEAT_MS ?? 15_000);

	const logFd = openSync(p("log"), "a");

	const stdinPath = (opts.stdinPath ?? process.env.HER_TASK_STDIN)?.trim();
	let stdin0 = "ignore";
	if (stdinPath) {
		try {
			stdin0 = openSync(stdinPath, "r");
		} catch {
			closeSync(logFd);
			const payload = JSON.stringify(
				{ exitCode: -1, detail: "brief_missing", endedAt: new Date().toISOString() },
				null,
				2,
			);
			writeFileSync(p("done.tmp"), payload);
			renameSync(p("done.tmp"), p("done"));
			process.exit(0);
		}
	}

	const workerCwd = (opts.cwd ?? process.env.HER_TASK_CWD)?.trim() || taskDir;
	const verbatimArgs = opts.verbatimArgs === true || process.env.HER_TASK_VERBATIM_ARGS === "1";
	const env = { ...(opts.env ?? process.env), HER_TASK_ID: id };
	const child = spawn(cmd, args, {
		stdio: [stdin0, logFd, logFd],
		windowsHide: true,
		windowsVerbatimArguments: verbatimArgs,
		cwd: workerCwd,
		env,
	});

	writeFileSync(
		p("pid"),
		JSON.stringify(
			{
				runnerPid: process.pid,
				workerPid: child.pid ?? null,
				startedAt: new Date().toISOString(),
				warm: Boolean(process.env.HER_TASK_WARM_SLOT),
			},
			null,
			2,
		),
	);

	const beat = () => {
		try {
			writeFileSync(p("heartbeat"), new Date().toISOString());
		} catch {
			/* retry next tick */
		}
	};
	beat();
	const timer = setInterval(beat, HEARTBEAT_MS);
	timer.unref?.();

	let finished = false;
	const finish = (exitCode, detail) => {
		if (finished) return;
		finished = true;
		clearInterval(timer);
		try {
			closeSync(logFd);
		} catch {
			/* ignore */
		}
		const payload = JSON.stringify(
			{
				exitCode,
				detail: detail ?? null,
				endedAt: new Date().toISOString(),
			},
			null,
			2,
		);
		writeFileSync(p("done.tmp"), payload);
		renameSync(p("done.tmp"), p("done"));
		process.exit(0);
	};

	child.on("exit", (code, signal) => finish(code ?? -1, signal ? `signal:${signal}` : null));
	child.on("error", (err) => finish(-1, `spawn_error:${err.message}`));
}
