/**
 * Background task record (.her/tasks/<id>.md) — TS side of appendix B schema.
 */

import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { appendHerRunEvent } from "./runs.ts";
import { frontmatter, parseFrontmatter, readText, writeText } from "./store.ts";

export const BG_TASK_STATUSES = ["pending", "running", "completed", "failed", "cancelled", "blocked-failed"] as const;

export type BgTaskStatus = (typeof BG_TASK_STATUSES)[number];

export type BgTaskRecord = {
	id: string;
	status: BgTaskStatus;
	objective: string;
	worker: string;
	command: string[];
	/** G-129 — "worker" for config-profile CLIs (brief via stdin); missing/undefined = legacy command mode. */
	mode?: "worker" | "command";
	created: string;
	updated: string;
	retries: number;
	host: string;
	blockedBy?: string[];
	unlockedAt?: number;
	blockedFailedBy?: string;
	startedAt?: string;
	endedAt?: string;
	exitCode?: number;
	failureReason?: string;
	runnerPid?: number;
	notifiedAt?: string;
	deadlineAt?: string;
	parentTask?: string | null;
	/** G-129/D8 — set once a terminal task's reserved budget has been posted to the cost ledger. */
	costSettledAt?: string;
	/** G-185/S1 — session that spawned this task; absent = ownerless (legacy records, foreground spawns). */
	ownerSessionId?: string;
	/** C2 — Codex CLI session/conversation id captured from its JSON event stream. */
	codexSessionId?: string;
	[key: string]: unknown;
};

const TERMINAL = new Set<BgTaskStatus>(["completed", "failed", "cancelled", "blocked-failed"]);

const LEGAL = new Set([
	"pending>running",
	"pending>failed",
	"pending>cancelled",
	"running>completed",
	"running>failed",
	"running>cancelled",
	"pending>blocked-failed",
]);

export function tasksDir(memoryRoot: string): string {
	return join(memoryRoot, ".her", "tasks");
}

export function taskMdPath(memoryRoot: string, id: string): string {
	return join(tasksDir(memoryRoot), `${id}.md`);
}

/**
 * G-187 — is this `.her/tasks` entry a task record (exactly `<taskId>.md`)?
 *
 * Sidecars share the directory and one of them also ends in `.md`: Codex's
 * `--output-last-message` writes `<taskId>.result.md`. Task ids never contain a dot, so a
 * second dot marks a sidecar. Scanning by `.endsWith(".md")` alone is not merely noisy —
 * live fire (2026-08-02) parsed a `.result.md` as a record, threw "command must be a string
 * array" out of the entire reconcile pass, and destroyed a wake the same pass had already
 * stamped `notifiedAt` for. One sidecar took down every task's reconcile.
 */
export function isTaskRecordFile(name: string): boolean {
	if (!name.endsWith(".md")) return false;
	const id = name.slice(0, -3);
	return id.length > 0 && !id.includes(".");
}

export function newTaskId(now = new Date()): string {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	const rand = Math.floor(Math.random() * 36 ** 6)
		.toString(36)
		.padStart(6, "0");
	return `t-${y}${m}${d}-${rand}`;
}

export function isoNow(d = new Date()): string {
	return d.toISOString();
}

export function serializeBgTask(record: BgTaskRecord, body = ""): string {
	const data: Record<string, unknown> = { ...record };
	const bodyText = body.endsWith("\n") || body === "" ? body : `${body}\n`;
	return frontmatter(data) + bodyText;
}

export function parseBgTaskMarkdown(text: string): {
	record: BgTaskRecord;
	body: string;
} {
	const { data, body } = parseFrontmatter(text);
	const command = data.command;
	if (!Array.isArray(command) || !command.every((x) => typeof x === "string")) {
		throw new Error("command must be a string array");
	}
	const status = String(data.status ?? "");
	if (!BG_TASK_STATUSES.includes(status as BgTaskStatus)) {
		throw new Error(`invalid status: ${status}`);
	}
	const record: BgTaskRecord = {
		...(data as BgTaskRecord),
		id: String(data.id),
		status: status as BgTaskStatus,
		objective: String(data.objective ?? ""),
		worker: String(data.worker ?? ""),
		command: command as string[],
		created: String(data.created ?? ""),
		updated: String(data.updated ?? ""),
		retries: Number(data.retries ?? 0),
		host: String(data.host ?? ""),
	};
	return { record, body };
}

export async function loadBgTask(
	memoryRoot: string,
	id: string,
): Promise<{ record: BgTaskRecord; body: string } | null> {
	const text = await readText(taskMdPath(memoryRoot, id));
	if (!text) return null;
	return parseBgTaskMarkdown(text);
}

export async function saveBgTask(memoryRoot: string, record: BgTaskRecord, body = ""): Promise<void> {
	await writeText(taskMdPath(memoryRoot, record.id), serializeBgTask(record, body));
}

/** Append one wakeable envelope row for a real bg-task status migration; failures stay fail-soft. */
export async function appendBgTaskRunEvent(memoryRoot: string, record: BgTaskRecord): Promise<void> {
	const status =
		record.status === "running"
			? "running"
			: record.status === "completed"
				? "done"
				: record.status === "failed" || record.status === "blocked-failed"
					? "failed"
					: undefined;
	if (!status) return;
	try {
		await appendHerRunEvent(memoryRoot, {
			runId: record.id,
			status,
			kind: "subagent",
			source: record.worker.trim() || "her_task",
			title: record.objective,
			at: record.updated,
			...(record.ownerSessionId ? { ownerWorkspaceId: record.ownerSessionId } : {}),
			bgTaskId: record.id,
		});
	} catch (error) {
		console.error(
			`[her] failed to append bg-task run envelope for ${record.id}: ${error instanceof Error ? error.message : error}`,
		);
	}
}

/** Persist a status migration and append its envelope row only once per actual transition. */
export async function saveBgTaskTransition(
	memoryRoot: string,
	previous: BgTaskRecord,
	next: BgTaskRecord,
	body = "",
): Promise<void> {
	await saveBgTask(memoryRoot, next, body);
	if (previous.status !== next.status) await appendBgTaskRunEvent(memoryRoot, next);
}

export function migrateBgStatus(
	record: BgTaskRecord,
	to: BgTaskStatus,
	extra: Partial<BgTaskRecord> = {},
	updated = isoNow(),
): BgTaskRecord {
	const key = `${record.status}>${to}`;
	if (!LEGAL.has(key)) {
		throw new Error(`illegal migration: ${record.status} → ${to}`);
	}
	return { ...record, ...extra, status: to, updated };
}

export function isTerminal(status: BgTaskStatus): boolean {
	return TERMINAL.has(status);
}

export function createPendingRecord(input: {
	objective: string;
	worker: string;
	command: string[];
	mode?: "worker" | "command";
	host?: string;
	parentTask?: string | null;
	timeoutMinutes?: number;
	retries?: number;
	worktree?: string | null;
	codeRoot?: string | null;
	ownerSessionId?: string;
	blockedBy?: string[];
	now?: Date;
}): BgTaskRecord {
	const now = input.now ?? new Date();
	const created = isoNow(now);
	const id = newTaskId(now);
	const record: BgTaskRecord = {
		id,
		status: "pending",
		objective: input.objective.trim().slice(0, 200),
		worker: input.worker,
		command: [...input.command],
		mode: input.mode ?? "command",
		created,
		updated: created,
		retries: Math.max(0, input.retries ?? 0),
		host: input.host ?? osHostname(),
		parentTask: input.parentTask ?? null,
		worktree: input.worktree ?? null,
	};
	if (input.codeRoot) record.codeRoot = input.codeRoot;
	// G-185/S1 — set only when known, so ownerless tasks keep their exact legacy frontmatter.
	if (input.ownerSessionId) record.ownerSessionId = input.ownerSessionId;
	if (input.blockedBy?.length) record.blockedBy = [...input.blockedBy];
	if (input.timeoutMinutes && input.timeoutMinutes > 0) {
		const deadline = new Date(now.getTime() + input.timeoutMinutes * 60_000);
		record.deadlineAt = isoNow(deadline);
	}
	return record;
}

/** H.5 list display: `running@other-host` for foreign tasks. */
export function formatDisplayStatus(record: BgTaskRecord, hostname = osHostname()): string {
	if (record.host && record.host !== hostname) {
		return `${record.status}@${record.host}`;
	}
	return record.status;
}
