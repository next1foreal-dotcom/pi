import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { git as defaultGit } from "./memory-utils.ts";

export type SelfmodGit = (cwd: string, ...args: string[]) => Promise<{ stderr: string; stdout: string }>;

export interface SelfmodWorktree {
	anchorCommit: string;
	branch: string;
	worktreePath: string;
}

export async function readHead(repoRoot: string, git: SelfmodGit = defaultGit): Promise<string> {
	return (await git(repoRoot, "rev-parse", "HEAD")).stdout.trim();
}

export async function createSelfmodWorktree(opts: {
	git?: SelfmodGit;
	id: string;
	repoRoot: string;
	worktreeRoot: string;
}): Promise<SelfmodWorktree> {
	const git = opts.git ?? defaultGit;
	const anchorCommit = await readHead(opts.repoRoot, git);
	const branch = `selfmod/${opts.id}`;
	const worktreePath = resolve(opts.worktreeRoot, opts.id);
	await mkdir(dirname(worktreePath), { recursive: true });
	await git(opts.repoRoot, "worktree", "add", worktreePath, "-b", branch, "HEAD");
	return { anchorCommit, branch, worktreePath };
}

export async function mergeSelfmodBranch(opts: {
	branch: string;
	git?: SelfmodGit;
	id: string;
	repoRoot: string;
}): Promise<string> {
	const git = opts.git ?? defaultGit;
	try {
		await git(opts.repoRoot, "merge", "--ff-only", opts.branch);
	} catch {
		await git(opts.repoRoot, "merge", "--squash", opts.branch);
		await git(opts.repoRoot, "commit", "-q", "-m", `selfmod ${opts.id}`);
	}
	const mergeCommit = await readHead(opts.repoRoot, git);
	await git(opts.repoRoot, "tag", `selfmod/${opts.id}`, mergeCommit);
	return mergeCommit;
}

export async function revertSelfmodMerge(opts: {
	git?: SelfmodGit;
	mergeCommit: string;
	repoRoot: string;
}): Promise<string> {
	const git = opts.git ?? defaultGit;
	await git(opts.repoRoot, "revert", "--no-edit", opts.mergeCommit);
	return readHead(opts.repoRoot, git);
}

export async function listDiffNames(opts: {
	from: string;
	git?: SelfmodGit;
	to?: string;
	worktreePath: string;
}): Promise<string[]> {
	const git = opts.git ?? defaultGit;
	const range = opts.to ? `${opts.from}..${opts.to}` : `${opts.from}..HEAD`;
	const text = (await git(opts.worktreePath, "diff", "--name-only", range)).stdout;
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}
