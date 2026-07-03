import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { readText } from "./store.ts";

export const DEFAULT_STORE_LOCK_TIMEOUT_MS = 60_000;
export const DEFAULT_STORE_LOCK_STALE_MS = 900_000;

const activeLocks = new AsyncLocalStorage<Set<string>>();

export interface StoreLockOptions {
	pollMs?: number;
	staleAfterMs?: number;
	timeoutMs?: number;
}

interface LockPayload {
	at: number;
	host: string;
	owner: string;
	pid: number;
}

export async function storeLock<T>(root: string, fn: () => Promise<T>, opts: StoreLockOptions = {}): Promise<T> {
	const held = activeLocks.getStore();
	if (held?.has(root)) return fn();
	const lockPath = join(root, ".her", "lock");
	const owner = randomUUID();
	await acquireStoreLock(lockPath, owner, opts);
	try {
		return await activeLocks.run(new Set([...(held ?? []), root]), fn);
	} finally {
		await releaseStoreLock(lockPath, owner);
	}
}

async function acquireStoreLock(lockPath: string, owner: string, opts: StoreLockOptions): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_STORE_LOCK_TIMEOUT_MS;
	const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STORE_LOCK_STALE_MS;
	const pollMs = opts.pollMs ?? 200;
	const deadline = Date.now() + timeoutMs;
	const payload: LockPayload = { at: Date.now() / 1000, host: hostname(), owner, pid: process.pid };
	await mkdir(dirname(lockPath), { recursive: true });
	for (;;) {
		try {
			await writeFile(lockPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", flag: "wx" });
			return;
		} catch (error) {
			if (!isFileExists(error)) throw error;
		}
		const lockStat = await stat(lockPath).catch(() => undefined);
		if (!lockStat) continue;
		if (Date.now() - lockStat.mtimeMs > staleAfterMs) {
			await rm(lockPath, { force: true });
			continue;
		}
		if (Date.now() >= deadline) {
			const holder = (await readText(lockPath))?.trim() || "(unknown)";
			throw new Error(`store lock held by ${holder}; another writer is running - retry shortly. lock: ${lockPath}`);
		}
		await sleep(pollMs);
	}
}

async function releaseStoreLock(lockPath: string, owner: string): Promise<void> {
	try {
		const current = await readText(lockPath);
		if (current && JSON.parse(current).owner === owner) await rm(lockPath, { force: true });
	} catch {
		// Best effort only: release must not mask the writer result.
	}
}

function isFileExists(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
