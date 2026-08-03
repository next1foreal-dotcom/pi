/**
 * G-145 — bg-task worker entry for deer-workflow.
 * stdin brief JSON → bun deer-workflow run --print → her-memory runs/events.jsonl
 *
 * Env:
 *   HER_MEMORY_DIR  — memory root (required for run envelope)
 *   HER_DEER_ROOT   — deer-workflow clone (default D:/@Her/deer-workflow)
 *   HER_DEER_BUN    — bun executable (default "bun")
 *   HER_TASK_ID / HER_TASK_OWNER_SESSION_ID — G-185/S5 ownership, injected by
 *     buildWorkerEnv. Read from env rather than the brief: the brief is model-authored
 *     text, env is harness-authored fact. Both absent = ownerless run, envelope unchanged.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
	applyDeerWorkflowEvent,
	createDeerBridgeState,
	deerJournalPath,
	parseDeerWorkflowLine,
} from "./deer-workflow-bridge.ts";
import { appendHerRunEvent } from "./runs.ts";
import { resolveWorkerCommand } from "./task-executor.ts";

type DeerBrief = {
	workflow: string;
	input?: unknown;
	title?: string;
	parentRunId?: string;
	runId?: string;
	/**
	 * G-193 — id of an earlier deer task whose journal this run should replay.
	 *
	 * Absent by default, and deliberately so: a new task writes a fresh journal
	 * and replays nothing. Only an explicit re-run may reuse recorded answers,
	 * because replaying them into work that was meant to be done again would be
	 * a run that reports old news as new.
	 */
	resumeFrom?: string;
};

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

function parseBrief(raw: string): DeerBrief {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`deer-workflow-runner: brief must be JSON: ${detail}`);
	}
	if (!parsed || typeof parsed !== "object") {
		throw new Error("deer-workflow-runner: brief must be a JSON object");
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.workflow !== "string" || !obj.workflow.trim()) {
		throw new Error("deer-workflow-runner: brief.workflow (string) is required");
	}
	return {
		workflow: obj.workflow.trim(),
		...(obj.input !== undefined ? { input: obj.input } : {}),
		...(typeof obj.title === "string" ? { title: obj.title } : {}),
		...(typeof obj.parentRunId === "string" ? { parentRunId: obj.parentRunId } : {}),
		...(typeof obj.runId === "string" ? { runId: obj.runId } : {}),
		...(typeof obj.resumeFrom === "string" ? { resumeFrom: obj.resumeFrom } : {}),
	};
}

function deerRoot(): string {
	return process.env.HER_DEER_ROOT?.trim() || "D:/@Her/deer-workflow";
}

function resolveBunBin(): string {
	const override = process.env.HER_DEER_BUN?.trim();
	if (override) return override;
	if (process.platform === "win32") {
		try {
			const stdout = execFileSync("where.exe", ["bun"], {
				encoding: "utf8",
				windowsHide: true,
			});
			const candidates = stdout
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter(Boolean);
			const exe = candidates.find((c) => /\.(exe|com)$/i.test(c));
			if (exe) return exe;
			const cmd = candidates.find((c) => /\.(cmd|bat)$/i.test(c));
			if (cmd) return cmd;
		} catch {
			/* fall through */
		}
		const npmBun = join(process.env.APPDATA ?? "", "npm", "bun.cmd");
		if (npmBun && existsSync(npmBun)) return npmBun;
	}
	return "bun";
}

function deerCliPath(): string {
	return join(deerRoot(), "src", "cli.ts");
}

async function main(): Promise<number> {
	const memoryRoot = process.env.HER_MEMORY_DIR?.trim();
	if (!memoryRoot) {
		console.error("deer-workflow-runner: HER_MEMORY_DIR is required");
		return 2;
	}

	const brief = parseBrief(await readStdin());
	const workflowPath = isAbsolute(brief.workflow) ? brief.workflow : resolve(process.cwd(), brief.workflow);

	const tmp = await mkdtemp(join(tmpdir(), "her-deer-"));
	const inputPath = join(tmp, "input.json");
	await writeFile(inputPath, JSON.stringify(brief.input ?? {}), "utf8");

	let state = createDeerBridgeState({
		runId: brief.runId,
		title: brief.title,
		parentRunId: brief.parentRunId,
		ownerWorkspaceId: process.env.HER_TASK_OWNER_SESSION_ID,
		bgTaskId: process.env.HER_TASK_ID,
	});
	let sawTerminal = false;

	const bun = resolveBunBin();
	const cli = deerCliPath();
	const journalPath = deerJournalPath(memoryRoot, process.env.HER_TASK_ID, brief.resumeFrom);
	const rawArgs = [
		bun,
		"run",
		cli,
		"run",
		workflowPath,
		"--print",
		"--input-file",
		inputPath,
		...(journalPath ? ["--journal", journalPath] : []),
	];
	// Worker profile path: allow ComSpec for bun.cmd npm shim on Windows.
	const resolved = resolveWorkerCommand(rawArgs, { allowComspec: true });

	const child = spawn(resolved.file, resolved.args, {
		cwd: process.cwd(),
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		...(resolved.verbatimArgs ? { windowsVerbatimArguments: true } : {}),
	});

	child.stderr?.on("data", (chunk: Buffer | string) => {
		process.stderr.write(chunk);
	});

	const rl = createInterface({ input: child.stdout! });
	const lineLoop = (async () => {
		for await (const line of rl) {
			process.stdout.write(`${line}\n`);
			const raw = parseDeerWorkflowLine(line);
			if (raw === undefined) continue;
			const result = applyDeerWorkflowEvent(state, raw);
			state = result.state;
			if (result.ignoredType) {
				console.error(`deer-workflow-runner: ignored event type ${result.ignoredType}`);
			}
			if (result.patch) {
				if (result.patch.status === "done" || result.patch.status === "failed") {
					sawTerminal = true;
				}
				await appendHerRunEvent(memoryRoot, result.patch);
			}
		}
	})();

	const code: number = await new Promise((resolvePromise) => {
		child.on("error", (error) => {
			console.error(`deer-workflow-runner: failed to spawn ${bun}: ${error.message}`);
			resolvePromise(127);
		});
		child.on("close", (exitCode) => {
			resolvePromise(exitCode ?? 1);
		});
	});
	await lineLoop;

	try {
		await rm(tmp, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}

	if (code !== 0 && state.runId && !sawTerminal) {
		await appendHerRunEvent(memoryRoot, {
			runId: state.runId,
			status: "failed",
			kind: "workflow",
			source: state.source,
			title: state.title,
			at: new Date().toISOString(),
			...(state.parentRunId ? { parentRunId: state.parentRunId } : {}),
			// G-185/S5 — the crash path is exactly when the owner most needs the report,
			// so ownership rides this fallback event too, not just the bridge's own patches.
			...(state.ownerWorkspaceId ? { ownerWorkspaceId: state.ownerWorkspaceId } : {}),
			...(state.bgTaskId ? { bgTaskId: state.bgTaskId } : {}),
		});
	}

	return code;
}

const exitCode = await main().catch((error: unknown) => {
	const detail = error instanceof Error ? error.message : String(error);
	console.error(detail);
	return 1;
});
process.exit(exitCode);
