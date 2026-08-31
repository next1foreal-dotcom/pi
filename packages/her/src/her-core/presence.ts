/**
 * G-367 — session presence ledger (pi-source alive/busy/idle).
 *
 * One row file per session under `<root>/presence/<sessionId>.json`.
 * `readPresenceMap` autopsies each pid with `process.kill(pid, 0)` and
 * unlinks dead rows. Known noise: a reused pid that now belongs to a
 * different process is still read as alive. Acceptable.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PresenceState = "busy" | "idle";

export interface PresenceRow {
	at: string;
	mode: string;
	pid: number;
	startedAt: string;
	state: PresenceState;
}

export interface PresenceRecordInput {
	mode: string;
	pid: number;
	sessionId: string;
	state: PresenceState;
}

export type PresenceSessionMeta = {
	id: string;
	source: string;
};

export type PresenceJoinResult<T extends PresenceSessionMeta> =
	| T
	| (T & { alive: true; state: PresenceState })
	| (T & { alive: false });

function safeSegment(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed || !/^[A-Za-z0-9._-]+$/.test(trimmed)) throw new Error(`${label} must be a safe session id`);
	return trimmed;
}

function isEnoent(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function presenceDir(root: string): string {
	return join(root, "presence");
}

function presencePath(root: string, sessionId: string): string {
	return join(presenceDir(root), `${safeSegment(sessionId, "session id")}.json`);
}

async function unlinkQuiet(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

function isPresenceState(value: unknown): value is PresenceState {
	return value === "busy" || value === "idle";
}

function isPresenceRow(value: unknown): value is PresenceRow {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.pid === "number" &&
		Number.isInteger(row.pid) &&
		row.pid > 0 &&
		typeof row.mode === "string" &&
		isPresenceState(row.state) &&
		typeof row.at === "string" &&
		typeof row.startedAt === "string"
	);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readStartedAt(path: string, fallback: string): Promise<string> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (parsed && typeof parsed === "object" && "startedAt" in parsed && typeof parsed.startedAt === "string") {
			return parsed.startedAt;
		}
	} catch {
		// missing or unreadable row — first write uses now
	}
	return fallback;
}

export async function recordPresence(root: string, input: PresenceRecordInput): Promise<void> {
	const path = presencePath(root, input.sessionId);
	const now = new Date().toISOString();
	const startedAt = await readStartedAt(path, now);
	const row: PresenceRow = {
		pid: input.pid,
		mode: input.mode,
		state: input.state,
		at: now,
		startedAt,
	};
	await mkdir(presenceDir(root), { recursive: true });
	await writeFile(path, `${JSON.stringify(row)}\n`, "utf8");
}

export async function clearPresence(root: string, sessionId: string): Promise<void> {
	await unlinkQuiet(presencePath(root, sessionId));
}

export async function readPresenceMap(root: string): Promise<Map<string, PresenceRow>> {
	const dir = presenceDir(root);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return new Map();
		throw error;
	}
	const map = new Map<string, PresenceRow>();
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const sessionId = name.slice(0, -".json".length);
		const path = join(dir, name);
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(path, "utf8"));
		} catch {
			await unlinkQuiet(path);
			continue;
		}
		if (!isPresenceRow(parsed)) {
			await unlinkQuiet(path);
			continue;
		}
		if (!isPidAlive(parsed.pid)) {
			await unlinkQuiet(path);
			continue;
		}
		map.set(sessionId, parsed);
	}
	return map;
}

export function joinPresence<T extends PresenceSessionMeta>(
	rows: readonly T[],
	map: Map<string, PresenceRow>,
): Array<PresenceJoinResult<T>> {
	return rows.map((row) => {
		if (row.source !== "pi") return row;
		const present = map.get(row.id);
		if (present) return { ...row, alive: true as const, state: present.state };
		return { ...row, alive: false as const };
	});
}

function isAliveJoined<T extends PresenceSessionMeta>(
	row: PresenceJoinResult<T>,
): row is T & { alive: true; state: PresenceState } {
	return "alive" in row && row.alive === true;
}

export function formatPresenceLine<T extends PresenceSessionMeta>(joined: readonly PresenceJoinResult<T>[]): string {
	const live = joined.filter(isAliveJoined);
	if (live.length === 0) return "";
	return `live: ${live.map((row) => `${row.id} ${row.state}`).join(" · ")}`;
}
