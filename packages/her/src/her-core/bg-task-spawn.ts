/**
 * G-120/G-122 — spawn / stop / list harness background tasks (+ gates).
 */

import { readdir } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { basename } from "node:path";
import { loadRuntimeConfig } from "./bg-task-config.ts";
import {
	type BgTaskRecord,
	createPendingRecord,
	isoNow,
	loadBgTask,
	migrateBgStatus,
	saveBgTask,
	tasksDir,
} from "./bg-task-record.ts";
import { enforceDailyCostCap } from "./cost-ledger.ts";
import { launchTask, stopTask } from "./task-executor.ts";

const DEFAULT_ALLOW = new Set(["node", "nodejs"]);

export type SpawnBgTaskInput = {
	objective: string;
	command: string[];
	worker?: string;
	parentTask?: string | null;
	timeoutMinutes?: number;
	allowExecutables?: string[];
	heartbeatMs?: number;
	/** Test hook: skip budget/concurrency gates */
	skipGates?: boolean;
};

export type SpawnBgTaskResult =
	| { id: string; status: "running"; logPath: string }
	| {
			id: string;
			status: "failed";
			failureReason: string;
			error: string;
			gates?: { name: string; verdict: string; reason: string }[];
	  };

function assertCommandAllowed(command: string[], allowExtra: string[] = []): void {
	if (!Array.isArray(command) || command.length === 0) {
		throw new Error("command must be a non-empty argv array");
	}
	if (!command.every((x) => typeof x === "string" && x.length > 0)) {
		throw new Error("command entries must be non-empty strings");
	}
	const file = command[0];
	const base = basename(file)
		.toLowerCase()
		.replace(/\.exe$/i, "");
	const allowed = new Set([
		...DEFAULT_ALLOW,
		...allowExtra.map((a) => a.toLowerCase()),
		basename(process.execPath)
			.toLowerCase()
			.replace(/\.exe$/i, ""),
	]);
	if (file === process.execPath) return;
	if (allowed.has(base) || allowed.has(file.toLowerCase())) return;
	throw new Error(`executable not in allowlist: ${file} (allowed: ${[...allowed].join(", ")})`);
}

export async function spawnBgTask(memoryRoot: string, input: SpawnBgTaskInput): Promise<SpawnBgTaskResult> {
	assertCommandAllowed(input.command, input.allowExecutables);
	const cfg = loadRuntimeConfig(memoryRoot);
	const record = createPendingRecord({
		objective: input.objective,
		worker: input.worker ?? cfg.tasks.defaultWorker,
		command: input.command,
		parentTask: input.parentTask,
		timeoutMinutes: input.timeoutMinutes ?? cfg.tasks.defaultTimeoutMinutes,
	});

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

	await saveBgTask(memoryRoot, record, `# ${record.objective}\n`);

	try {
		const runnerPid = launchTask(tasksDir(memoryRoot), record.id, input.command, {
			heartbeatMs: input.heartbeatMs ?? cfg.tasks.heartbeatSeconds * 1000,
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
	filter?: { status?: string | string[] },
): Promise<BgTaskRecord[]> {
	const dir = tasksDir(memoryRoot);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const want = filter?.status ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status]) : null;
	const out: BgTaskRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		const loaded = await loadBgTask(memoryRoot, name.slice(0, -3));
		if (!loaded) continue;
		if (want && !want.has(loaded.record.status)) continue;
		out.push(loaded.record);
	}
	out.sort((a, b) => b.updated.localeCompare(a.updated));
	return out;
}
