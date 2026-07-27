// Detached runner: watches worker, writes .pid / .heartbeat / .log / .done.
// Never touches <id>.md (launcher is the sole .md writer).
import { spawn } from "node:child_process";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [taskDir, id, cmd, ...args] = process.argv.slice(2);
if (!taskDir || !id || !cmd) {
	console.error("usage: task-runner.mjs <taskDir> <id> <cmd> [args...]");
	process.exit(2);
}

const p = (ext) => join(taskDir, `${id}.${ext}`);
const HEARTBEAT_MS = Number(process.env.HER_TASK_HEARTBEAT_MS || 15_000);

const logFd = openSync(p("log"), "a");

// D1 — brief flows in over stdin, never argv. Missing file (race/bug) must not crash the runner.
const stdinPath = process.env.HER_TASK_STDIN?.trim();
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

const workerCwd = process.env.HER_TASK_CWD?.trim() || taskDir;
// D7 — when `cmd` is the cmd.exe shim chain, `args` is a single pre-quoted /C line built by
// resolveWorkerCommand (task-executor.ts); Node must not re-quote it with its own (different) rules.
const verbatimArgs = process.env.HER_TASK_VERBATIM_ARGS === "1";
const child = spawn(cmd, args, {
	stdio: [stdin0, logFd, logFd],
	windowsHide: true,
	windowsVerbatimArguments: verbatimArgs,
	cwd: workerCwd,
	env: { ...process.env, HER_TASK_ID: id },
});

writeFileSync(
	p("pid"),
	JSON.stringify(
		{
			runnerPid: process.pid,
			workerPid: child.pid ?? null,
			startedAt: new Date().toISOString(),
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

child.on("exit", (code, signal) =>
	finish(code ?? -1, signal ? `signal:${signal}` : null),
);
child.on("error", (err) => finish(-1, `spawn_error:${err.message}`));
