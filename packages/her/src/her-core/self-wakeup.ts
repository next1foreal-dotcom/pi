import { spawn as defaultSpawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TasksConfig } from "./bg-task-config.ts";
import { writeMessage } from "./messages.ts";
import { readJson, redactSecrets, retryOnFsContention, writeJson } from "./store.ts";

export const MAX_WAKEUP_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_WAKEUP_NOTE_CHARS = 500;
export const SELF_START_PROMPT = "闹钟自启回合:读你的收件箱与唤醒信息,按技能行事;本回合不 spawn 新后台任务的规矩照旧。";
export const SELF_START_LEDGER_NAME = "self-start-ledger.jsonl";

/** packages/her/src/her-core → repo root. Tick cwd is System32; do not fall back to process.cwd(). */
const DEFAULT_CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export interface WakeupRecord {
	at: string;
	created: string;
	id: string;
	note: string;
	ownerSessionId: string;
	sessionDir?: string;
}

export interface ScheduleWakeupInput {
	at?: string;
	inMinutes?: number;
	note: string;
	ownerSessionId: string;
	sessionDir?: string;
}

export type SelfStartStatus = "launched" | "skipped";
export type SelfStartReason = "disabled" | "daily_cap" | "in_flight" | "spawn_error";

export type SelfStartResult = {
	at: string;
	wakeupIds: string[];
	sessionId: string;
	pid: number | null;
	status: SelfStartStatus;
	reason?: SelfStartReason;
};

export type SelfStartSpawnFn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => { pid?: number; unref: () => void };

export type SelfStartOptions = {
	now?: Date;
	spawn?: SelfStartSpawnFn;
	pidAlive?: (pid: number) => boolean;
	codeRoot?: string;
};

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
	const sessionDir = input.sessionDir?.trim();
	const record: WakeupRecord = {
		id,
		at,
		note,
		ownerSessionId,
		created: now.toISOString(),
		...(sessionDir ? { sessionDir } : {}),
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

function selfStartLedgerPath(root: string): string {
	return join(wakeupsDir(root), SELF_START_LEDGER_NAME);
}

function resolveSelfStartCodeRoot(explicit?: string): string {
	const fromEnv = process.env.HER_CODE_ROOT?.trim() || process.env.HER_PI_DIR?.trim();
	return resolve(explicit?.trim() || fromEnv || DEFAULT_CODE_ROOT);
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
		if (code === "EPERM") return true;
		return false;
	}
}

function selfStartLogName(at: string): string {
	return `${at.replace(/[:.]/g, "-")}.selfstart.log`;
}

type LedgerRow = {
	at?: unknown;
	wakeupIds?: unknown;
	sessionId?: unknown;
	pid?: unknown;
	status?: unknown;
	reason?: unknown;
};

async function readSelfStartLedger(root: string): Promise<LedgerRow[]> {
	let text: string;
	try {
		text = await readFile(selfStartLedgerPath(root), "utf8");
	} catch {
		return [];
	}
	const rows: LedgerRow[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as LedgerRow;
			if (row && typeof row === "object") rows.push(row);
		} catch {}
	}
	return rows;
}

function countLaunchedToday(rows: LedgerRow[], now: Date): number {
	const today = now.toISOString().slice(0, 10);
	let count = 0;
	for (const row of rows) {
		if (row.status === "launched" && typeof row.at === "string" && row.at.slice(0, 10) === today) count += 1;
	}
	return count;
}

function latestLaunchedPid(rows: LedgerRow[]): number | null {
	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i];
		const pid = row?.pid;
		if (row?.status === "launched" && typeof pid === "number" && Number.isInteger(pid) && pid > 0) return pid;
	}
	return null;
}

async function appendSelfStartRow(root: string, row: SelfStartResult): Promise<void> {
	await mkdir(wakeupsDir(root), { recursive: true });
	const ledger: Record<string, unknown> = {
		at: row.at,
		wakeupIds: row.wakeupIds,
		sessionId: row.sessionId,
		pid: row.pid,
		status: row.status,
	};
	if (row.reason) ledger.reason = row.reason;
	await appendFile(selfStartLedgerPath(root), `${JSON.stringify(ledger)}\n`, "utf8");
}

/**
 * G-374 — CLI tick only: after fireDueWakeups has due rings, spawn one detached
 * headless session for the owner. Independent daily cap from event-wake.
 */
export async function selfStartForFiredWakeups(
	root: string,
	fired: WakeupRecord[],
	cfg: TasksConfig,
	opts?: SelfStartOptions,
): Promise<SelfStartResult> {
	const now = opts?.now ?? new Date();
	const at = now.toISOString();
	const wakeupIds = fired.map((row) => row.id);
	const sessionId = fired[0]?.ownerSessionId ?? "";
	const sessionDir = fired.find((row) => row.ownerSessionId === sessionId && row.sessionDir)?.sessionDir;
	const finish = async (row: SelfStartResult): Promise<SelfStartResult> => {
		await appendSelfStartRow(root, row);
		return row;
	};
	if (fired.length === 0 || !sessionId) {
		return { at, wakeupIds, sessionId, pid: null, status: "skipped", reason: "disabled" };
	}

	const dailyMax = cfg.alarmSelfStartDailyMax;
	if (dailyMax === 0) {
		return finish({ at, wakeupIds, sessionId, pid: null, status: "skipped", reason: "disabled" });
	}

	const rows = await readSelfStartLedger(root);
	const pidAlive = opts?.pidAlive ?? defaultPidAlive;
	const inFlightPid = latestLaunchedPid(rows);
	if (inFlightPid !== null && pidAlive(inFlightPid)) {
		return finish({ at, wakeupIds, sessionId, pid: null, status: "skipped", reason: "in_flight" });
	}
	if (countLaunchedToday(rows, now) >= dailyMax) {
		return finish({ at, wakeupIds, sessionId, pid: null, status: "skipped", reason: "daily_cap" });
	}

	const codeRoot = resolveSelfStartCodeRoot(opts?.codeRoot);
	const cliPath = join(codeRoot, "packages", "coding-agent", "dist", "cli.js");
	const args = ["-p", "--mode", "text", "--session-id", sessionId];
	if (sessionDir) args.push("--session-dir", sessionDir);
	args.push("--provider", "deepseek", "--model", "deepseek-v4-flash", SELF_START_PROMPT);
	const argv = [cliPath, ...args];
	const spawnFn = opts?.spawn ?? ((command, spawnArgs, options) => defaultSpawn(command, spawnArgs, options));

	await mkdir(wakeupsDir(root), { recursive: true });
	const logPath = join(wakeupsDir(root), selfStartLogName(at));
	let fd: number | undefined;
	try {
		fd = openSync(logPath, "a");
		const child = spawnFn(process.execPath, argv, {
			cwd: codeRoot,
			detached: true,
			stdio: ["ignore", fd, fd],
			windowsHide: true,
		});
		child.unref();
		const pid = typeof child.pid === "number" ? child.pid : null;
		return finish({ at, wakeupIds, sessionId, pid, status: "launched" });
	} catch {
		return finish({ at, wakeupIds, sessionId, pid: null, status: "skipped", reason: "spawn_error" });
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* child inherited the fd */
			}
		}
	}
}
