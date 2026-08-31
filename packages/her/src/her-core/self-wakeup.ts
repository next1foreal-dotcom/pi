import { randomBytes } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeMessage } from "./messages.ts";
import { readJson, redactSecrets, retryOnFsContention, writeJson } from "./store.ts";

export const MAX_WAKEUP_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_WAKEUP_NOTE_CHARS = 500;

export interface WakeupRecord {
	at: string;
	created: string;
	id: string;
	note: string;
	ownerSessionId: string;
}

export interface ScheduleWakeupInput {
	at?: string;
	inMinutes?: number;
	note: string;
	ownerSessionId: string;
}

function wakeupsDir(root: string): string {
	return join(root, ".her", "wakeups");
}

function wakeupPath(root: string, id: string): string {
	return join(wakeupsDir(root), `${id}.json`);
}

function newWakeupId(now: Date): string {
	const stamp = now
		.toISOString()
		.replace(/[^A-Za-z0-9]/g, "")
		.slice(0, 15);
	const rand = randomBytes(4).toString("hex");
	return `w-${stamp}-${rand}`;
}

function requireSafeId(id: string): string | undefined {
	const trimmed = id.trim();
	if (!trimmed || !/^[A-Za-z0-9._-]+$/.test(trimmed)) return undefined;
	return trimmed;
}

function resolveAt(input: ScheduleWakeupInput, now: Date): string {
	const hasAt = input.at !== undefined;
	const hasIn = input.inMinutes !== undefined;
	if (hasAt === hasIn) {
		throw new Error("wakeup requires exactly one of at or inMinutes");
	}
	let atMs: number;
	if (hasIn) {
		const minutes = input.inMinutes;
		if (typeof minutes !== "number" || !Number.isFinite(minutes)) {
			throw new Error("wakeup inMinutes must be a finite number");
		}
		atMs = now.getTime() + minutes * 60_000;
	} else {
		atMs = Date.parse(input.at ?? "");
		if (!Number.isFinite(atMs)) throw new Error("wakeup at must be a valid ISO timestamp");
	}
	if (atMs <= now.getTime()) throw new Error("wakeup at must be in the future");
	if (atMs - now.getTime() > MAX_WAKEUP_AHEAD_MS) {
		throw new Error("wakeup at must be at most 7 days from now");
	}
	return new Date(atMs).toISOString();
}

function isWakeupRecord(value: unknown): value is WakeupRecord {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.at === "string" &&
		Number.isFinite(Date.parse(row.at)) &&
		typeof row.note === "string" &&
		typeof row.ownerSessionId === "string" &&
		typeof row.created === "string"
	);
}

export async function scheduleWakeup(root: string, input: ScheduleWakeupInput): Promise<{ id: string; at: string }> {
	const now = new Date();
	const ownerSessionId = input.ownerSessionId.trim();
	if (!ownerSessionId) throw new Error("wakeup ownerSessionId is required");
	const at = resolveAt(input, now);
	const note = redactSecrets(input.note).trim();
	if (!note) throw new Error("wakeup note is required");
	if (note.length > MAX_WAKEUP_NOTE_CHARS) throw new Error("wakeup note must be at most 500 characters");
	const id = newWakeupId(now);
	const record: WakeupRecord = {
		id,
		at,
		note,
		ownerSessionId,
		created: now.toISOString(),
	};
	await writeJson(wakeupPath(root, id), record);
	return { id, at };
}

export async function listWakeups(root: string): Promise<WakeupRecord[]> {
	const dir = wakeupsDir(root);
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const rows: WakeupRecord[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		let parsed: unknown;
		try {
			parsed = await readJson<unknown>(join(dir, entry.name), null);
		} catch {
			continue;
		}
		if (!isWakeupRecord(parsed)) continue;
		rows.push(parsed);
	}
	rows.sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id));
	return rows;
}

export async function cancelWakeup(root: string, id: string): Promise<{ cancelled: boolean }> {
	const safe = requireSafeId(id);
	if (!safe) return { cancelled: false };
	try {
		await retryOnFsContention(() => unlink(wakeupPath(root, safe)), { label: `cancelWakeup:${safe}` });
		return { cancelled: true };
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { cancelled: false };
		}
		throw error;
	}
}

export async function fireDueWakeups(root: string, now: Date): Promise<{ fired: string[] }> {
	const due = (await listWakeups(root)).filter((row) => Date.parse(row.at) <= now.getTime());
	const fired: string[] = [];
	const at = now.toISOString();
	for (const row of due) {
		try {
			await writeMessage(root, {
				from: "self-wakeup",
				to: row.ownerSessionId,
				at,
				urgent: true,
				origin: `wakeup-${row.id}`,
				body: `[闹钟] ${row.note}`,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[her] self-wakeup fire kept ${row.id}: ${detail}`);
			continue;
		}
		// Delete after a successful write. If unlink fails, the next tick may
		// deliver a duplicate inbox row — prefer a repeat ring over a dropped one.
		try {
			await retryOnFsContention(() => unlink(wakeupPath(root, row.id)), { label: `fireDueWakeups:${row.id}` });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[her] self-wakeup fire wrote inbox but kept ${row.id}: ${detail}`);
		}
		fired.push(row.id);
	}
	return { fired };
}
