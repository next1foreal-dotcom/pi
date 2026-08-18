import { cp, lstat, mkdir, readdir, rm, rmdir, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { git as defaultGit } from "./memory-utils.ts";

export type SelfmodGit = (cwd: string, ...args: string[]) => Promise<{ stderr: string; stdout: string }>;

export interface SelfmodWorktree {
	anchorCommit: string;
	branch: string;
	worktreePath: string;
}

export interface RemoveSelfmodWorktreeOptions {
	git?: SelfmodGit;
	repoRoot: string;
	worktreePath: string;
}

export interface RemoveSelfmodWorktreeResult {
	ok: boolean;
	steps: string[];
	warning?: string;
}

const PROVIDERS_DATA_REL = ["packages", "ai", "src", "providers", "data"] as const;

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
	await provisionSelfmodWorktree(worktreePath, opts.repoRoot);
	return { anchorCommit, branch, worktreePath };
}

export async function provisionSelfmodWorktree(worktreePath: string, repoRoot: string): Promise<void> {
	await junctionNodeModules(worktreePath, repoRoot);
	await copyProvidersData(worktreePath, repoRoot);
}

export async function removeSelfmodWorktree(opts: RemoveSelfmodWorktreeOptions): Promise<RemoveSelfmodWorktreeResult> {
	const git = opts.git ?? defaultGit;
	const steps: string[] = [];
	const warnings: string[] = [];
	const worktreePath = opts.worktreePath;
	steps.push("unlink-junction");
	try {
		await unlinkJunction(join(worktreePath, "node_modules"));
	} catch (error) {
		if (!isMissing(error)) warnings.push(`unlink-junction: ${errorMessage(error)}`);
	}
	steps.push("scan-junctions");
	try {
		for (const leftover of await scanJunctions(worktreePath)) {
			try {
				await unlinkJunction(leftover);
			} catch (error) {
				if (!isMissing(error)) warnings.push(`scan-unlink ${leftover}: ${errorMessage(error)}`);
			}
		}
	} catch (error) {
		if (!isMissing(error)) warnings.push(`scan-junctions: ${errorMessage(error)}`);
	}
	steps.push("remove-tree");
	try {
		await rm(worktreePath, { force: true, recursive: true });
	} catch (error) {
		if (!isMissing(error)) warnings.push(`remove-tree: ${errorMessage(error)}`);
	}
	steps.push("prune");
	try {
		await git(opts.repoRoot, "worktree", "prune");
	} catch (error) {
		warnings.push(`prune: ${errorMessage(error)}`);
	}
	const warning = warnings.length > 0 ? warnings.join("; ") : undefined;
	if (warning) console.error(`[her] selfmod worktree teardown failed: ${warning}`);
	return { ok: warning === undefined, steps, warning };
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

export async function readPathDiff(opts: {
	from: string;
	git?: SelfmodGit;
	path: string;
	worktreePath: string;
}): Promise<string> {
	const git = opts.git ?? defaultGit;
	return (await git(opts.worktreePath, "diff", `${opts.from}..HEAD`, "--", opts.path)).stdout;
}

async function junctionNodeModules(worktreePath: string, repoRoot: string): Promise<void> {
	const source = join(repoRoot, "node_modules");
	const dest = join(worktreePath, "node_modules");
	if (!(await pathExists(source)) || (await pathExists(dest))) return;
	const type = process.platform === "win32" ? "junction" : "dir";
	await symlink(source, dest, type);
}

async function copyProvidersData(worktreePath: string, repoRoot: string): Promise<void> {
	const source = join(repoRoot, ...PROVIDERS_DATA_REL);
	if (!(await pathExists(source))) return;
	const dest = join(worktreePath, ...PROVIDERS_DATA_REL);
	await mkdir(dirname(dest), { recursive: true });
	await cp(source, dest, { recursive: true });
}

async function unlinkJunction(path: string): Promise<void> {
	try {
		await rmdir(path);
	} catch (error) {
		if (isMissing(error)) return;
		await unlink(path);
	}
}

async function scanJunctions(root: string): Promise<string[]> {
	const found: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) break;
		let entries: Array<{ isDirectory(): boolean; isSymbolicLink(): boolean; name: string }>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const child = join(dir, entry.name);
			if (entry.isSymbolicLink() || (await isReparseDir(child))) {
				found.push(child);
				continue;
			}
			if (entry.isDirectory()) stack.push(child);
		}
	}
	return found;
}

async function isReparseDir(path: string): Promise<boolean> {
	try {
		const info = await lstat(path);
		return info.isSymbolicLink();
	} catch {
		return false;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

function isMissing(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT",
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
