/**
 * G-128 — archive cleanup (mechanism A.8): after retention_days in a terminal
 * state, delete .log/.pid/.heartbeat/.done; keep the .md record.
 */

import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadRuntimeConfig } from "./bg-task-config.ts";
import { isTaskRecordFile, isTerminal, loadBgTask, tasksDir } from "./bg-task-record.ts";

// G-129/D6 — .brief is a task attachment like .pid/.log: kept past terminal state (retries need
// it) and purged in the same retention batch once retention_days has elapsed.
const SENTINELS = ["log", "pid", "heartbeat", "done", "done.tmp", "brief", "result.md"] as const;

export type RetentionPurge = {
	taskId: string;
	removed: string[];
};

export async function purgeExpiredTaskArtifacts(
	memoryRoot: string,
	opts?: { now?: Date; retentionDays?: number },
): Promise<RetentionPurge[]> {
	const dir = tasksDir(memoryRoot);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}

	const retentionDays = opts?.retentionDays ?? loadRuntimeConfig(memoryRoot).tasks.retentionDays;
	const now = opts?.now ?? new Date();
	const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
	const out: RetentionPurge[] = [];

	for (const name of names) {
		// G-187 — same sidecar/corruption guard as the other `.her/tasks` scans. This one runs at
		// the tail of every reconcile pass, so a throw here discards that pass's whole event list
		// even though the records were already claimed and stamped.
		if (!isTaskRecordFile(name)) continue;
		const id = name.slice(0, -3);
		let loaded: Awaited<ReturnType<typeof loadBgTask>>;
		try {
			loaded = await loadBgTask(memoryRoot, id);
		} catch (error) {
			console.warn(`[her] skipping unreadable task record ${id}: ${error instanceof Error ? error.message : error}`);
			continue;
		}
		if (!loaded || !isTerminal(loaded.record.status)) continue;

		const ended =
			parseIso(loaded.record.endedAt) ?? parseIso(loaded.record.notifiedAt) ?? parseIso(loaded.record.updated);
		if (!ended) continue;
		if (now.getTime() - ended.getTime() < cutoffMs) continue;

		const removed: string[] = [];
		for (const ext of SENTINELS) {
			const path = join(dir, `${id}.${ext}`);
			try {
				await unlink(path);
				removed.push(`${id}.${ext}`);
			} catch {
				/* missing ok */
			}
		}
		if (removed.length > 0) out.push({ taskId: id, removed });
	}
	return out;
}

function parseIso(value: unknown): Date | null {
	if (typeof value !== "string" || !value) return null;
	const d = new Date(value.replace("Z", "+00:00"));
	return Number.isNaN(d.getTime()) ? null : d;
}
