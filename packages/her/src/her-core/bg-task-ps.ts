/**
 * G-369 — read-only roster of harness background tasks (.her/tasks),
 * with heartbeat freshness. Model-visible text is renderBgTaskPs, not details.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadRuntimeConfig } from "./bg-task-config.ts";
import {
	BG_TASK_STATUSES,
	type BgTaskRecord,
	type BgTaskStatus,
	isTaskRecordFile,
	loadBgTask,
	tasksDir,
} from "./bg-task-record.ts";

export type BgTaskPsHeartbeat = "fresh" | "stale" | "none" | "—";

export type BgTaskPsRow = {
	id: string;
	status: BgTaskStatus;
	objective: string;
	worker: string;
	mode: "worker" | "command";
	created: string;
	updated: string;
	ageMinutes: number;
	heartbeat: BgTaskPsHeartbeat;
	worktree?: string;
	parentTask?: string;
	retryTaskId?: string;
};

export type BgTaskPsResult = {
	rows: BgTaskPsRow[];
	skipped: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const OBJECTIVE_CAP = 60;

export async function listBgTaskPs(
	memoryRoot: string,
	options?: { status?: string; limit?: number },
): Promise<BgTaskPsResult> {
	const status = options?.status;
	if (status !== undefined && !BG_TASK_STATUSES.includes(status as BgTaskStatus)) {
		throw new Error(`invalid status: ${status} (expected ${BG_TASK_STATUSES.join(", ")})`);
	}
	const limit = clampLimit(options?.limit);
	const filter = status as BgTaskStatus | undefined;
	return collectRows(memoryRoot, filter, limit);
}

export function renderBgTaskPs(rows: BgTaskPsRow[]): string {
	if (rows.length === 0) return "(no background tasks)";
	return rows
		.map(
			(row) =>
				`${row.id} · ${row.status} · ${row.worker} · ${row.ageMinutes}m · hb:${row.heartbeat} · ${row.objective}`,
		)
		.join("\n");
}

function clampLimit(limit: number | undefined): number {
	const raw = limit ?? DEFAULT_LIMIT;
	if (!Number.isFinite(raw)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

async function collectRows(
	memoryRoot: string,
	status: BgTaskStatus | undefined,
	limit: number,
): Promise<BgTaskPsResult> {
	const dir = tasksDir(memoryRoot);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return { rows: [], skipped: 0 };
	}

	const cfg = loadRuntimeConfig(memoryRoot).tasks;
	const staleLimit = cfg.heartbeatSeconds * cfg.staleMultiplier;
	const now = new Date();
	const loaded: BgTaskPsRow[] = [];
	let skipped = 0;

	for (const name of names) {
		if (!isTaskRecordFile(name)) continue;
		const id = name.slice(0, -3);
		let parsed: Awaited<ReturnType<typeof loadBgTask>>;
		try {
			parsed = await loadBgTask(memoryRoot, id);
		} catch (error) {
			skipped += 1;
			console.warn(
				`[her] skipping unreadable task record ${name}: ${error instanceof Error ? error.message : error}`,
			);
			continue;
		}
		if (!parsed) continue;
		if (status && parsed.record.status !== status) continue;
		loaded.push(await toRow(dir, parsed.record, now, staleLimit));
	}

	loaded.sort((a, b) => b.updated.localeCompare(a.updated));
	return { rows: loaded.slice(0, limit), skipped };
}

async function toRow(dir: string, record: BgTaskRecord, now: Date, staleLimit: number): Promise<BgTaskPsRow> {
	const createdAt = Date.parse(record.created);
	const ageMinutes = Number.isFinite(createdAt) ? Math.round((now.getTime() - createdAt) / 60_000) : 0;
	const row: BgTaskPsRow = {
		id: record.id,
		status: record.status,
		objective: record.objective.slice(0, OBJECTIVE_CAP),
		worker: record.worker,
		mode: record.mode === "worker" ? "worker" : "command",
		created: record.created,
		updated: record.updated,
		ageMinutes,
		heartbeat: await heartbeatState(dir, record, now, staleLimit),
	};
	if (typeof record.worktree === "string" && record.worktree) row.worktree = record.worktree;
	if (typeof record.parentTask === "string" && record.parentTask) row.parentTask = record.parentTask;
	if (typeof record.retryTaskId === "string" && record.retryTaskId) row.retryTaskId = record.retryTaskId;
	return row;
}

async function heartbeatState(
	dir: string,
	record: BgTaskRecord,
	now: Date,
	staleLimit: number,
): Promise<BgTaskPsHeartbeat> {
	if (record.status !== "running" && record.status !== "pending") return "—";
	try {
		const st = await stat(join(dir, `${record.id}.heartbeat`));
		const ageSeconds = (now.getTime() - st.mtimeMs) / 1000;
		return ageSeconds <= staleLimit ? "fresh" : "stale";
	} catch {
		return "none";
	}
}
