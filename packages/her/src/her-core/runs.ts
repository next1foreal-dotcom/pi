import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { StorePaths } from "./paths.ts";

/** Derived index only — rebuildable from goals/build logs; not a source of truth. */
export const herRunKinds = ["orchestrator", "build", "voice", "longtask", "subagent", "workflow"] as const;
export type HerRunKind = (typeof herRunKinds)[number];

export const herRunStatuses = ["queued", "running", "done", "failed", "canceled", "aborted"] as const;
export type HerRunStatus = (typeof herRunStatuses)[number];

/**
 * One append-only line in `runs/events.jsonl`. Latest line per runId wins.
 *
 * G-185/S5 — `ownerWorkspaceId` is the same field name samantha-ui uses in
 * `her-runs-shared.ts`, and its value is the pi-side `ownerSessionId` (BgTaskRecord):
 * Studio workspace ids and pi session ids are one value space, only the field name
 * follows each repo's convention. Do **not** fold it into `piSessionId` — that field is
 * part of the wake display id (`piSessionId ?? goalId ?? runId`), so setting it to the
 * owner would collapse every task of one session onto a single wake identity.
 */
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
	/** Session/workspace that spawned the work — mirrors pi's `ownerSessionId`. */
	ownerWorkspaceId?: string;
	/** `.her/tasks` id of the bg task behind this run; the task ↔ run join key. */
	bgTaskId?: string;
	/** G-225 — resolved model id for a bg-task event; null means command mode. */
	model?: string | null;
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
	/** G-185/S5 — see HerRunEvent: owner identity, and the task ↔ run join key. */
	ownerWorkspaceId?: string;
	bgTaskId?: string;
	/** G-225 — resolved model id for a bg-task event; null means command mode. */
	model?: string | null;
}

export function runsEventsPath(root: string): string {
	return join(new StorePaths(root).root, "runs", "events.jsonl");
}

/**
 * G-185/S5 — the Studio-side wake ledger, written by samantha-ui's S3 watcher and its
 * browser fast path. Read-only from pi: a task Studio already reported must not be
 * reported a second time when pi's owner-grace takeover fires.
 *
 * NOT the same book as pi's own `.her/tasks/wake-ledger.jsonl` (G-132's daily wake
 * counter) — same filename, unrelated contents, different directory.
 */
export function runsWakeLedgerPath(root: string): string {
	return join(new StorePaths(root).root, "runs", "wake-ledger.jsonl");
}

/** One row of the Studio wake ledger. Mirrors samantha-ui `wake-ledger.ts` WakeLedgerRow. */
export interface HerWakeLedgerRow {
	/** G-183 display id (`piSessionId ?? goalId ?? runId`) — half of Studio's dedupe key. */
	wakeId: string;
	terminalStatus: string;
	deliveredAt: string;
	deliveredBy: string;
	/** Envelope runId — always present on watcher rows, never on browser rows. */
	runId?: string;
	/** Watcher gave up after repeated dispatch failures (i.e. nobody was told). */
	failed?: boolean;
}

/** Tolerant reader: a corrupt row must never hide the good rows around it. Missing file → []. */
export async function readRunsWakeLedger(root: string): Promise<HerWakeLedgerRow[]> {
	let raw: string;
	try {
		raw = await readFile(runsWakeLedgerPath(root), "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const rows: HerWakeLedgerRow[] = [];
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
		const rec = parsed as Partial<HerWakeLedgerRow>;
		if (typeof rec.wakeId !== "string" || !rec.wakeId) continue;
		rows.push({
			wakeId: rec.wakeId,
			terminalStatus: typeof rec.terminalStatus === "string" ? rec.terminalStatus : "",
			deliveredAt: typeof rec.deliveredAt === "string" ? rec.deliveredAt : "",
			deliveredBy: typeof rec.deliveredBy === "string" ? rec.deliveredBy : "",
			...(typeof rec.runId === "string" ? { runId: rec.runId } : {}),
			...(rec.failed === true ? { failed: true } : {}),
		});
	}
	return rows;
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
			...(typeof rec.ownerWorkspaceId === "string" ? { ownerWorkspaceId: rec.ownerWorkspaceId } : {}),
			...(typeof rec.bgTaskId === "string" ? { bgTaskId: rec.bgTaskId } : {}),
			...(typeof rec.model === "string" || rec.model === null ? { model: rec.model } : {}),
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
