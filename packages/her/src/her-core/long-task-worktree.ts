import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TaskWorktree {
	taskId: string;
	branch: string;
	worktreePath: string;
	baseSha: string;
	resumed: boolean;
}

export type GitRun = (cwd: string, ...args: string[]) => Promise<{ stdout: string; stderr: string }>;

interface WorktreeListEntry {
	branch?: string;
	path: string;
}

interface TaskWorktreeLocation {
	branch: string;
	taskId: string;
	worktreePath: string;
}

export class WorktreeDirtyError extends Error {
	constructor(worktreePath: string) {
		super(`Her long task worktree is dirty: ${worktreePath}`);
		this.name = "WorktreeDirtyError";
	}
}

export function longTaskWorktreeRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.HER_LONGTASK_WORKTREE_ROOT?.trim() || join(tmpdir(), "her-longtask-worktrees");
}

const DEFAULT_GIT_TIMEOUT_MS = 120_000;

function resolveGitTimeoutMs(env: NodeJS.ProcessEnv | undefined): number {
	const raw = (env ?? process.env).HER_WORKTREE_GIT_TIMEOUT_MS?.trim();
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GIT_TIMEOUT_MS;
}

function isTimeoutError(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "killed" in error && (error as { killed?: unknown }).killed === true,
	);
}

/**
 * C (G-198) — module-default git executor with a hard ceiling: an index.lock fight or a
 * stalled disk on `git worktree add/remove` must fail the calling task, not hang the caller's
 * turn forever. Kept local to this module (rather than adding a timeout to memory-utils.ts's
 * shared `git()`, which the rest of the codebase relies on being timeout-free). Default 120s,
 * overridable via HER_WORKTREE_GIT_TIMEOUT_MS for callers that want a tighter ceiling.
 */
function defaultGitRun(env?: NodeJS.ProcessEnv): GitRun {
	const timeoutMs = resolveGitTimeoutMs(env);
	return async (cwd, ...args) => {
		try {
			const { stdout, stderr } = await execFileAsync("git", args, { cwd, timeout: timeoutMs });
			return { stdout, stderr };
		} catch (error) {
			if (isTimeoutError(error)) {
				throw new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms (cwd: ${cwd})`);
			}
			throw error;
		}
	};
}

export async function ensureTaskWorktree(
	repoRoot: string,
	taskId: string,
	opts: { env?: NodeJS.ProcessEnv; baseRef?: string; gitRun?: GitRun } = {},
): Promise<TaskWorktree> {
	const gitRun = opts.gitRun ?? defaultGitRun(opts.env);
	const location = taskWorktreeLocation(taskId, opts.env);
	const registered = (await listAllWorktrees(repoRoot, gitRun)).some(
		(entry) => entry.branch === location.branch && samePath(entry.path, location.worktreePath),
	);
	if (registered && (await pathExists(location.worktreePath))) {
		return taskWorktree(location, true, gitRun);
	}
	if (await branchExists(repoRoot, location.branch, gitRun)) {
		await gitRun(repoRoot, "worktree", "prune");
		await mkdir(dirname(location.worktreePath), { recursive: true });
		await gitRun(repoRoot, "worktree", "add", location.worktreePath, location.branch);
		return taskWorktree(location, true, gitRun);
	}
	await mkdir(dirname(location.worktreePath), { recursive: true });
	await gitRun(repoRoot, "worktree", "add", location.worktreePath, "-b", location.branch, opts.baseRef ?? "HEAD");
	return taskWorktree(location, false, gitRun);
}

export async function isWorktreeDirty(worktreePath: string, opts: { gitRun?: GitRun } = {}): Promise<boolean> {
	return (await (opts.gitRun ?? defaultGitRun())(worktreePath, "status", "--porcelain")).stdout.trim().length > 0;
}

const REMOVE_RETRY_DELAYS_MS = [200, 500];

function sleep(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

/**
 * E (G-198) — on Windows a just-killed child can still hold a file handle inside the worktree
 * for a few hundred ms after its process exits, so `git worktree remove` can lose that race.
 * Retry with backoff (3 attempts total) before surfacing the failure to the caller.
 */
async function removeWorktreeWithRetry(gitRun: GitRun, repoRoot: string, args: string[]): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= REMOVE_RETRY_DELAYS_MS.length; attempt++) {
		try {
			await gitRun(repoRoot, ...args);
			return;
		} catch (error) {
			lastError = error;
			const delay = REMOVE_RETRY_DELAYS_MS[attempt];
			if (delay === undefined) break;
			await sleep(delay);
		}
	}
	throw lastError;
}

export async function removeTaskWorktree(
	repoRoot: string,
	taskId: string,
	opts: { env?: NodeJS.ProcessEnv; force?: boolean; gitRun?: GitRun } = {},
): Promise<{ removed: boolean; reason?: string }> {
	const gitRun = opts.gitRun ?? defaultGitRun(opts.env);
	const location = taskWorktreeLocation(taskId, opts.env);
	if (!(await pathExists(location.worktreePath))) return { removed: false, reason: "missing" };
	if (!opts.force && (await isWorktreeDirty(location.worktreePath, { gitRun }))) {
		throw new WorktreeDirtyError(location.worktreePath);
	}
	const args = opts.force
		? ["worktree", "remove", location.worktreePath, "--force"]
		: ["worktree", "remove", location.worktreePath];
	await removeWorktreeWithRetry(gitRun, repoRoot, args);
	await gitRun(repoRoot, "branch", "-D", location.branch);
	return { removed: true };
}

/**
 * B (G-198) — `ensureTaskWorktree` can throw after `worktree add` already succeeded (e.g. the
 * timeout-wrapped `rev-parse HEAD` that follows it), leaving a half-registered worktree and/or a
 * created branch with nothing pointing back at it — the caller's record never got a `worktree`
 * field, so no later reconcile/orphan-purge pass would ever find it either. Best-effort clean
 * every trace of that partial state; every step swallows its own error so cleanup itself can
 * never produce the error the caller reports (the original spawn failure always wins).
 */
export async function discardPartialTaskWorktree(
	repoRoot: string,
	taskId: string,
	opts: { env?: NodeJS.ProcessEnv; gitRun?: GitRun } = {},
): Promise<void> {
	const gitRun = opts.gitRun ?? defaultGitRun(opts.env);
	const location = taskWorktreeLocation(taskId, opts.env);
	await gitRun(repoRoot, "worktree", "remove", location.worktreePath, "--force").catch(() => undefined);
	await gitRun(repoRoot, "worktree", "prune").catch(() => undefined);
	await gitRun(repoRoot, "branch", "-D", location.branch).catch(() => undefined);
}

export type WorktreeKeepReason = "commits" | "dirty";

/**
 * H.2 / G-126 — on task terminal, remove the worktree when the branch has
 * zero commits past `baseSha` (empty agent run). Keep it when there are commits.
 *
 * A (G-198) — zero *committed* work is not the same as zero work: an agent that wrote files but
 * never ran `git commit` used to have that work force-deleted right along with the empty
 * worktree (`force: true` skips `removeTaskWorktree`'s own dirty check). Dirty now beats
 * "0 commits" — the tree is kept so the uncommitted work stays on disk for someone to find.
 */
export async function maybeRemoveEmptyTaskWorktree(
	repoRoot: string,
	taskId: string,
	baseSha: string,
	opts: { env?: NodeJS.ProcessEnv; gitRun?: GitRun } = {},
): Promise<{ removed: boolean; commits: number; branch?: string; keptBecause?: WorktreeKeepReason }> {
	const gitRun = opts.gitRun ?? defaultGitRun(opts.env);
	const location = taskWorktreeLocation(taskId, opts.env);
	if (!(await pathExists(location.worktreePath))) {
		return { removed: false, commits: 0 };
	}
	const commits = await gitRun(location.worktreePath, "rev-list", "--count", `${baseSha}..HEAD`)
		.then((r) => Number(r.stdout.trim()) || 0)
		.catch(() => 0);
	if (commits > 0) {
		return { removed: false, commits, branch: location.branch, keptBecause: "commits" };
	}
	if (await isWorktreeDirty(location.worktreePath, { gitRun })) {
		return { removed: false, commits: 0, branch: location.branch, keptBecause: "dirty" };
	}
	await removeTaskWorktree(repoRoot, taskId, { env: opts.env, force: true, gitRun });
	return { removed: true, commits: 0 };
}

/**
 * G-206 — what a kept task worktree actually contains, for the handoff line.
 *
 * Two sources, because neither one alone tells the truth. `git diff --stat` against the fork
 * point covers committed work and edits to tracked files, but it is blind to files git has never
 * seen — and a brand-new file nobody committed is exactly what a half-finished agent run leaves
 * behind. So untracked paths are counted separately and named. Reporting only the diff would
 * quietly under-report someone's work at the moment a human is deciding whether to keep it.
 *
 * Returns null when nothing can be produced — this is reporting, and a missing line must never
 * take down the wake that carries the verdict.
 */
export async function taskWorktreeDiffStat(
	worktreePath: string,
	baseSha: string,
	opts: { env?: NodeJS.ProcessEnv; gitRun?: GitRun } = {},
): Promise<string | null> {
	const gitRun = opts.gitRun ?? defaultGitRun(opts.env);
	const parts: string[] = [];
	try {
		const { stdout } = await gitRun(worktreePath, "--no-pager", "diff", "--stat", baseSha);
		if (stdout.trim()) parts.push(stdout.trim());
	} catch {
		/* fall through to the untracked pass — a partial stat still beats none */
	}
	try {
		const { stdout } = await gitRun(worktreePath, "status", "--porcelain", "--untracked-files=all");
		const untracked = stdout
			.split(/\r?\n/)
			.filter((line) => line.startsWith("?? "))
			.map((line) => line.slice(3).trim())
			.filter(Boolean);
		if (untracked.length > 0) {
			const shown = untracked.slice(0, 5).join(", ");
			const more = untracked.length > 5 ? `, +${untracked.length - 5} more` : "";
			parts.push(`${untracked.length} untracked: ${shown}${more}`);
		}
	} catch {
		/* untracked pass is best-effort too */
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

export async function listTaskWorktrees(
	repoRoot: string,
	opts: { env?: NodeJS.ProcessEnv; gitRun?: GitRun } = {},
): Promise<TaskWorktree[]> {
	const gitRun = opts.gitRun ?? defaultGitRun(opts.env);
	const tasks: TaskWorktree[] = [];
	for (const entry of await listAllWorktrees(repoRoot, gitRun)) {
		if (!entry.branch?.startsWith("her-task/")) continue;
		const location = {
			branch: entry.branch,
			taskId: entry.branch.slice("her-task/".length),
			worktreePath: resolve(entry.path),
		};
		tasks.push(await taskWorktree(location, true, gitRun));
	}
	return tasks.sort((a, b) => a.branch.localeCompare(b.branch));
}
async function taskWorktree(location: TaskWorktreeLocation, resumed: boolean, gitRun: GitRun): Promise<TaskWorktree> {
	const baseSha = (await gitRun(location.worktreePath, "rev-parse", "HEAD")).stdout.trim();
	return { ...location, baseSha, resumed };
}

/**
 * D (G-198) supporting check — an orphan has no stored fork point to diff against (its owning
 * task record may be long gone), so this asks git directly instead: is the branch tip still
 * reachable from repoRoot's current HEAD? If so, nothing exists on this branch that git hasn't
 * already absorbed on the main line (or the branch never moved past its fork point at all). Any
 * failure to determine that is treated as "yes, it has commits" — the safe direction to be wrong
 * in for a check whose only job is deciding whether it's safe to delete someone's work.
 */
async function hasDivergedFromRepoHead(repoRoot: string, tip: string, gitRun: GitRun): Promise<boolean> {
	const head = await gitRun(repoRoot, "rev-parse", "HEAD")
		.then((r) => r.stdout.trim())
		.catch(() => null);
	if (!head) return true;
	if (head === tip) return false;
	try {
		await gitRun(repoRoot, "merge-base", "--is-ancestor", tip, head);
		return false;
	} catch {
		return true;
	}
}

/**
 * D (G-198) — orphaned `her-task/*` worktrees just accumulate today: nothing reconciles them
 * against which tasks are still alive, so a worktree only ever gets cleaned up by the task that
 * created it (H.2/`maybeRemoveEmptyTaskWorktree`) — anything that dies before reaching that path
 * (a crashed host, a killed session) leaves its tree behind forever. This is the missing sweep,
 * kept conservative by design: anything not both dead *and* safe to discard is left alone,
 * because a wrongly-deleted tree is somebody's real work, not garbage.
 */
export async function purgeOrphanTaskWorktrees(
	repoRoot: string,
	isLive: (taskId: string) => boolean | Promise<boolean>,
	opts: { env?: NodeJS.ProcessEnv; gitRun?: GitRun } = {},
): Promise<{ taskId: string; branch: string; removed: boolean; reason: string }[]> {
	const gitRun = opts.gitRun ?? defaultGitRun(opts.env);
	const results: { taskId: string; branch: string; removed: boolean; reason: string }[] = [];
	for (const worktree of await listTaskWorktrees(repoRoot, { env: opts.env, gitRun })) {
		if (await isLive(worktree.taskId)) {
			results.push({ taskId: worktree.taskId, branch: worktree.branch, removed: false, reason: "live" });
			continue;
		}
		if (await isWorktreeDirty(worktree.worktreePath, { gitRun })) {
			results.push({ taskId: worktree.taskId, branch: worktree.branch, removed: false, reason: "dirty" });
			continue;
		}
		// `listTaskWorktrees` reports each worktree's current tip as `baseSha` — exactly the value
		// hasDivergedFromRepoHead needs, even though "base" is the wrong name for it out here.
		if (await hasDivergedFromRepoHead(repoRoot, worktree.baseSha, gitRun)) {
			results.push({ taskId: worktree.taskId, branch: worktree.branch, removed: false, reason: "commits" });
			continue;
		}
		try {
			await removeTaskWorktree(repoRoot, worktree.taskId, { env: opts.env, force: true, gitRun });
			results.push({ taskId: worktree.taskId, branch: worktree.branch, removed: true, reason: "orphaned" });
		} catch (error) {
			results.push({
				taskId: worktree.taskId,
				branch: worktree.branch,
				removed: false,
				reason: `remove_failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	return results;
}

async function branchExists(repoRoot: string, branch: string, gitRun: GitRun): Promise<boolean> {
	try {
		await gitRun(repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
		return true;
	} catch {
		return false;
	}
}

async function listAllWorktrees(repoRoot: string, gitRun: GitRun): Promise<WorktreeListEntry[]> {
	const text = (await gitRun(repoRoot, "worktree", "list", "--porcelain")).stdout;
	const entries: WorktreeListEntry[] = [];
	let current: WorktreeListEntry | undefined;
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			current = { path: line.slice("worktree ".length) };
			entries.push(current);
			continue;
		}
		if (current && line.startsWith("branch refs/heads/")) {
			current.branch = line.slice("branch refs/heads/".length);
		}
	}
	return entries;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function taskWorktreeLocation(taskId: string, env: NodeJS.ProcessEnv | undefined): TaskWorktreeLocation {
	const safeId = safeTaskId(taskId);
	return {
		branch: `her-task/${safeId}`,
		taskId,
		worktreePath: resolve(longTaskWorktreeRoot(env), safeId),
	};
}

function samePath(a: string, b: string): boolean {
	const left = resolve(a);
	const right = resolve(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function safeTaskId(taskId: string): string {
	const safe = taskId
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return safe || "task";
}
