import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	ensureTaskWorktree,
	isWorktreeDirty,
	listTaskWorktrees,
	maybeRemoveEmptyTaskWorktree,
	removeTaskWorktree,
	WorktreeDirtyError,
} from "../src/her-core/long-task-worktree.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

async function tempGitRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-longtask-repo-"));
	await git(root, "init", "-q");
	await git(root, "config", "user.email", "longtask@example.com");
	await git(root, "config", "user.name", "Her Long Task Test");
	await writeFile(join(root, "README.md"), "# repo\n", "utf8");
	await git(root, "add", "-A");
	await git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

async function tempWorktreeRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "her-longtask-worktrees-"));
}

async function statusPorcelain(repo: string): Promise<string> {
	return (await git(repo, "status", "--porcelain")).stdout.trim();
}

test("T1 ensureTaskWorktree creates an isolated task worktree without touching the main checkout", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	const beforeHead = (await git(repo, "rev-parse", "HEAD")).stdout.trim();

	const worktree = await ensureTaskWorktree(repo, "t1", { env });

	assert.equal(worktree.resumed, false);
	assert.equal(worktree.branch, "her-task/t1");
	await stat(worktree.worktreePath);
	assert.equal((await git(worktree.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim(), "her-task/t1");
	assert.equal(await statusPorcelain(repo), "");
	assert.equal((await git(repo, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
});

test("T2 ensureTaskWorktree resumes an existing registered task worktree", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };

	const first = await ensureTaskWorktree(repo, "t2", { env });
	const second = await ensureTaskWorktree(repo, "t2", { env });

	assert.equal(first.resumed, false);
	assert.equal(second.resumed, true);
	assert.equal(second.worktreePath, first.worktreePath);
	assert.equal(second.branch, first.branch);
	assert.ok(existsSync(second.worktreePath));
});

test("T3 ensureTaskWorktree reattaches a task branch after the worktree directory is lost", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	const first = await ensureTaskWorktree(repo, "t3", { env });
	await writeFile(join(first.worktreePath, "task.txt"), "task work\n", "utf8");
	await git(first.worktreePath, "add", "task.txt");
	await git(first.worktreePath, "commit", "-q", "-m", "task commit");
	const taskCommit = (await git(first.worktreePath, "rev-parse", "HEAD")).stdout.trim();
	await rm(first.worktreePath, { force: true, recursive: true });

	const second = await ensureTaskWorktree(repo, "t3", { env });

	assert.equal(second.resumed, true);
	assert.equal(second.worktreePath, first.worktreePath);
	assert.equal((await git(second.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim(), "her-task/t3");
	assert.equal((await git(second.worktreePath, "rev-parse", "HEAD")).stdout.trim(), taskCommit);
	assert.match((await git(second.worktreePath, "log", "--oneline")).stdout, /task commit/);
});
test("T5 removeTaskWorktree refuses a dirty worktree unless force is explicit", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	const worktree = await ensureTaskWorktree(repo, "t5", { env });
	await writeFile(join(worktree.worktreePath, "dirty.txt"), "dirty\n", "utf8");

	assert.equal(await isWorktreeDirty(worktree.worktreePath), true);
	await assert.rejects(() => removeTaskWorktree(repo, "t5", { env }), WorktreeDirtyError);
	assert.ok(existsSync(worktree.worktreePath));

	assert.deepEqual(await removeTaskWorktree(repo, "t5", { env, force: true }), { removed: true });
	assert.equal(existsSync(worktree.worktreePath), false);
});

test("T6 removeTaskWorktree removes a clean worktree and its task branch", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	const worktree = await ensureTaskWorktree(repo, "t6", { env });

	assert.deepEqual(await removeTaskWorktree(repo, "t6", { env }), { removed: true });

	assert.equal(existsSync(worktree.worktreePath), false);
	assert.equal((await git(repo, "branch", "--list", "her-task/t6")).stdout.trim(), "");
	assert.equal(await statusPorcelain(repo), "");
});

test("G-126 maybeRemoveEmptyTaskWorktree removes 0-commit trees and keeps committed ones", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };

	const empty = await ensureTaskWorktree(repo, "t-empty", { env });
	const gone = await maybeRemoveEmptyTaskWorktree(repo, "t-empty", empty.baseSha, { env });
	assert.equal(gone.removed, true);
	assert.equal(existsSync(empty.worktreePath), false);

	const kept = await ensureTaskWorktree(repo, "t-kept", { env });
	await writeFile(join(kept.worktreePath, "work.txt"), "x\n", "utf8");
	await git(kept.worktreePath, "add", "work.txt");
	await git(kept.worktreePath, "commit", "-q", "-m", "keep me");
	const stay = await maybeRemoveEmptyTaskWorktree(repo, "t-kept", kept.baseSha, { env });
	assert.equal(stay.removed, false);
	assert.ok(stay.commits >= 1);
	assert.equal(stay.branch, "her-task/t-kept");
	assert.ok(existsSync(kept.worktreePath));
	await removeTaskWorktree(repo, "t-kept", { env, force: true });
});

test("T4 task worktree commits stay off the main branch", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	const mainBranch = (await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
	const worktree = await ensureTaskWorktree(repo, "t4", { env });
	await writeFile(join(worktree.worktreePath, "task.txt"), "task work\n", "utf8");
	await git(worktree.worktreePath, "add", "task.txt");
	await git(worktree.worktreePath, "commit", "-q", "-m", "task-only commit");
	const taskCommit = (await git(worktree.worktreePath, "rev-parse", "--short", "HEAD")).stdout.trim();

	assert.doesNotMatch((await git(repo, "log", "--oneline", mainBranch)).stdout, new RegExp(taskCommit));
	assert.match((await git(repo, "branch", "--list", "her-task/t4")).stdout, /her-task\/t4/);
	assert.equal(await statusPorcelain(repo), "");
});

test("T7 listTaskWorktrees only returns her-task worktrees", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	await ensureTaskWorktree(repo, "t7-a", { env });
	await ensureTaskWorktree(repo, "t7-b", { env });

	const listed = await listTaskWorktrees(repo, { env });

	assert.deepEqual(
		listed.map((item) => item.branch),
		["her-task/t7-a", "her-task/t7-b"],
	);
	assert.deepEqual(
		listed.map((item) => item.taskId),
		["t7-a", "t7-b"],
	);
});

test("T8 task worktree operations leave the main checkout clean", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	await ensureTaskWorktree(repo, "t8-create", { env });
	await ensureTaskWorktree(repo, "t8-create", { env });
	const dirty = await ensureTaskWorktree(repo, "t8-dirty", { env });
	await writeFile(join(dirty.worktreePath, "dirty.txt"), "dirty\n", "utf8");
	await removeTaskWorktree(repo, "t8-dirty", { env, force: true });
	const clean = await ensureTaskWorktree(repo, "t8-clean", { env });
	await removeTaskWorktree(repo, "t8-clean", { env });
	assert.ok(existsSync(clean.worktreePath) === false);

	assert.equal(await statusPorcelain(repo), "");
});
