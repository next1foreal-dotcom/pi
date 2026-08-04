/**
 * G-147 v2 — warm git worktree pool.
 * Claim = branch rename + worktree move. Request path never waits for replenish.
 */

import { accessSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type GitRun, longTaskWorktreeRoot, type TaskWorktree } from "./long-task-worktree.ts";
import { git as defaultGit } from "./memory-utils.ts";

export const WARM_WORKTREE_POOL_MAX = 2;

export type WarmWorktree = TaskWorktree & { warmClaimed: true };

export function clampWarmWorktreePoolSize(n: number): number {
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.min(WARM_WORKTREE_POOL_MAX, Math.floor(n));
}

function safeTaskId(taskId: string): string {
	const safe = taskId
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return safe || "task";
}

function warmRoot(env?: NodeJS.ProcessEnv): string {
	return join(longTaskWorktreeRoot(env), ".warm");
}

function slotBranch(slotId: string): string {
	return `her-warm/${slotId}`;
}

function slotPath(env: NodeJS.ProcessEnv | undefined, slotId: string): string {
	return resolve(warmRoot(env), slotId);
}

function taskLocation(taskId: string, env?: NodeJS.ProcessEnv) {
	const id = safeTaskId(taskId);
	return {
		taskId,
		branch: `her-task/${id}`,
		worktreePath: resolve(longTaskWorktreeRoot(env), id),
	};
}

function readyMarker(env: NodeJS.ProcessEnv | undefined, slotId: string): string {
	return join(warmRoot(env), `${slotId}.ready`);
}

function claimingMarker(env: NodeJS.ProcessEnv | undefined, slotId: string): string {
	return join(warmRoot(env), `${slotId}.claiming`);
}

export function listReadyWarmSlots(env: NodeJS.ProcessEnv = process.env): string[] {
	const root = warmRoot(env);
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	return names
		.filter((n) => n.endsWith(".ready"))
		.map((n) => n.slice(0, -".ready".length))
		.filter((id) => /^w\d+$/.test(id))
		.sort();
}

async function pathExists(path: string, gitRun: GitRun): Promise<boolean> {
	try {
		await gitRun(path, "rev-parse", "--is-inside-work-tree");
		return true;
	} catch {
		return false;
	}
}

async function createWarmSlot(
	repoRoot: string,
	slotId: string,
	opts: { env?: NodeJS.ProcessEnv; gitRun?: GitRun; baseRef?: string },
): Promise<void> {
	const gitRun = opts.gitRun ?? defaultGit;
	const env = opts.env ?? process.env;
	const root = warmRoot(env);
	mkdirSync(root, { recursive: true });
	const path = slotPath(env, slotId);
	const branch = slotBranch(slotId);

	// Clean stale branch/path from a previous crashed replenish.
	try {
		await gitRun(repoRoot, "worktree", "remove", path, "--force");
	} catch {
		/* absent */
	}
	try {
		await gitRun(repoRoot, "branch", "-D", branch);
	} catch {
		/* absent */
	}
	await gitRun(repoRoot, "worktree", "prune");

	await gitRun(repoRoot, "worktree", "add", path, "-b", branch, opts.baseRef ?? "HEAD");
	writeFileSync(
		readyMarker(env, slotId),
		JSON.stringify({ slotId, branch, path, readyAt: new Date().toISOString() }, null, 2),
	);
}

/** Fill pool to `size` (clamped). Safe to call in background; never required on claim path. */
export async function ensureWarmWorktreePool(
	repoRoot: string,
	size: number,
	opts: { env?: NodeJS.ProcessEnv; gitRun?: GitRun; baseRef?: string } = {},
): Promise<void> {
	const want = clampWarmWorktreePoolSize(size);
	if (want === 0) return;
	const env = opts.env ?? process.env;
	mkdirSync(warmRoot(env), { recursive: true });
	const ready = new Set(listReadyWarmSlots(env));
	for (let i = 0; i < want; i++) {
		const slotId = `w${i}`;
		if (ready.has(slotId)) continue;
		try {
			accessSync(claimingMarker(env, slotId));
			continue; // claim in flight
		} catch {
			/* free */
		}
		await createWarmSlot(repoRoot, slotId, opts);
	}
}

/**
 * Claim one ready warm worktree for `taskId`.
 * Returns null immediately if none ready — never waits for replenish.
 */
export async function claimWarmWorktree(
	repoRoot: string,
	taskId: string,
	opts: { env?: NodeJS.ProcessEnv; gitRun?: GitRun } = {},
): Promise<WarmWorktree | null> {
	const gitRun = opts.gitRun ?? defaultGit;
	const env = opts.env ?? process.env;
	const ready = listReadyWarmSlots(env);
	if (ready.length === 0) return null;

	const location = taskLocation(taskId, env);

	for (const slotId of ready) {
		const readyPath = readyMarker(env, slotId);
		const claimingPath = claimingMarker(env, slotId);
		try {
			// Exclusive: atomic rename ready → claiming.
			renameSync(readyPath, claimingPath);
		} catch {
			continue;
		}

		const fromPath = slotPath(env, slotId);
		const fromBranch = slotBranch(slotId);
		try {
			if (!(await pathExists(fromPath, gitRun))) {
				unlinkSync(claimingPath);
				continue;
			}
			await gitRun(repoRoot, "branch", "-m", fromBranch, location.branch);
			mkdirSync(resolve(longTaskWorktreeRoot(env)), { recursive: true });
			await gitRun(repoRoot, "worktree", "move", fromPath, location.worktreePath);
			try {
				unlinkSync(claimingPath);
			} catch {
				/* ignore */
			}
			const baseSha = (await gitRun(location.worktreePath, "rev-parse", "HEAD")).stdout.trim();
			return {
				taskId,
				branch: location.branch,
				worktreePath: location.worktreePath,
				baseSha,
				resumed: true,
				warmClaimed: true,
			};
		} catch (error) {
			// Best-effort cleanup of claiming marker; leave git state for prune/next ensure.
			try {
				unlinkSync(claimingPath);
			} catch {
				/* ignore */
			}
			throw error;
		}
	}
	return null;
}

/** Test helper: remove warm slots and markers. */
export async function drainWarmWorktreePool(
	repoRoot: string,
	opts: { env?: NodeJS.ProcessEnv; gitRun?: GitRun } = {},
): Promise<void> {
	const gitRun = opts.gitRun ?? defaultGit;
	const env = opts.env ?? process.env;
	const root = warmRoot(env);
	let names: string[] = [];
	try {
		names = readdirSync(root);
	} catch {
		return;
	}
	for (const name of names) {
		if (/^w\d+$/.test(name)) {
			const path = join(root, name);
			try {
				await gitRun(repoRoot, "worktree", "remove", path, "--force");
			} catch {
				/* ignore */
			}
			try {
				await gitRun(repoRoot, "branch", "-D", slotBranch(name));
			} catch {
				/* ignore */
			}
		}
		if (name.endsWith(".ready") || name.endsWith(".claiming")) {
			try {
				unlinkSync(join(root, name));
			} catch {
				/* ignore */
			}
		}
	}
	try {
		await gitRun(repoRoot, "worktree", "prune");
	} catch {
		/* ignore */
	}
}
