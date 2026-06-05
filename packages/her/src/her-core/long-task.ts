import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { StorePaths } from "./paths.ts";
import { frontmatter, parseFrontmatter, readText, redactSecrets, writeText } from "./store.ts";

export const longTaskStatuses = ["active", "blocked", "completed", "cancelled"] as const;
export type LongTaskStatus = (typeof longTaskStatuses)[number];

export interface LongTaskRecord {
	id: string;
	status: LongTaskStatus;
	objective: string;
	created: string;
	updated: string;
	source?: string;
	owner?: string;
	nextContinuation?: string;
	path: string;
}

export interface LongTaskStartOptions {
	id?: string;
	now?: string;
	nextContinuation?: string;
	objective: string;
	owner?: string;
	source?: string;
}

export interface LongTaskCheckpointOptions {
	evidence?: string[];
	nextContinuation?: string;
	now?: string;
	status?: Extract<LongTaskStatus, "active" | "blocked">;
	summary: string;
}

export interface LongTaskCompleteOptions {
	now?: string;
	outcome: string;
	remember?: string;
}

export async function startLongTask(root: string, opts: LongTaskStartOptions): Promise<LongTaskRecord> {
	const now = opts.now ?? new Date().toISOString();
	const objective = requireNonBlank(redactSecrets(opts.objective), "objective");
	const id = opts.id ? safeLongTaskId(opts.id) : makeLongTaskId(now, objective);
	const paths = new StorePaths(root);
	await mkdir(paths.goals, { recursive: true });
	const path = longTaskPath(paths, id);
	if (await readText(path)) throw new Error(`Her long task already exists: ${id}`);
	const nextContinuation = opts.nextContinuation ? redactSecrets(opts.nextContinuation.trim()) : undefined;
	const record: LongTaskRecord = {
		id,
		status: "active",
		objective,
		created: now,
		updated: now,
		...(opts.source ? { source: redactSecrets(opts.source.trim()) } : {}),
		...(opts.owner ? { owner: redactSecrets(opts.owner.trim()) } : {}),
		...(nextContinuation ? { nextContinuation } : {}),
		path: relativeGoalPath(id),
	};
	await writeText(path, renderLongTask(record, startedBody(record, now)));
	return record;
}

export async function checkpointLongTask(
	root: string,
	id: string,
	opts: LongTaskCheckpointOptions,
): Promise<LongTaskRecord> {
	const paths = new StorePaths(root);
	const path = longTaskPath(paths, safeLongTaskId(id));
	const { record, body } = await readLongTaskFile(path);
	if (record.status === "completed" || record.status === "cancelled") {
		throw new Error(`Her long task is ${record.status} and cannot accept checkpoints: ${record.id}`);
	}
	const now = opts.now ?? new Date().toISOString();
	const summary = requireNonBlank(redactSecrets(opts.summary), "summary");
	const nextContinuation = opts.nextContinuation
		? redactSecrets(opts.nextContinuation.trim())
		: record.nextContinuation;
	const updated: LongTaskRecord = {
		...record,
		status: opts.status ?? "active",
		updated: now,
		...(nextContinuation ? { nextContinuation } : {}),
	};
	await writeText(
		path,
		renderLongTask(
			updated,
			`${body.trimEnd()}\n\n${checkpointBody(now, summary, opts.evidence, opts.nextContinuation)}`,
		),
	);
	return updated;
}

export async function completeLongTask(
	root: string,
	id: string,
	opts: LongTaskCompleteOptions,
): Promise<LongTaskRecord> {
	const paths = new StorePaths(root);
	const path = longTaskPath(paths, safeLongTaskId(id));
	const { record, body } = await readLongTaskFile(path);
	if (record.status === "completed") return record;
	if (record.status === "cancelled")
		throw new Error(`Her long task is cancelled and cannot be completed: ${record.id}`);
	const now = opts.now ?? new Date().toISOString();
	const outcome = requireNonBlank(redactSecrets(opts.outcome), "outcome");
	const { nextContinuation: _nextContinuation, ...recordWithoutNext } = record;
	const updated: LongTaskRecord = {
		...recordWithoutNext,
		status: "completed",
		updated: now,
	};
	await writeText(
		path,
		renderLongTask(updated, `${body.trimEnd()}\n\n${completionBody(now, outcome, opts.remember)}`),
	);
	return updated;
}

export async function listLongTasks(root: string, status?: LongTaskStatus): Promise<LongTaskRecord[]> {
	const paths = new StorePaths(root);
	await mkdir(paths.goals, { recursive: true });
	const entries = (await readdir(paths.goals)).filter((entry) => entry.endsWith(".md")).sort();
	const records: LongTaskRecord[] = [];
	for (const entry of entries) {
		const path = join(paths.goals, entry);
		const { record } = await readLongTaskFile(path);
		if (!status || record.status === status) records.push(record);
	}
	return records.sort((a, b) => b.updated.localeCompare(a.updated));
}

function renderLongTask(record: LongTaskRecord, body: string): string {
	return `${frontmatter({
		id: record.id,
		type: "her_long_task",
		status: record.status,
		objective: record.objective,
		created: record.created,
		updated: record.updated,
		source: record.source ?? null,
		owner: record.owner ?? null,
		next_continuation: record.nextContinuation ?? null,
	})}${body.trim()}\n`;
}

async function readLongTaskFile(path: string): Promise<{ record: LongTaskRecord; body: string }> {
	const text = await readText(path);
	if (!text) throw new Error(`Her long task not found: ${basename(path, ".md")}`);
	const parsed = parseFrontmatter(text);
	const data = parsed.data;
	const id = typeof data.id === "string" ? data.id : basename(path, ".md");
	const status = parseStatus(data.status);
	const objective = typeof data.objective === "string" ? data.objective : firstHeading(parsed.body);
	const created = typeof data.created === "string" ? data.created : "";
	const updated = typeof data.updated === "string" ? data.updated : created;
	const nextContinuation = typeof data.next_continuation === "string" ? data.next_continuation : undefined;
	return {
		record: {
			id,
			status,
			objective,
			created,
			updated,
			...(typeof data.source === "string" ? { source: data.source } : {}),
			...(typeof data.owner === "string" ? { owner: data.owner } : {}),
			...(nextContinuation ? { nextContinuation } : {}),
			path: relativeGoalPath(id),
		},
		body: parsed.body,
	};
}

function startedBody(record: LongTaskRecord, now: string): string {
	return [
		`# Her Long Task: ${record.objective}`,
		"",
		"## Objective",
		record.objective,
		"",
		"## Current Continuation",
		record.nextContinuation ?? "_No continuation recorded yet._",
		"",
		"## Log",
		`- ${now}: started${record.source ? ` from ${record.source}` : ""}.`,
	].join("\n");
}

function checkpointBody(now: string, summary: string, evidence?: string[], nextContinuation?: string): string {
	const lines = [`## Checkpoint - ${now}`, "", summary];
	if (evidence?.length) {
		lines.push("", "Evidence:");
		for (const item of evidence) lines.push(`- ${redactSecrets(item)}`);
	}
	if (nextContinuation?.trim()) lines.push("", "Next continuation:", redactSecrets(nextContinuation.trim()));
	return `${lines.join("\n")}\n`;
}

function completionBody(now: string, outcome: string, remember?: string): string {
	const lines = [`## Completed - ${now}`, "", outcome];
	if (remember?.trim()) lines.push("", "Durable memory writeback:", redactSecrets(remember.trim()));
	return `${lines.join("\n")}\n`;
}

function longTaskPath(paths: StorePaths, id: string): string {
	return join(paths.goals, `${id}.md`);
}

function relativeGoalPath(id: string): string {
	return `goals/${id}.md`;
}

function makeLongTaskId(now: string, objective: string): string {
	const stamp = now.replace(/\D/g, "").slice(0, 14) || "task";
	const hash = createHash("sha256").update(`${now}\n${objective}`).digest("hex").slice(0, 8);
	return safeLongTaskId(`goal-${stamp}-${hash}`);
}

function safeLongTaskId(id: string): string {
	const safe = id.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(safe)) throw new Error(`invalid Her long task id: ${id}`);
	return safe;
}

function parseStatus(value: unknown): LongTaskStatus {
	if (longTaskStatuses.includes(value as LongTaskStatus)) return value as LongTaskStatus;
	return "active";
}

function firstHeading(body: string): string {
	const match = /^#\s+(.+)$/m.exec(body);
	return match?.[1]?.replace(/^Her Long Task:\s*/, "").trim() || "Untitled long task";
}

function requireNonBlank(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`Her long task ${label} cannot be blank`);
	return trimmed;
}
