import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readText, writeJson } from "./store.ts";

export const DEFAULT_SELFMOD_LOCK_TTL_MINUTES = 60;
export const MAX_SELFMOD_LOCK_TTL_MINUTES = 240;

export interface SelfmodLockFlag {
	by: string;
	expiresAt: string;
	reason: string;
	startedAt: string;
}

export interface SelfmodLockState {
	held: boolean;
	flag?: SelfmodLockFlag;
	warning?: string;
}

export interface AcquireSelfmodLockOptions {
	by?: string;
	memoryDir: string;
	now?: Date;
	reason?: string;
	ttlMinutes?: number;
}

export interface AcquireSelfmodLockResult {
	acquired: boolean;
	flag?: SelfmodLockFlag;
}

export function selfmodLockPath(memoryDir: string): string {
	return join(memoryDir, ".her", "selfmod.lock");
}

export async function readSelfmodLock(memoryDir: string, now = new Date()): Promise<SelfmodLockState> {
	const text = await readText(selfmodLockPath(memoryDir));
	if (text === undefined) return { held: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		return { held: false, warning: "invalid selfmod lock" };
	}
	if (!parsed || typeof parsed !== "object") return { held: false, warning: "invalid selfmod lock" };
	const rec = parsed as Record<string, unknown>;
	const by = typeof rec.by === "string" ? rec.by.trim() : "";
	const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
	const startedAt = typeof rec.startedAt === "string" ? rec.startedAt : "";
	const expiresAt = typeof rec.expiresAt === "string" ? rec.expiresAt : "";
	if (!by || !startedAt || !expiresAt) return { held: false, warning: "invalid selfmod lock" };
	const startedMs = Date.parse(startedAt);
	const expiresMs = Date.parse(expiresAt);
	if (Number.isNaN(startedMs) || Number.isNaN(expiresMs)) {
		return { held: false, warning: "invalid selfmod lock" };
	}
	if (expiresMs - startedMs > MAX_SELFMOD_LOCK_TTL_MINUTES * 60_000) {
		return { held: false, warning: "selfmod lock exceeds max ttl" };
	}
	if (now.getTime() >= expiresMs) return { held: false, warning: "selfmod lock expired" };
	return { held: true, flag: { by, expiresAt, reason: reason || "selfmod", startedAt } };
}

export async function acquireSelfmodLock(opts: AcquireSelfmodLockOptions): Promise<AcquireSelfmodLockResult> {
	const now = opts.now ?? new Date();
	const current = await readSelfmodLock(opts.memoryDir, now);
	if (current.held) return { acquired: false, flag: current.flag };
	const ttl = clampLockTtl(opts.ttlMinutes);
	const startedAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + ttl * 60_000).toISOString();
	const flag: SelfmodLockFlag = {
		by: (opts.by ?? "selfmod").trim() || "selfmod",
		expiresAt,
		reason: (opts.reason ?? "selfmod").trim() || "selfmod",
		startedAt,
	};
	await writeJson(selfmodLockPath(opts.memoryDir), flag);
	return { acquired: true, flag };
}

export async function releaseSelfmodLock(memoryDir: string): Promise<void> {
	await rm(selfmodLockPath(memoryDir), { force: true });
}

function clampLockTtl(value?: number): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_SELFMOD_LOCK_TTL_MINUTES;
	return Math.min(MAX_SELFMOD_LOCK_TTL_MINUTES, Math.floor(value));
}
