/**
 * G-120/G-122/G-125 — spawn / stop / list harness background tasks (+ gates / worktree).
 */

import { readdir } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { loadRuntimeConfig } from "./bg-task-config.ts";
import {
	type BgTaskRecord,
	createPendingRecord,
	formatDisplayStatus,
	isoNow,
	isTerminal,
	loadBgTask,
	migrateBgStatus,
	saveBgTask,
	tasksDir,
} from "./bg-task-record.ts";
import { enforceDailyCostCap } from "./cost-ledger.ts";
import { ensureTaskWorktree } from "./long-task-worktree.ts";
import { redactSecrets, writeText } from "./store.ts";
import { launchTask, stopTask } from "./task-executor.ts";
import { claimWarmWorktree, clampWarmWorktreePoolSize, ensureWarmWorktreePool } from "./warm-worktree-pool.ts";
import { buildWorkerEnv, prepareWorkerCommand, resolveWorkerInvocation, type WorkerProfile } from "./worker-profile.ts";

const DEFAULT_ALLOW = new Set(["node", "nodejs"]);

export type SpawnBgTaskInput = {
	objective: string;
	/** Bare command mode (G-120 legacy): argv given directly. Mutually exclusive with `brief`. */
	command?: string[];
	/** Worker/profile mode (G-129): `worker` names a config profile; brief flows to it via stdin. */
	brief?: string;
	worker?: string;
	parentTask?: string | null;
	timeoutMinutes?: number;
	heartbeatMs?: number;
	retries?: number;
	/** H.2 — isolate worker cwd in a git worktree on the code repo (never memory). */
	worktree?: boolean;
	/** Code repo root for worktree; defaults to HER_CODE_ROOT / HER_PI_DIR / cwd. */
	codeRoot?: string;
	/** G-185/S1 — pi session that spawned this task; drives owner-first wake sorting. */
	ownerSessionId?: string;
	/** Test hook: skip budget/concurrency gates */
	skipGates?: boolean;
	/** Internal trusted command path: allow the configured CLI shim chain in command mode. */
	allowComspec?: boolean;
};

type SpawnMode = "worker" | "command";

export type SpawnBgTaskResult =
	| { id: string; status: "running"; logPath: string; worktree?: string }
	| {
			id: string;
			status: "failed";
			failureReason: string;
			error: string;
			gates?: { name: string; verdict: string; reason: string }[];
	  };

export type BgTaskListItem = BgTaskRecord & { displayStatus: string };

/**
 * D2 — bare command mode allowlist. `argv[0]` must be a bare name (no path separator — same-basename
 * malicious paths are banned outright) and must not resolve through the cmd.exe shim chain (that
 * chain is only trusted for worker/profile mode, where argv is static Fei-authored config, not a
 * model-controlled string). The allowlist is DEFAULT_ALLOW + process.execPath + every configured
 * worker profile's argv[0] — so a bare name matching a worker profile (e.g. "codex") is permitted.
 */
function assertCommandAllowed(command: string[], workers: Record<string, WorkerProfile>): void {
	if (!Array.isArray(command) || command.length === 0) {
		throw new Error("command must be a non-empty argv array");
	}
	if (!command.every((x) => typeof x === "string" && x.length > 0)) {
		throw new Error("command entries must be non-empty strings");
	}
	const file = command[0];
	if (file === process.execPath) return;
	if (/[\\/]/.test(file)) {
		throw new Error(`bare command must not contain a path separator: ${file} (use a worker profile for CLIs)`);
	}
	const base = basename(file)
		.toLowerCase()
		.replace(/\.exe$/i, "");
	const workerNames = Object.values(workers).map((w) =>
		basename(w.argv[0])
			.toLowerCase()
			.replace(/\.exe$/i, ""),
	);
	const allowed = new Set([
		...DEFAULT_ALLOW,
		...workerNames,
		basename(process.execPath)
			.toLowerCase()
			.replace(/\.exe$/i, ""),
	]);
	if (!(allowed.has(base) || allowed.has(file.toLowerCase()))) {
		throw new Error(`executable not in allowlist: ${file} (allowed: ${[...allowed].join(", ")})`);
	}
	if (/\.(cmd|bat)$/i.test(file)) {
		throw new Error(`bare command must not resolve through cmd.exe — use a worker profile to run CLIs: ${file}`);
	}
}

/** D4 — command/brief are mutually exclusive; exactly one selects the spawn mode. */
function resolveSpawnMode(input: SpawnBgTaskInput): SpawnMode {
	const hasCommand = input.command !== undefined;
	const hasBrief = input.brief !== undefined;
	if (hasCommand && hasBrief) {
		throw new Error("spawnBgTask: provide either `command` (bare mode) or `brief` (worker mode), not both");
	}
	if (!hasCommand && !hasBrief) {
		throw new Error("spawnBgTask: must provide either `command` (bare mode) or `brief` (worker mode)");
	}
	return hasBrief ? "worker" : "command";
}

/** D1 — brief byte cap enforced before anything is written to disk. */
function assertBriefWithinCap(brief: string, capBytes: number): void {
	if (Buffer.byteLength(brief, "utf8") > capBytes) {
		throw new Error(`brief exceeds tasks.brief_cap_bytes (${capBytes})`);
	}
}

function resolveCodeRoot(explicit?: string): string {
	const fromEnv = process.env.HER_CODE_ROOT?.trim() || process.env.HER_PI_DIR?.trim();
	const root = explicit?.trim() || fromEnv || process.cwd();
	return resolve(root);
}

export async function spawnBgTask(memoryRoot: string, input: SpawnBgTaskInput): Promise<SpawnBgTaskResult> {
	const cfg = loadRuntimeConfig(memoryRoot);
	const mode = resolveSpawnMode(input);

	let command: string[];
	let workerProfile: WorkerProfile | undefined;
	let workerName: string | undefined;
	if (mode === "worker") {
		workerName = input.worker ?? cfg.tasks.defaultWorker;
		workerProfile = resolveWorkerInvocation(cfg.workers, workerName);
		assertBriefWithinCap(input.brief ?? "", cfg.tasks.briefCapBytes);
		command = workerProfile.argv;
	} else {
		assertCommandAllowed(input.command ?? [], cfg.workers);
		command = input.command ?? [];
	}

	const record = createPendingRecord({
		objective: input.objective,
		worker: mode === "worker" ? (workerName ?? "") : (input.worker ?? cfg.tasks.defaultWorker),
		command,
		mode,
		parentTask: input.parentTask,
		timeoutMinutes: input.timeoutMinutes ?? cfg.tasks.defaultTimeoutMinutes,
		retries: input.retries,
		...(input.ownerSessionId ? { ownerSessionId: input.ownerSessionId } : {}),
	});
	if (mode === "worker" && workerProfile && workerName) {
		command = prepareWorkerCommand(workerName, workerProfile, tasksDir(memoryRoot), record.id);
		record.command = [...command];
	}

	if (!input.skipGates) {
		const runningCount = (await listBgTasks(memoryRoot, { status: "running" })).length;
		if (runningCount >= cfg.tasks.maxConcurrent) {
			const gates = [
				{
					name: "concurrency",
					verdict: "DENY",
					reason: `${runningCount} running >= max_concurrent ${cfg.tasks.maxConcurrent}`,
				},
			];
			const failed = {
				...migrateBgStatus(record, "failed", {
					failureReason: "budget_denied",
					endedAt: isoNow(),
				}),
				gates,
			};
			await saveBgTask(memoryRoot, failed, `# ${record.objective}\n\nDenied: concurrency.\n`);
			return {
				id: failed.id,
				status: "failed",
				failureReason: "budget_denied",
				error: gates[0].reason,
				gates,
			};
		}
		try {
			await enforceDailyCostCap(memoryRoot, cfg.tasks.budgetDailyCap);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const gates = [{ name: "budget", verdict: "DENY", reason: detail }];
			const failed = {
				...migrateBgStatus(record, "failed", {
					failureReason: "budget_denied",
					endedAt: isoNow(),
				}),
				gates,
			};
			await saveBgTask(memoryRoot, failed, `# ${record.objective}\n\nDenied: budget.\n`);
			return {
				id: failed.id,
				status: "failed",
				failureReason: "budget_denied",
				error: detail,
				gates,
			};
		}
	}

	let workerCwd: string | undefined;
	let worktreePath: string | undefined;
	if (input.worktree) {
		const codeRoot = resolveCodeRoot(input.codeRoot);
		if (resolve(codeRoot) === resolve(memoryRoot)) {
			const failed = migrateBgStatus(record, "failed", {
				failureReason: "never_started",
				endedAt: isoNow(),
			});
			await saveBgTask(
				memoryRoot,
				failed,
				`# ${record.objective}\n\nworktree must not target her-memory (code repo only).\n`,
			);
			return {
				id: failed.id,
				status: "failed",
				failureReason: "never_started",
				error: "worktree must not target her-memory (code repo only)",
			};
		}
		try {
			const warmSize = clampWarmWorktreePoolSize(cfg.tasks.warmWorktreePoolSize);
			const warm = warmSize > 0 ? await claimWarmWorktree(codeRoot, record.id) : null;
			if (warmSize > 0) {
				// Replenish off the request path — never await readiness here.
				void ensureWarmWorktreePool(codeRoot, warmSize).catch(() => {
					/* next spawn can cold-miss; fail soft */
				});
			}
			const wt = warm ?? (await ensureTaskWorktree(codeRoot, record.id));
			workerCwd = wt.worktreePath;
			worktreePath = wt.worktreePath;
			record.worktree = wt.worktreePath;
			record.codeRoot = codeRoot;
			record.worktreeBranch = wt.branch;
			record.worktreeBaseSha = wt.baseSha;
			if (warm) {
				record.warmWorktreeClaim = true;
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const failed = migrateBgStatus(record, "failed", {
				failureReason: "never_started",
				endedAt: isoNow(),
			});
			await saveBgTask(memoryRoot, failed, `# ${record.objective}\n\nworktree: ${detail}\n`);
			return {
				id: failed.id,
				status: "failed",
				failureReason: "never_started",
				error: detail,
			};
		}
	}

	await saveBgTask(memoryRoot, record, `# ${record.objective}\n`);

	let briefPath: string | undefined;
	if (mode === "worker") {
		briefPath = join(tasksDir(memoryRoot), `${record.id}.brief`);
		await writeText(briefPath, redactSecrets(input.brief ?? ""));
	}

	try {
		const runnerPid = launchTask(tasksDir(memoryRoot), record.id, command, {
			heartbeatMs: input.heartbeatMs ?? cfg.tasks.heartbeatSeconds * 1000,
			...(workerCwd ? { cwd: workerCwd } : {}),
			...(mode === "worker" && workerProfile
				? { env: buildWorkerEnv(workerProfile, record.id, record.ownerSessionId) }
				: {}),
			// G-185/S5 — launchTask strips inherited HER_TASK_*, so ownership is handed to it
			// explicitly (buildWorkerEnv's copy would not survive the strip).
			...(record.ownerSessionId ? { ownerSessionId: record.ownerSessionId } : {}),
			...(briefPath ? { stdinPath: briefPath } : {}),
			// F1 (G-129.1) — the ComSpec chain is trusted only for worker/profile mode's static
			// config argv; bare command mode must never hand model-controlled argv to cmd.exe.
			allowComspec: mode === "worker" || input.allowComspec === true,
		});
		const running = migrateBgStatus(record, "running", {
			startedAt: isoNow(),
			runnerPid,
			budgetReserved: cfg.tasks.budgetCap,
		});
		await saveBgTask(memoryRoot, running, `# ${record.objective}\n`);
		return {
			id: running.id,
			status: "running",
			logPath: `.her/tasks/${running.id}.log`,
			...(worktreePath ? { worktree: worktreePath } : {}),
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const failed = migrateBgStatus(record, "failed", {
			failureReason: "never_started",
			endedAt: isoNow(),
		});
		await saveBgTask(memoryRoot, failed, `# ${record.objective}\n\n${detail}\n`);
		return {
			id: failed.id,
			status: "failed",
			failureReason: "never_started",
			error: detail,
		};
	}
}

export async function continueBgTask(
	memoryRoot: string,
	taskId: string,
	message: string,
	ownerSessionId: string,
): Promise<SpawnBgTaskResult> {
	const loaded = await loadBgTask(memoryRoot, taskId);
	if (!loaded) throw new Error("该任务暂不支持续跑: 原任务不存在");
	const { record } = loaded;
	if (!isTerminal(record.status)) {
		throw new Error(`该任务暂不支持续跑: 原任务未处于终态（当前状态 ${record.status}）`);
	}
	if (!record.codexSessionId) throw new Error("该任务暂不支持续跑: 原任务没有 codexSessionId");
	if (record.worker.toLowerCase() !== "codex") throw new Error("该任务暂不支持续跑: 任务类型不是 codex");

	const safeMessage = redactSecrets(message);
	return spawnBgTask(memoryRoot, {
		objective: `Continue ${record.id}`,
		command: ["codex", "exec", "resume", record.codexSessionId, safeMessage],
		worker: record.worker,
		parentTask: record.id,
		ownerSessionId,
		allowComspec: true,
	});
}
export async function stopBgTask(
	memoryRoot: string,
	id: string,
): Promise<{ id: string; result: "stopped" | "already_gone"; status: string }> {
	const loaded = await loadBgTask(memoryRoot, id);
	if (!loaded) {
		return { id, result: "already_gone", status: "unknown" };
	}
	const { record, body } = loaded;
	if (record.host && record.host !== osHostname()) {
		throw new Error(`task ${id} runs on ${record.host}; stop it there`);
	}
	const result = await stopTask(tasksDir(memoryRoot), id);
	if (record.status === "running" || record.status === "pending") {
		const cancelled = migrateBgStatus(record, "cancelled", {
			failureReason: "stopped_by_user",
			endedAt: isoNow(),
		});
		await saveBgTask(memoryRoot, cancelled, body);
		return { id, result, status: "cancelled" };
	}
	return { id, result, status: record.status };
}

export async function listBgTasks(
	memoryRoot: string,
	filter?: { status?: string | string[]; hostname?: string },
): Promise<BgTaskListItem[]> {
	const dir = tasksDir(memoryRoot);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const want = filter?.status ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status]) : null;
	const hostname = filter?.hostname ?? osHostname();
	const out: BgTaskListItem[] = [];
	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		const loaded = await loadBgTask(memoryRoot, name.slice(0, -3));
		if (!loaded) continue;
		if (want && !want.has(loaded.record.status)) continue;
		out.push({
			...loaded.record,
			displayStatus: formatDisplayStatus(loaded.record, hostname),
		});
	}
	out.sort((a, b) => b.updated.localeCompare(a.updated));
	return out;
}
