import { rm } from "node:fs/promises";
import { join } from "node:path";
import { listBgTasks } from "./bg-task-spawn.ts";
import { appendEvent } from "./event-history.ts";
import { readText, writeJson } from "./store.ts";

export const DEFAULT_DRAIN_TTL_MINUTES = 30;
export const MAX_DRAIN_TTL_MINUTES = 240;
export const DRAIN_WAIT_POLL_MS = 10_000;

export interface DrainFlag {
	by: string;
	expiresAt: string;
	reason: string;
	startedAt: string;
}

export interface DrainState {
	active: boolean;
	by?: string;
	expiresAt?: string;
	reason?: string;
	remainingSeconds: number;
	startedAt?: string;
	warning?: string;
}

export interface ClampTtlResult {
	ttlMinutes: number;
	warning?: string;
}

export interface StartDrainOptions {
	by?: string;
	memoryDir: string;
	notify?: boolean;
	now?: Date;
	reason: string;
	sendNotify?: (text: string) => Promise<void>;
	ttlMinutes?: number;
}

export interface StartDrainResult {
	flag: DrainFlag;
	notifyWarning?: string;
	overwritten: boolean;
	ttlMinutes: number;
	ttlWarning?: string;
}

export interface StopDrainOptions {
	memoryDir: string;
	notify?: boolean;
	sendNotify?: (text: string) => Promise<void>;
}

export interface StopDrainResult {
	existed: boolean;
	notifyWarning?: string;
}

export interface DrainBgTask {
	id: string;
	status: string;
}

export interface WaitForQuietOptions {
	listBgTasks?: (memoryRoot: string) => Promise<DrainBgTask[]>;
	memoryDir: string;
	now?: () => number;
	pollIntervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
	timeoutSeconds: number;
}

export interface WaitQuietResult {
	elapsedSeconds: number;
	ok: boolean;
	running: DrainBgTask[];
}

export function drainFlagPath(memoryDir: string): string {
	return join(memoryDir, ".her", "drain.json");
}

export function clampDrainTtlMinutes(value?: number): ClampTtlResult {
	if (value === undefined) return { ttlMinutes: DEFAULT_DRAIN_TTL_MINUTES };
	if (!Number.isFinite(value) || value <= 0) {
		return { ttlMinutes: DEFAULT_DRAIN_TTL_MINUTES, warning: "ttl invalid, using default 30" };
	}
	if (value > MAX_DRAIN_TTL_MINUTES) {
		return { ttlMinutes: MAX_DRAIN_TTL_MINUTES, warning: "ttl clamped to 240" };
	}
	return { ttlMinutes: Math.floor(value) };
}

export async function readDrainState(memoryDir: string, now = new Date()): Promise<DrainState> {
	const text = await readText(drainFlagPath(memoryDir));
	if (text === undefined) return { active: false, remainingSeconds: 0 };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		return { active: false, remainingSeconds: 0, warning: "invalid drain flag" };
	}
	if (!parsed || typeof parsed !== "object") {
		return { active: false, remainingSeconds: 0, warning: "invalid drain flag" };
	}
	const rec = parsed as Record<string, unknown>;
	const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
	const by = typeof rec.by === "string" ? rec.by.trim() : "";
	const startedAt = typeof rec.startedAt === "string" ? rec.startedAt : "";
	const expiresAt = typeof rec.expiresAt === "string" ? rec.expiresAt : "";
	if (!reason || !by || !startedAt || !expiresAt) {
		return { active: false, remainingSeconds: 0, warning: "invalid drain flag" };
	}
	const startedMs = Date.parse(startedAt);
	const expiresMs = Date.parse(expiresAt);
	if (Number.isNaN(startedMs) || Number.isNaN(expiresMs)) {
		return { active: false, remainingSeconds: 0, warning: "invalid drain flag" };
	}
	if (expiresMs - startedMs > MAX_DRAIN_TTL_MINUTES * 60_000) {
		return { active: false, remainingSeconds: 0, warning: "drain flag exceeds max ttl" };
	}
	if (now.getTime() >= expiresMs) {
		return {
			active: false,
			by,
			expiresAt,
			reason,
			remainingSeconds: 0,
			startedAt,
			warning: "drain flag expired",
		};
	}
	return {
		active: true,
		by,
		expiresAt,
		reason,
		remainingSeconds: Math.max(0, Math.floor((expiresMs - now.getTime()) / 1000)),
		startedAt,
	};
}

export async function startDrain(opts: StartDrainOptions): Promise<StartDrainResult> {
	const reason = opts.reason.trim();
	if (!reason) throw new Error("drain-start requires --reason");
	const by = (opts.by ?? process.env.USERNAME ?? process.env.USER ?? "operator").trim() || "operator";
	const ttl = clampDrainTtlMinutes(opts.ttlMinutes);
	const previous = await readDrainState(opts.memoryDir, opts.now);
	const startedAt = (opts.now ?? new Date()).toISOString();
	const expiresAt = new Date(Date.parse(startedAt) + ttl.ttlMinutes * 60_000).toISOString();
	const flag: DrainFlag = { by, expiresAt, reason, startedAt };
	await writeJson(drainFlagPath(opts.memoryDir), flag);
	await appendEvent(
		"host.restart_planned",
		"drain-cli",
		{ by, reason, source: "drain", ttlMinutes: ttl.ttlMinutes },
		undefined,
		opts.memoryDir,
	);
	return {
		flag,
		notifyWarning: await maybeNotify(opts.notify, opts.sendNotify, formatStartMessage(reason, ttl.ttlMinutes, by)),
		overwritten: previous.active,
		ttlMinutes: ttl.ttlMinutes,
		ttlWarning: ttl.warning,
	};
}

export async function stopDrain(opts: StopDrainOptions): Promise<StopDrainResult> {
	const path = drainFlagPath(opts.memoryDir);
	const existed = (await readText(path)) !== undefined;
	if (existed) await rm(path, { force: true });
	return {
		existed,
		notifyWarning: await maybeNotify(opts.notify, opts.sendNotify, "her drain: back - drain cleared"),
	};
}

export async function waitForQuiet(opts: WaitForQuietOptions): Promise<WaitQuietResult> {
	const timeoutMs = Math.max(0, opts.timeoutSeconds) * 1000;
	const interval = opts.pollIntervalMs ?? DRAIN_WAIT_POLL_MS;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? defaultSleep;
	const list = opts.listBgTasks ?? defaultListRunning;
	const start = now();
	while (true) {
		const listed = await list(opts.memoryDir);
		const running = listed.filter((task) => task.status === "running");
		const elapsedMs = now() - start;
		if (running.length === 0) {
			return { elapsedSeconds: elapsedMs / 1000, ok: true, running: [] };
		}
		if (elapsedMs >= timeoutMs) {
			return { elapsedSeconds: elapsedMs / 1000, ok: false, running };
		}
		await sleep(Math.min(interval, timeoutMs - elapsedMs));
	}
}

export function formatStartMessage(reason: string, ttlMinutes: number, by: string): string {
	return `her drain: restart planned - ${reason} (ttl ${ttlMinutes}m, by ${by})`;
}

async function maybeNotify(
	notify: boolean | undefined,
	sendNotify: ((text: string) => Promise<void>) | undefined,
	text: string,
): Promise<string | undefined> {
	if (!notify) return undefined;
	try {
		if (!sendNotify) throw new Error("notify requested without sender");
		await sendNotify(text);
		return undefined;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return `warning: telegram notify failed: ${detail}`;
	}
}

async function defaultListRunning(memoryDir: string): Promise<DrainBgTask[]> {
	const tasks = await listBgTasks(memoryDir, { status: "running" });
	return tasks.map((task) => ({ id: task.id, status: task.status }));
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
