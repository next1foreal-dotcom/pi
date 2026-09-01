/**
 * G-147 v2 — warm git worktree pool.
 * Claim = branch rename + worktree move. Request path never waits for replenish.
 */

import { accessSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { unlinkWorktreeJunctions } from "./dispatch.ts";
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

function pathIsDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

async function branchExists(repoRoot: string, branch: string, gitRun: GitRun): Promise<boolean> {
	try {
		await gitRun(repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
		return true;
	} catch {
		return false;
	}
}

function samePath(a: string, b: string): boolean {
	const left = resolve(a);
	const right = resolve(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function isRegisteredWarmWorktree(
	repoRoot: string,
	worktreePath: string,
	branch: string,
	gitRun: GitRun,
): Promise<boolean> {
	let text: string;
	try {
		text = (await gitRun(repoRoot, "worktree", "list", "--porcelain")).stdout;
	} catch {
		return false;
	}
	let currentPath: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			currentPath = line.slice("worktree ".length);
			continue;
		}
		if (currentPath && line.startsWith("branch refs/heads/")) {
			const currentBranch = line.slice("branch refs/heads/".length);
			if (currentBranch === branch && samePath(currentPath, worktreePath)) return true;
		}
	}
	return false;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT",
	);
}

function removeMarker(path: string, label: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (!isMissingPathError(error)) console.error(`[her] warm slot cleanup ${label} failed: ${errorText(error)}`);
	}
}

async function cleanupWarmSlot(
	repoRoot: string,
	env: NodeJS.ProcessEnv,
	slotId: string,
	gitRun: GitRun,
	reason: string,
	extraPaths: string[] = [],
	extraBranches: string[] = [],
): Promise<void> {
	console.error(`[her] warm slot ${slotId} degraded: ${reason}`);
	removeMarker(readyMarker(env, slotId), `${slotId}.ready removal`);
	removeMarker(claimingMarker(env, slotId), `${slotId}.claiming removal`);

	const paths = [...new Set([slotPath(env, slotId), ...extraPaths])];
	for (const path of paths) {
		const warnings = await unlinkWorktreeJunctions(path);
		for (const warning of warnings) {
			console.error(`[her] warm slot ${slotId} ${warning}`);
		}
		try {
			await gitRun(repoRoot, "worktree", "remove", path, "--force");
		} catch (error) {
			console.error(`[her] warm slot ${slotId} worktree cleanup failed for ${path}: ${errorText(error)}`);
		}
		try {
			await rm(path, { force: true, recursive: true });
		} catch (error) {
			if (!isMissingPathError(error)) {
				console.error(`[her] warm slot ${slotId} remove-tree failed for ${path}: ${errorText(error)}`);
			}
		}
	}
	try {
		await gitRun(repoRoot, "worktree", "prune");
	} catch (error) {
		console.error(`[her] warm slot ${slotId} prune failed: ${errorText(error)}`);
	}

	const branches = [...new Set([slotBranch(slotId), ...extraBranches])];
	for (const branch of branches) {
		try {
			await gitRun(repoRoot, "branch", "-D", branch);
		} catch (error) {
			console.error(`[her] warm slot ${slotId} branch cleanup failed for ${branch}: ${errorText(error)}`);
		}
	}
	try {
		await gitRun(repoRoot, "worktree", "prune");
	} catch (error) {
		console.error(`[her] warm slot ${slotId} final prune failed: ${errorText(error)}`);
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
	await unlinkWorktreeJunctions(path).catch(() => undefined);
	try {
		await gitRun(repoRoot, "worktree", "remove", path, "--force");
	} catch {
		/* absent */
	}
	try {
		await rm(path, { force: true, recursive: true });
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
	// ready is deliberately the last write: a slot is claimable only after add succeeds.
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
		const slotError = !pathIsDirectory(fromPath)
			? "slot path is missing"
			: !(await branchExists(repoRoot, fromBranch, gitRun))
				? `slot branch is missing: ${fromBranch}`
				: !(await isRegisteredWarmWorktree(repoRoot, fromPath, fromBranch, gitRun))
					? "slot is not a registered worktree"
					: null;
		if (slotError) {
			await cleanupWarmSlot(repoRoot, env, slotId, gitRun, slotError);
			continue;
		}

		let branchRenamed = false;
		try {
			await gitRun(repoRoot, "branch", "-m", fromBranch, location.branch);
			branchRenamed = true;
			mkdirSync(resolve(longTaskWorktreeRoot(env)), { recursive: true });
			await gitRun(repoRoot, "worktree", "move", fromPath, location.worktreePath);
			removeMarker(claimingPath, `${slotId}.claiming removal`);
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
			let branchToDelete = fromBranch;
			if (branchRenamed) {
				try {
					await gitRun(repoRoot, "branch", "-m", location.branch, fromBranch);
				} catch (rollbackError) {
					branchToDelete = location.branch;
					console.error(`[her] warm slot ${slotId} branch rollback failed: ${errorText(rollbackError)}`);
				}
			}
			await cleanupWarmSlot(
				repoRoot,
				env,
				slotId,
				gitRun,
				`claim failed: ${errorText(error)}`,
				[location.worktreePath],
				[branchToDelete],
			);
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
			await unlinkWorktreeJunctions(path).catch(() => undefined);
			try {
				await gitRun(repoRoot, "worktree", "remove", path, "--force");
			} catch {
				/* ignore */
			}
			try {
				await rm(path, { force: true, recursive: true });
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
