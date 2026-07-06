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

export function longTaskWorktreeRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.HER_LONGTASK_WORKTREE_ROOT?.trim() || join(tmpdir(), "her-longtask-worktrees");
}

export async function ensureTaskWorktree(
	repoRoot: string,
	taskId: string,
	opts: { env?: NodeJS.ProcessEnv; baseRef?: string; gitRun?: GitRun } = {},
): Promise<TaskWorktree> {
	const gitRun = opts.gitRun ?? git;
	const safeId = safeTaskId(taskId);
	const branch = `her-task/${safeId}`;
	const worktreePath = resolve(longTaskWorktreeRoot(opts.env), safeId);
	const registered = (await listAllWorktrees(repoRoot, gitRun)).some(
		(entry) => entry.branch === branch && samePath(entry.path, worktreePath),
	);
	if (registered && (await pathExists(worktreePath))) {
		return taskWorktree(taskId, branch, worktreePath, true, gitRun);
	}
	if (await branchExists(repoRoot, branch, gitRun)) {
		await gitRun(repoRoot, "worktree", "prune");
		await mkdir(dirname(worktreePath), { recursive: true });
		await gitRun(repoRoot, "worktree", "add", worktreePath, branch);
		return taskWorktree(taskId, branch, worktreePath, true, gitRun);
	}
	await mkdir(dirname(worktreePath), { recursive: true });
	await gitRun(repoRoot, "worktree", "add", worktreePath, "-b", branch, opts.baseRef ?? "HEAD");
	return taskWorktree(taskId, branch, worktreePath, false, gitRun);
}

async function taskWorktree(
	taskId: string,
	branch: string,
	worktreePath: string,
	resumed: boolean,
	gitRun: GitRun,
): Promise<TaskWorktree> {
	const baseSha = (await gitRun(worktreePath, "rev-parse", "HEAD")).stdout.trim();
	return { taskId, branch, worktreePath, baseSha, resumed };
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
