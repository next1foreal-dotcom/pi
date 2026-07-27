/**
 * G-147 — warm worker pool: pre-spawn idle Node runners; claim = ownership transfer.
 * Cold boot only on replenish / miss. Clamped to 0–2 slots (Windows codex must not fan-out).
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ResolvedCommand, resolveWorkerCommand } from "./task-executor.ts";

const WARM_SLOT = fileURLToPath(new URL("./warm-slot.mjs", import.meta.url));
export const WARM_POOL_MAX = 2;

export type WarmClaimOptions = {
	env?: NodeJS.ProcessEnv;
	heartbeatMs?: number;
	cwd?: string;
	stdinPath?: string;
	allowComspec?: boolean;
	/** How long to wait for the slot to ack claim (ms). */
	claimTimeoutMs?: number;
};

export type WarmReadyInfo = {
	slotId: string;
	pid: number;
	readyAt: string;
	readyPath: string;
};

export function clampWarmPoolSize(n: number): number {
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.min(WARM_POOL_MAX, Math.floor(n));
}

export function warmPoolDir(taskDir: string): string {
	return join(taskDir, ".warm");
}

function slotPaths(poolDir: string, slotId: string) {
	return {
		ready: join(poolDir, `${slotId}.ready`),
		claim: join(poolDir, `${slotId}.claim`),
		claimed: join(poolDir, `${slotId}.claimed`),
		claimTmp: join(poolDir, `${slotId}.claim.tmp`),
	};
}

export function listReadySlots(taskDir: string): WarmReadyInfo[] {
	const poolDir = warmPoolDir(taskDir);
	let names: string[];
	try {
		names = readdirSync(poolDir);
	} catch {
		return [];
	}
	const out: WarmReadyInfo[] = [];
	for (const name of names) {
		if (!name.endsWith(".ready")) continue;
		const readyPath = join(poolDir, name);
		try {
			const data = JSON.parse(readFileSync(readyPath, "utf8")) as Partial<WarmReadyInfo>;
			if (typeof data.slotId !== "string" || typeof data.pid !== "number") continue;
			// Drop zombie ready files whose process is gone.
			if (!isPidAlive(data.pid)) {
				try {
					unlinkSync(readyPath);
				} catch {
					/* ignore */
				}
				continue;
			}
			out.push({
				slotId: data.slotId,
				pid: data.pid,
				readyAt: typeof data.readyAt === "string" ? data.readyAt : "",
				readyPath,
			});
		} catch {
			/* skip corrupt */
		}
	}
	return out.sort((a, b) => a.slotId.localeCompare(b.slotId));
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function spawnWarmSlot(poolDir: string, slotId: string): void {
	const child = spawn(process.execPath, [WARM_SLOT, poolDir, slotId], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		cwd: poolDir,
		env: { ...process.env, HER_TASK_WARM_SLOT: slotId },
	});
	child.unref();
}

/** Ensure up to `size` (clamped 0–2) idle slots are ready. Idempotent. */
export function ensureWarmPool(taskDir: string, size: number): void {
	const want = clampWarmPoolSize(size);
	const poolDir = warmPoolDir(taskDir);
	mkdirSync(poolDir, { recursive: true });
	if (want === 0) return;

	const ready = listReadySlots(taskDir);
	const readyIds = new Set(ready.map((r) => r.slotId));
	for (let i = 0; i < want; i++) {
		const slotId = `w${i}`;
		if (readyIds.has(slotId)) continue;
		// Skip if a claim is in flight for this slot id.
		const paths = slotPaths(poolDir, slotId);
		try {
			readFileSync(paths.claim);
			continue;
		} catch {
			/* free */
		}
		spawnWarmSlot(poolDir, slotId);
	}
}

function sleepMs(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			/* spin fallback */
		}
	}
}

function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 20): boolean {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		sleepMs(stepMs);
	}
	return predicate();
}

/**
 * Claim one ready warm slot for `id`. Returns runnerPid on hit, null on miss.
 * Exclusive: claim file created with rename from tmp; losers miss and fall cold.
 */
export function claimWarmSlot(
	taskDir: string,
	id: string,
	command: readonly string[],
	options?: WarmClaimOptions,
): number | null {
	const ready = listReadySlots(taskDir);
	if (ready.length === 0) return null;

	const resolved: ResolvedCommand = resolveWorkerCommand(command, { allowComspec: options?.allowComspec });
	const base = options?.env ?? process.env;
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (key.startsWith("HER_TASK_")) continue;
		if (value !== undefined) env[key] = value;
	}
	env.HER_TASK_ID = id;
	if (options?.heartbeatMs) env.HER_TASK_HEARTBEAT_MS = String(options.heartbeatMs);
	if (options?.cwd) env.HER_TASK_CWD = options.cwd;
	if (options?.stdinPath) env.HER_TASK_STDIN = options.stdinPath;
	if (resolved.verbatimArgs) env.HER_TASK_VERBATIM_ARGS = "1";

	const claimBody = {
		taskDir,
		id,
		file: resolved.file,
		args: resolved.args,
		env,
		heartbeatMs: options?.heartbeatMs,
		cwd: options?.cwd,
		stdinPath: options?.stdinPath,
		verbatimArgs: resolved.verbatimArgs === true,
	};

	const timeoutMs = options?.claimTimeoutMs ?? 2_000;
	const poolDir = warmPoolDir(taskDir);

	for (const slot of ready) {
		const paths = slotPaths(poolDir, slot.slotId);
		try {
			writeFileSync(paths.claimTmp, JSON.stringify(claimBody), { flag: "wx" });
			renameSync(paths.claimTmp, paths.claim);
		} catch {
			try {
				unlinkSync(paths.claimTmp);
			} catch {
				/* ignore */
			}
			continue; // lost race — try next slot
		}

		const acked = waitUntil(() => {
			try {
				const claimed = JSON.parse(readFileSync(paths.claimed, "utf8")) as { pid?: number; taskId?: string };
				return claimed.taskId === id && typeof claimed.pid === "number";
			} catch {
				return false;
			}
		}, timeoutMs);

		if (!acked) {
			try {
				unlinkSync(paths.claim);
			} catch {
				/* ignore */
			}
			continue;
		}

		let runnerPid = slot.pid;
		try {
			const claimed = JSON.parse(readFileSync(paths.claimed, "utf8")) as { pid?: number };
			if (typeof claimed.pid === "number") runnerPid = claimed.pid;
		} catch {
			/* keep slot.pid */
		}

		// Confirm task .pid landed (runner became the task).
		const pidPath = join(taskDir, `${id}.pid`);
		waitUntil(() => {
			try {
				const info = JSON.parse(readFileSync(pidPath, "utf8")) as { runnerPid?: number };
				return info.runnerPid === runnerPid;
			} catch {
				return false;
			}
		}, timeoutMs);

		try {
			unlinkSync(paths.claimed);
		} catch {
			/* ignore */
		}
		return runnerPid;
	}
	return null;
}

/** Test/helper: kill idle warm slots and wipe pool dir markers. */
export function drainWarmPool(taskDir: string): void {
	const poolDir = warmPoolDir(taskDir);
	let names: string[];
	try {
		names = readdirSync(poolDir);
	} catch {
		return;
	}
	for (const name of names) {
		if (name.endsWith(".ready")) {
			try {
				const data = JSON.parse(readFileSync(join(poolDir, name), "utf8")) as { pid?: number };
				if (typeof data.pid === "number") {
					try {
						process.kill(data.pid);
					} catch {
						/* gone */
					}
				}
			} catch {
				/* ignore */
			}
		}
		try {
			unlinkSync(join(poolDir, name));
		} catch {
			/* ignore */
		}
	}
}

/** Exported for tests that need deterministic ready wait after ensure. */
export function waitForWarmReady(taskDir: string, minReady: number, timeoutMs = 5_000): boolean {
	return waitUntil(() => listReadySlots(taskDir).length >= minReady, timeoutMs);
}
