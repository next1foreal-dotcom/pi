import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readText } from "./store.ts";

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

/** Test-only: await between "not held" and create/reclaim so races are deterministic. */
export const selfmodLockTestSeam: { afterCheck?: () => Promise<void> } = {};

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
		return { held: true, warning: "invalid selfmod lock" };
	}
	if (!parsed || typeof parsed !== "object") return { held: true, warning: "invalid selfmod lock" };
	const rec = parsed as Record<string, unknown>;
	const by = typeof rec.by === "string" ? rec.by.trim() : "";
	const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
	const startedAt = typeof rec.startedAt === "string" ? rec.startedAt : "";
	const expiresAt = typeof rec.expiresAt === "string" ? rec.expiresAt : "";
	if (!by || !startedAt || !expiresAt) return { held: true, warning: "invalid selfmod lock" };
	const startedMs = Date.parse(startedAt);
	const expiresMs = Date.parse(expiresAt);
	if (Number.isNaN(startedMs) || Number.isNaN(expiresMs)) {
		return { held: true, warning: "invalid selfmod lock" };
	}
	if (expiresMs - startedMs > MAX_SELFMOD_LOCK_TTL_MINUTES * 60_000) {
		return { held: true, warning: "selfmod lock exceeds max ttl" };
	}
	if (now.getTime() >= expiresMs) return { held: false, warning: "selfmod lock expired" };
	return { held: true, flag: { by, expiresAt, reason: reason || "selfmod", startedAt } };
}

export async function acquireSelfmodLock(opts: AcquireSelfmodLockOptions): Promise<AcquireSelfmodLockResult> {
	const now = opts.now ?? new Date();
	const path = selfmodLockPath(opts.memoryDir);
	await mkdir(dirname(path), { recursive: true });
	const flag = buildFlag(opts, now);
	const payload = `${JSON.stringify(flag, null, 2)}\n`;

	const current = await readSelfmodLock(opts.memoryDir, now);
	if (current.held) return { acquired: false, flag: current.flag };
	await selfmodLockTestSeam.afterCheck?.();

	if (current.warning === "selfmod lock expired") {
		if (!(await reclaimExpiredLock(path))) return { acquired: false };
	}

	if (await tryCreateLock(path, payload)) return { acquired: true, flag };
	const again = await readSelfmodLock(opts.memoryDir, now);
	if (again.held) return { acquired: false, flag: again.flag };
	return { acquired: false };
}

export async function releaseSelfmodLock(memoryDir: string): Promise<void> {
	await rm(selfmodLockPath(memoryDir), { force: true });
}

function buildFlag(opts: AcquireSelfmodLockOptions, now: Date): SelfmodLockFlag {
	const ttl = clampLockTtl(opts.ttlMinutes);
	const startedAt = now.toISOString();
	return {
		by: (opts.by ?? "selfmod").trim() || "selfmod",
		expiresAt: new Date(now.getTime() + ttl * 60_000).toISOString(),
		reason: (opts.reason ?? "selfmod").trim() || "selfmod",
		startedAt,
	};
}

async function tryCreateLock(path: string, payload: string): Promise<boolean> {
	try {
		await writeFile(path, payload, { encoding: "utf8", flag: "wx" });
		return true;
	} catch (error) {
		if (isExist(error)) return false;
		throw error;
	}
}

async function reclaimExpiredLock(path: string): Promise<boolean> {
	const dest = `${path}.reclaim-${randomBytes(8).toString("hex")}`;
	try {
		await rename(path, dest);
	} catch {
		return false;
	}
	await rm(dest, { force: true }).catch(() => undefined);
	return true;
}

function isExist(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST",
	);
}

function clampLockTtl(value?: number): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_SELFMOD_LOCK_TTL_MINUTES;
	return Math.min(MAX_SELFMOD_LOCK_TTL_MINUTES, Math.floor(value));
}
