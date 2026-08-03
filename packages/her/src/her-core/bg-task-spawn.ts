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
	isTaskRecordFile,
	isTerminal,
	loadBgTask,
	migrateBgStatus,
	newTaskId,
	saveBgTask,
	tasksDir,
} from "./bg-task-record.ts";
import { enforceDailyCostCap } from "./cost-ledger.ts";
import { discardPartialTaskWorktree, ensureTaskWorktree } from "./long-task-worktree.ts";
import { redactSecrets, writeText } from "./store.ts";
import { launchTask, stopTask } from "./task-executor.ts";
import { claimWarmWorktree, clampWarmWorktreePoolSize, ensureWarmWorktreePool } from "./warm-worktree-pool.ts";
import {
	buildCodexResumeCommand,
	buildWorkerEnv,
	prepareWorkerCommand,
	resolveWorkerInvocation,
	type WorkerProfile,
} from "./worker-profile.ts";

const DEFAULT_ALLOW = new Set(["node", "nodejs"]);

/** G-198 — external name for the same on/off switch as the legacy `worktree` boolean. */
export type TaskIsolation = "none" | "worktree";

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
	/**
	 * G-198 — public alias for `worktree`: "worktree" ≡ worktree:true, "none" ≡
	 * worktree:false/absent. Giving both is accepted only when they agree — see
	 * `resolveIsolation` for the conflict rule.
	 */
	isolation?: TaskIsolation;
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

/**
 * F (G-198) — `isolation` is the public name for the same on/off switch as the legacy
 * `worktree` boolean. Both may be given only when they agree; a genuine conflict (one says
 * isolate, the other says don't) is a caller bug and must fail loud rather than guess which one
 * the caller meant.
 */
function resolveIsolation(input: SpawnBgTaskInput): boolean {
	const isolation = input.isolation;
	if (isolation !== undefined && isolation !== "none" && isolation !== "worktree") {
		throw new Error(`spawnBgTask: isolation must be "none" or "worktree" (got ${JSON.stringify(isolation)})`);
	}
	if (isolation === undefined) return Boolean(input.worktree);
	const wantsWorktree = isolation === "worktree";
	if (input.worktree !== undefined && Boolean(input.worktree) !== wantsWorktree) {
		throw new Error(`spawnBgTask: isolation:"${isolation}" conflicts with worktree:${input.worktree}`);
	}
	return wantsWorktree;
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

/**
 * G-197 — how many tasks were started today (UTC). `newTaskId` stamps the date
 * into every id, so the count is a `readdir` away and needs no second ledger;
 * the prefix is derived from `newTaskId` itself so the two can never drift.
 */
async function countTasksStartedToday(memoryRoot: string, now = new Date()): Promise<number> {
	const prefix = newTaskId(now).replace(/[^-]*$/, "");
	const names = await readdir(tasksDir(memoryRoot)).catch(() => [] as string[]);
	return names.filter((name) => isTaskRecordFile(name) && name.startsWith(prefix)).length;
}

export async function spawnBgTask(memoryRoot: string, input: SpawnBgTaskInput): Promise<SpawnBgTaskResult> {
	const cfg = loadRuntimeConfig(memoryRoot);
	const mode = resolveSpawnMode(input);
	const useWorktree = resolveIsolation(input);

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
	} else if (
		basename(command[0] ?? "")
			.toLowerCase()
			.replace(/\.exe$/i, "") === "codex"
	) {
		// G-187 — a bare-command codex invocation (a continuation) gets the same treatment as a
		// profile one, keyed off argv[0] rather than the worker name: `worker` falls back to the
		// configured default, which would otherwise inject codex flags into a plain `node` task.
		// Without this the child captures no session id and writes no result.md — i.e. a
		// continuation could not itself be continued.
		command = prepareWorkerCommand("codex", { argv: command }, tasksDir(memoryRoot), record.id);
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
		const startedToday = await countTasksStartedToday(memoryRoot);
		if (startedToday >= cfg.tasks.dailyTaskMax) {
			const gates = [
				{
					name: "daily_tasks",
					verdict: "DENY",
					reason: `${startedToday} tasks today >= daily_task_max ${cfg.tasks.dailyTaskMax}`,
				},
			];
			const failed = {
				...migrateBgStatus(record, "failed", {
					failureReason: "budget_denied",
					endedAt: isoNow(),
				}),
				gates,
			};
			await saveBgTask(memoryRoot, failed, `# ${record.objective}\n\nDenied: daily task cap.\n`);
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
	if (useWorktree) {
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
			// B (G-198) — a worktree-add failure can still leave a half-registered worktree, an
			// already-created branch, or a `locked initializing` directory behind (this record never
			// got its `worktree` field set, so no later reconcile/orphan-purge pass would ever find
			// it). Best-effort clean it now; cleanup itself never throws, so it can't shadow `detail`.
			await discardPartialTaskWorktree(codeRoot, record.id);
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
			// G-197 — the worker's own price, not a flat per-task charge. Absent = free.
			budgetReserved: workerProfile?.priceUsd ?? cfg.tasks.budgetCap,
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
	// G-187 — 续跑必须带着父任务的档和权限走,否则就是「看着在续、其实换了脑子」:
	// 实测过一次不继承的后果 —— 父任务 gpt-5.6-terra/effort=medium/sandbox=workspace-write,
	// 续跑却落在 gpt-5.6-luna/effort=max/sandbox=read-only(更贵,而且写不了文件)。
	//
	// 继承的是**该 worker 当前的 profile**,不是父任务当时的实际 argv。取舍写明:
	// 父任务记录里的 command 已经掺了它自己的 `-o <parentId>.result.md`(spawn 时注入的),
	// 照抄会让子任务把结果写进父任务的文件;而 profile 是干净的旗子集合,重新注入即可。
	// 代价是 profile 改过之后续跑会漂移(用新档续旧会话)——派工方已接受这个漂移。
	//
	// worker 的 cwd 是 `<memoryRoot>/.her/tasks`(bare command 模式实测,不是调用方的 cwd),
	// 所以 codex 的 git 仓库门由 prepareWorkerCommand 注入的 --skip-git-repo-check 显式放行。
	const profile = resolveWorkerInvocation(loadRuntimeConfig(memoryRoot).workers, record.worker);
	return spawnBgTask(memoryRoot, {
		objective: `Continue ${record.id}`,
		command: buildCodexResumeCommand(profile.argv, record.codexSessionId, safeMessage),
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
		// G-187 — same sidecar guard as reconcile; a throw here would break the concurrency
		// gate too, i.e. block every future spawn.
		if (!isTaskRecordFile(name)) continue;
		let loaded: Awaited<ReturnType<typeof loadBgTask>>;
		try {
			loaded = await loadBgTask(memoryRoot, name.slice(0, -3));
		} catch (error) {
			console.warn(
				`[her] skipping unreadable task record ${name}: ${error instanceof Error ? error.message : error}`,
			);
			continue;
		}
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
