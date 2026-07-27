import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { StorePaths } from "./paths.ts";

/** Derived index only — rebuildable from goals/build logs; not a source of truth. */
export const herRunKinds = ["orchestrator", "build", "voice", "longtask", "subagent", "workflow"] as const;
export type HerRunKind = (typeof herRunKinds)[number];

export const herRunStatuses = ["queued", "running", "done", "failed", "canceled", "aborted"] as const;
export type HerRunStatus = (typeof herRunStatuses)[number];

/** One append-only line in `runs/events.jsonl`. Latest line per runId wins. */
export interface HerRunEvent {
	type: "run";
	runId: string;
	status: HerRunStatus;
	kind: HerRunKind;
	source: string;
	title: string;
	at: string;
	piSessionId?: string;
	parentRunId?: string;
	goalId?: string;
	projectId?: string;
}

export interface HerRunSnapshot {
	runId: string;
	status: HerRunStatus;
	kind: HerRunKind;
	source: string;
	title: string;
	startedAt: string;
	updatedAt: string;
	piSessionId?: string;
	parentRunId?: string;
	goalId?: string;
	projectId?: string;
}

export function runsEventsPath(root: string): string {
	return join(new StorePaths(root).root, "runs", "events.jsonl");
}

export async function appendHerRunEvent(root: string, event: Omit<HerRunEvent, "type">): Promise<void> {
	const path = runsEventsPath(root);
	await mkdir(join(new StorePaths(root).root, "runs"), { recursive: true });
	const line: HerRunEvent = { type: "run", ...event };
	await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
}

export async function listHerRunSnapshots(root: string, limit = 200): Promise<HerRunSnapshot[]> {
	const path = runsEventsPath(root);
	let raw = "";
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const byId = new Map<string, HerRunSnapshot>();
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed) as unknown;
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const rec = parsed as Partial<HerRunEvent>;
		if (rec.type !== "run" || typeof rec.runId !== "string") continue;
		const status = parseRunStatus(rec.status);
		const kind = parseRunKind(rec.kind);
		if (!status || !kind) continue;
		const at = typeof rec.at === "string" ? rec.at : new Date().toISOString();
		const title = typeof rec.title === "string" ? rec.title : "Untitled run";
		const source = typeof rec.source === "string" ? rec.source : "unknown";
		const prev = byId.get(rec.runId);
		byId.set(rec.runId, {
			runId: rec.runId,
			status,
			kind,
			source,
			title,
			startedAt: prev?.startedAt ?? at,
			updatedAt: at,
			...(typeof rec.piSessionId === "string" ? { piSessionId: rec.piSessionId } : {}),
			...(typeof rec.parentRunId === "string" ? { parentRunId: rec.parentRunId } : {}),
			...(typeof rec.goalId === "string" ? { goalId: rec.goalId } : {}),
			...(typeof rec.projectId === "string" ? { projectId: rec.projectId } : {}),
		});
	}
	return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

function parseRunStatus(value: unknown): HerRunStatus | undefined {
	if (typeof value !== "string") return undefined;
	return herRunStatuses.includes(value as HerRunStatus) ? (value as HerRunStatus) : undefined;
}

function parseRunKind(value: unknown): HerRunKind | undefined {
	if (typeof value !== "string") return undefined;
	return herRunKinds.includes(value as HerRunKind) ? (value as HerRunKind) : undefined;
}

export function longTaskStatusToRunStatus(status: string): HerRunStatus {
	switch (status) {
		case "active":
			return "running";
		case "completed":
			return "done";
		case "cancelled":
			return "canceled";
		case "blocked":
			return "running";
		default: {
			const _exhaustive: never = status as never;
			return _exhaustive;
		}
	}
}
