// Detached runner: watches worker, writes .pid / .heartbeat / .log / .done.
// Never touches <id>.md (launcher is the sole .md writer).
//
// G-206 — when the worker exits 0 and the launcher left a <id>.gates.json plan, the runner also
// executes those gate commands in the worker's own working directory and records what happened in
// <id>.acceptance.json. This runs *after* the worker process is gone, which is the point: the
// worker cannot forge results that are written once it can no longer run.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

// tmp+rename (same pattern as .done): the launcher already wrote a provisional .pid, and a
// plain truncate+write here could expose a half-written file to a concurrent stopTask read.
writeFileSync(
	p("pid.tmp"),
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
renameSync(p("pid.tmp"), p("pid"));

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

const GATE_DEFAULT_TIMEOUT_MS = 30 * 60_000;

const safeGateName = (name) =>
	String(name)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "") || "gate";

/** Returns the planned gates, or null when the launcher wrote no plan (legacy task). */
const readGatePlan = () => {
	let text;
	try {
		text = readFileSync(p("gates.json"), "utf8");
	} catch (err) {
		if (err?.code === "ENOENT") return null;
		throw new Error(`gate plan unreadable: ${err.message}`);
	}
	const parsed = JSON.parse(text);
	return Array.isArray(parsed?.gates) ? parsed.gates : [];
};

/**
 * Run one gate to completion. Every abnormal ending (missing binary, timeout, signal) resolves
 * with `exitCode: null` plus a `crashed` note rather than throwing — a gate that could not
 * produce a verdict must reach the judge as an absent verdict, never as a silent pass.
 */
const runOneGate = (gate, index) =>
	new Promise((resolve) => {
		const logName = `${id}.gate-${index + 1}-${safeGateName(gate.name)}.log`;
		const logPath = join(taskDir, logName);
		const startedAt = Date.now();
		let gateFd;
		try {
			gateFd = openSync(logPath, "a");
		} catch (err) {
			resolve({
				name: gate.name,
				command: gate.command,
				exitCode: null,
				crashed: `gate_log_unwritable:${err.message}`,
				outputDigest: "",
				outputBytes: 0,
				outputHead: "",
				logPath: logName,
				durationMs: 0,
			});
			return;
		}

		let settled = false;
		const finishGate = (exitCode, crashed) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				closeSync(gateFd);
			} catch {
				/* already closed */
			}
			let buf = Buffer.alloc(0);
			let digest = "";
			try {
				buf = readFileSync(logPath);
				digest = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
			} catch {
				/* output unreadable — the exit code still stands on its own */
			}
			resolve({
				name: gate.name,
				command: gate.command,
				exitCode,
				...(crashed ? { crashed } : {}),
				outputDigest: digest,
				outputBytes: buf.length,
				outputHead: buf.subarray(0, 2000).toString("utf8"),
				// Whoever reads a red gate wants the end of the output, where a test runner puts
				// its failure summary — the head is usually just the run banner.
				outputTail: buf.subarray(Math.max(0, buf.length - 2000)).toString("utf8"),
				logPath: logName,
				durationMs: Date.now() - startedAt,
			});
		};

		const timeoutMs = Number(gate.timeoutMs) > 0 ? Number(gate.timeoutMs) : GATE_DEFAULT_TIMEOUT_MS;
		const timer = setTimeout(() => {
			try {
				gateChild.kill();
			} catch {
				/* already gone */
			}
			finishGate(null, `timeout after ${timeoutMs}ms`);
		}, timeoutMs);

		const gateChild = spawn(gate.command[0], gate.command.slice(1), {
			cwd: workerCwd,
			stdio: ["ignore", gateFd, gateFd],
			windowsHide: true,
		});
		gateChild.on("exit", (code, signal) => finishGate(code ?? null, signal ? `signal:${signal}` : undefined));
		gateChild.on("error", (err) => finishGate(null, `spawn_error:${err.message}`));
	});

const writeAcceptance = (payload) => {
	writeFileSync(p("acceptance.json.tmp"), JSON.stringify(payload, null, 2));
	renameSync(p("acceptance.json.tmp"), p("acceptance.json"));
};

/**
 * Every gate runs, including the ones after a failure: whoever has to fix this wants the whole
 * picture, not just the first red. Gates run sequentially so they never race for the worktree.
 */
const runGates = async () => {
	const startedAt = new Date().toISOString();
	let gates;
	try {
		gates = readGatePlan();
	} catch (err) {
		writeAcceptance({ gates: [], startedAt, endedAt: new Date().toISOString(), error: err.message });
		return;
	}
	if (gates === null) return; // no plan: this task was never under acceptance
	const results = [];
	let error;
	try {
		for (let index = 0; index < gates.length; index++) {
			results.push(await runOneGate(gates[index], index));
		}
	} catch (err) {
		error = `gate execution failed: ${err?.message ?? err}`;
	}
	writeAcceptance({
		gates: results,
		startedAt,
		endedAt: new Date().toISOString(),
		...(error ? { error } : {}),
	});
};

/**
 * Acceptance must never cost the task its completion signal: whatever happens in the gate phase,
 * `.done` still gets written with the worker's own exit code. A task stuck without `.done` is a
 * worse failure than a task whose gates could not be evaluated (that one at least gets refused).
 */
const onWorkerExit = async (exitCode, detail) => {
	if (finished) return;
	if (exitCode === 0) {
		try {
			await runGates();
		} catch (err) {
			try {
				writeAcceptance({
					gates: [],
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
					error: `acceptance phase failed: ${err?.message ?? err}`,
				});
			} catch {
				/* the judge treats a planned-but-unrecorded gate run as a refusal anyway */
			}
		}
	}
	finish(exitCode, detail);
};

child.on("exit", (code, signal) => void onWorkerExit(code ?? -1, signal ? `signal:${signal}` : null));
child.on("error", (err) => finish(-1, `spawn_error:${err.message}`));
