import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { git } from "./memory-utils.ts";

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

export async function ensureTaskWorktree(
	repoRoot: string,
	taskId: string,
	opts: { env?: NodeJS.ProcessEnv; baseRef?: string; gitRun?: GitRun } = {},
): Promise<TaskWorktree> {
	const gitRun = opts.gitRun ?? git;
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
	return (await (opts.gitRun ?? git)(worktreePath, "status", "--porcelain")).stdout.trim().length > 0;
}

export async function removeTaskWorktree(
	repoRoot: string,
	taskId: string,
	opts: { env?: NodeJS.ProcessEnv; force?: boolean; gitRun?: GitRun } = {},
): Promise<{ removed: boolean; reason?: string }> {
	const gitRun = opts.gitRun ?? git;
	const location = taskWorktreeLocation(taskId, opts.env);
	if (!(await pathExists(location.worktreePath))) return { removed: false, reason: "missing" };
	if (!opts.force && (await isWorktreeDirty(location.worktreePath, { gitRun }))) {
		throw new WorktreeDirtyError(location.worktreePath);
	}
	const args = opts.force
		? ["worktree", "remove", location.worktreePath, "--force"]
		: ["worktree", "remove", location.worktreePath];
	await gitRun(repoRoot, ...args);
	await gitRun(repoRoot, "branch", "-D", location.branch);
	return { removed: true };
}

/**
 * H.2 / G-126 — on task terminal, remove the worktree when the branch has
 * zero commits past `baseSha` (empty agent run). Keep it when there are commits.
 */
export async function maybeRemoveEmptyTaskWorktree(
	repoRoot: string,
	taskId: string,
	baseSha: string,
	opts: { env?: NodeJS.ProcessEnv; gitRun?: GitRun } = {},
): Promise<{ removed: boolean; commits: number; branch?: string }> {
	const gitRun = opts.gitRun ?? git;
	const location = taskWorktreeLocation(taskId, opts.env);
	if (!(await pathExists(location.worktreePath))) {
		return { removed: false, commits: 0 };
	}
	const commits = await gitRun(location.worktreePath, "rev-list", "--count", `${baseSha}..HEAD`)
		.then((r) => Number(r.stdout.trim()) || 0)
		.catch(() => 0);
	if (commits > 0) {
		return { removed: false, commits, branch: location.branch };
	}
	await removeTaskWorktree(repoRoot, taskId, { env: opts.env, force: true, gitRun });
	return { removed: true, commits: 0 };
}

export async function listTaskWorktrees(
	repoRoot: string,
	opts: { env?: NodeJS.ProcessEnv; gitRun?: GitRun } = {},
): Promise<TaskWorktree[]> {
	const gitRun = opts.gitRun ?? git;
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
