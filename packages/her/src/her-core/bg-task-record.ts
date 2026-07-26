/**
 * Background task record (.her/tasks/<id>.md) — TS side of appendix B schema.
 */

import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { frontmatter, parseFrontmatter, readText, writeText } from "./store.ts";

export const BG_TASK_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;

export type BgTaskStatus = (typeof BG_TASK_STATUSES)[number];

export type BgTaskRecord = {
	id: string;
	status: BgTaskStatus;
	objective: string;
	worker: string;
	command: string[];
	created: string;
	updated: string;
	retries: number;
	host: string;
	startedAt?: string;
	endedAt?: string;
	exitCode?: number;
	failureReason?: string;
	runnerPid?: number;
	notifiedAt?: string;
	deadlineAt?: string;
	parentTask?: string | null;
	[key: string]: unknown;
};

const TERMINAL = new Set<BgTaskStatus>(["completed", "failed", "cancelled"]);

const LEGAL = new Set([
	"pending>running",
	"pending>failed",
	"running>completed",
	"running>failed",
	"running>cancelled",
]);

export function tasksDir(memoryRoot: string): string {
	return join(memoryRoot, ".her", "tasks");
}

export function taskMdPath(memoryRoot: string, id: string): string {
	return join(tasksDir(memoryRoot), `${id}.md`);
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
	host?: string;
	parentTask?: string | null;
	timeoutMinutes?: number;
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
		created,
		updated: created,
		retries: 0,
		host: input.host ?? osHostname(),
		parentTask: input.parentTask ?? null,
	};
	if (input.timeoutMinutes && input.timeoutMinutes > 0) {
		const deadline = new Date(now.getTime() + input.timeoutMinutes * 60_000);
		record.deadlineAt = isoNow(deadline);
	}
	return record;
}
