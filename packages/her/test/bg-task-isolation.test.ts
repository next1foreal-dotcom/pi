/**
 * G-198 — harden her_task_spawn's worktree isolation: a dirty-but-uncommitted worktree must
 * never be force-deleted (A), a failed worktree create must not leave half-built state behind
 * (B), worktree git calls must not hang the caller forever (C), orphaned her-task/* worktrees
 * need a cleanup entrypoint (D), Windows delete-after-kill races get a retry (E), and the
 * public `isolation` switch is an alias for the legacy `worktree` boolean (F).
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask, stopBgTask } from "../src/her-core/bg-task-spawn.ts";
import {
	discardPartialTaskWorktree,
	ensureTaskWorktree,
	type GitRun,
	maybeRemoveEmptyTaskWorktree,
	purgeOrphanTaskWorktrees,
	removeTaskWorktree,
} from "../src/her-core/long-task-worktree.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

async function tempGitRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-iso-repo-"));
	await git(root, "init", "-q");
	await git(root, "config", "user.email", "iso@example.com");
	await git(root, "config", "user.name", "Her Isolation Test");
	await writeFile(join(root, "README.md"), "# repo\n", "utf8");
	await git(root, "add", "-A");
	await git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

async function tempWorktreeRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "her-iso-worktrees-"));
}

async function statusPorcelain(repo: string): Promise<string> {
	return (await git(repo, "status", "--porcelain")).stdout.trim();
}

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-iso-mem-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(
		join(root, ".her", "config.yaml"),
		["tasks:", "  max_concurrent: 5", "  max_retries: 0", ""].join("\n"),
		"utf8",
	);
	return root;
}

async function waitForDone(memory: string, id: string, timeoutMs = 10_000): Promise<void> {
	const done = join(tasksDir(memory), `${id}.done`);
	const start = Date.now();
	while (Date.now() - start < timeoutMs && !existsSync(done)) {
		await new Promise((r) => setTimeout(r, 40));
	}
}

async function withWorktreeRoot<T>(worktreeRoot: string, fn: () => Promise<T>): Promise<T> {
	const prev = process.env.HER_LONGTASK_WORKTREE_ROOT;
	process.env.HER_LONGTASK_WORKTREE_ROOT = worktreeRoot;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.HER_LONGTASK_WORKTREE_ROOT;
		else process.env.HER_LONGTASK_WORKTREE_ROOT = prev;
	}
}

test('F1 spawn(isolation:"worktree") records worktree/codeRoot/worktreeBranch/worktreeBaseSha', async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const memory = await memoryRoot();

	await withWorktreeRoot(worktreeRoot, async () => {
		const result = await spawnBgTask(memory, {
			objective: "isolation worktree",
			command: [process.execPath, "-e", "console.log(process.cwd())"],
			isolation: "worktree",
			codeRoot: repo,
			skipGates: true,
			heartbeatMs: 1000,
		});
		assert.equal(result.status, "running");
		if (result.status !== "running") return;
		const loaded = await loadBgTask(memory, result.id);
		assert.equal(typeof loaded?.record.worktree, "string");
		assert.equal(loaded?.record.codeRoot, repo);
		assert.equal(typeof loaded?.record.worktreeBranch, "string");
		assert.match(String(loaded?.record.worktreeBranch), new RegExp(result.id));
		assert.equal(typeof loaded?.record.worktreeBaseSha, "string");
		await stopBgTask(memory, result.id);
		await waitForDone(memory, result.id);
	});
});

test('F2 isolation:"worktree" and worktree:true build a worktree the same way', async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const memory = await memoryRoot();

	await withWorktreeRoot(worktreeRoot, async () => {
		for (const spawnInput of [{ isolation: "worktree" as const }, { worktree: true as const }]) {
			const result = await spawnBgTask(memory, {
				objective: "isolation equivalence",
				command: [process.execPath, "-e", "console.log(process.cwd())"],
				...spawnInput,
				codeRoot: repo,
				skipGates: true,
				heartbeatMs: 1000,
			});
			assert.equal(result.status, "running");
			if (result.status !== "running") continue;
			const loaded = await loadBgTask(memory, result.id);
			assert.equal(typeof loaded?.record.worktree, "string");
			assert.equal(typeof loaded?.record.worktreeBranch, "string");
			await stopBgTask(memory, result.id);
			await waitForDone(memory, result.id);
		}
	});
});

test('F4 isolation:"none" + worktree:true is a contradiction and throws (no guessing)', async () => {
	const memory = await memoryRoot();
	await assert.rejects(
		() =>
			spawnBgTask(memory, {
				objective: "contradiction",
				command: [process.execPath, "-e", "console.log(1)"],
				isolation: "none",
				worktree: true,
				skipGates: true,
			}),
		/isolation.*conflicts.*worktree/,
	);
});

test('F5 isolation:"bogus" is rejected with the offending value and the legal values in the message', async () => {
	const memory = await memoryRoot();
	await assert.rejects(
		() =>
			spawnBgTask(memory, {
				objective: "bogus isolation",
				command: [process.execPath, "-e", "console.log(1)"],
				// Intentionally invalid at runtime — extension.ts forwards an unvalidated MCP string,
				// so spawnBgTask itself must be the fail-loud boundary, not the type system.
				isolation: "bogus" as unknown as "none" | "worktree",
				skipGates: true,
			}),
		/isolation.*"none".*"worktree".*bogus/,
	);
});

test("F3 neither isolation nor worktree given leaves record.worktree null (legacy path, zero change)", async () => {
	const memory = await memoryRoot();
	const result = await spawnBgTask(memory, {
		objective: "no isolation",
		command: [process.execPath, "-e", "console.log(1)"],
		skipGates: true,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status !== "running") return;
	const loaded = await loadBgTask(memory, result.id);
	assert.equal(loaded?.record.worktree, null);
	await stopBgTask(memory, result.id);
	await waitForDone(memory, result.id);
});

test('F6 spawn(isolation:"worktree") against a non-git codeRoot fails loud (never silently un-isolates)', async () => {
	const memory = await memoryRoot();
	const notARepo = await mkdtemp(join(tmpdir(), "her-iso-not-a-repo-"));
	const result = await spawnBgTask(memory, {
		objective: "not a repo",
		command: [process.execPath, "-e", "console.log(1)"],
		isolation: "worktree",
		codeRoot: notARepo,
		skipGates: true,
	});
	assert.equal(result.status, "failed");
	if (result.status !== "failed") return;
	assert.equal(result.failureReason, "never_started");
	assert.match(result.error, /git/i);
});

test("A1 maybeRemoveEmptyTaskWorktree removes a 0-commit, clean worktree", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };

	const worktree = await ensureTaskWorktree(repo, "a1-clean", { env });
	const result = await maybeRemoveEmptyTaskWorktree(repo, "a1-clean", worktree.baseSha, { env });

	assert.equal(result.removed, true);
	assert.equal(existsSync(worktree.worktreePath), false);
});

test("A2 maybeRemoveEmptyTaskWorktree keeps a 0-commit but dirty worktree (regression pin for the data-loss bug)", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };

	const worktree = await ensureTaskWorktree(repo, "a2-dirty", { env });
	const uncommittedFile = join(worktree.worktreePath, "AGENT-WORK.md");
	await writeFile(uncommittedFile, "work in progress, never committed\n", "utf8");

	const result = await maybeRemoveEmptyTaskWorktree(repo, "a2-dirty", worktree.baseSha, { env });

	assert.equal(result.removed, false);
	assert.equal(result.keptBecause, "dirty");
	assert.equal(existsSync(worktree.worktreePath), true);
	assert.equal(existsSync(uncommittedFile), true);
});

test("A3 maybeRemoveEmptyTaskWorktree keeps a worktree with a real commit", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };

	const worktree = await ensureTaskWorktree(repo, "a3-committed", { env });
	await writeFile(join(worktree.worktreePath, "work.txt"), "real work\n", "utf8");
	await git(worktree.worktreePath, "add", "work.txt");
	await git(worktree.worktreePath, "commit", "-q", "-m", "task commit");

	const result = await maybeRemoveEmptyTaskWorktree(repo, "a3-committed", worktree.baseSha, { env });

	assert.equal(result.removed, false);
	assert.equal(result.keptBecause, "commits");
	assert.equal(result.branch, "her-task/a3-committed");
	assert.ok(result.commits >= 1);
	assert.equal(existsSync(worktree.worktreePath), true);
});

test("B1 discardPartialTaskWorktree removes an already-built task worktree and branch without throwing", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	const worktree = await ensureTaskWorktree(repo, "b1-built", { env });

	await assert.doesNotReject(() => discardPartialTaskWorktree(repo, "b1-built", { env }));

	assert.equal(existsSync(worktree.worktreePath), false);
	assert.equal((await git(repo, "branch", "--list", "her-task/b1-built")).stdout.trim(), "");
});

test("B2 discardPartialTaskWorktree on an unknown taskId returns silently without throwing", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };

	await assert.doesNotReject(() => discardPartialTaskWorktree(repo, "no-such-task", { env }));
});

/**
 * B3 — degraded form of the spec'd "inject a failing gitRun through spawnBgTask" test:
 * SpawnBgTaskInput has no gitRun passthrough (adding one is out of this task's file scope), so
 * this exercises the same failure shape directly against ensureTaskWorktree +
 * discardPartialTaskWorktree instead. The fake gitRun lets `worktree add` really create the
 * worktree+branch (so there is genuine partial state to clean up) and only fails the
 * `rev-parse HEAD` step that immediately follows it inside ensureTaskWorktree — the same shape a
 * real timeout from requirement C would produce.
 */
test("B3 a gitRun that fails after `worktree add` leaves partial state that discardPartialTaskWorktree fully cleans up", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	const realGit: GitRun = async (cwd, ...args) => git(cwd, ...args);
	const flaky: GitRun = async (cwd, ...args) => {
		if (args[0] === "rev-parse") throw new Error("simulated: git timed out");
		return realGit(cwd, ...args);
	};

	await assert.rejects(
		() => ensureTaskWorktree(repo, "b3-partial", { env, gitRun: flaky }),
		/simulated: git timed out/,
	);

	// The worktree and branch were really created before the simulated failure.
	const worktreePath = join(worktreeRoot, "b3-partial");
	assert.equal(existsSync(worktreePath), true);
	assert.match((await git(repo, "branch", "--list", "her-task/b3-partial")).stdout, /her-task\/b3-partial/);

	await discardPartialTaskWorktree(repo, "b3-partial", { env });

	assert.equal(existsSync(worktreePath), false);
	assert.equal((await git(repo, "branch", "--list", "her-task/b3-partial")).stdout.trim(), "");
});

/**
 * C1 — extra test beyond the spec'd list: verifies HER_WORKTREE_GIT_TIMEOUT_MS is actually wired
 * to the module's default git executor, not just documented. A 1ms ceiling is reliably beaten by
 * real git-subprocess spawn overhead, so this doesn't depend on a slow disk or lock contention to
 * be deterministic.
 */
test("C1 HER_WORKTREE_GIT_TIMEOUT_MS bounds the default git executor and surfaces as a clear timeout error", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot, HER_WORKTREE_GIT_TIMEOUT_MS: "1" };

	await assert.rejects(() => ensureTaskWorktree(repo, "c1-timeout", { env }), /timed out after 1ms/);
});

/**
 * E1/E2 — extra tests beyond the spec'd list: the spec calls for retry-with-backoff on Windows
 * `git worktree remove` failures but doesn't enumerate a test for it (a real file-handle race is
 * not something a fast unit test can reproduce deterministically). These use an injected gitRun
 * to exercise the retry loop's own logic deterministically instead of waiting on real contention.
 */
test("E1 removeTaskWorktree retries a failing git worktree remove and succeeds on the 3rd attempt", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	await ensureTaskWorktree(repo, "e1-retry", { env });

	let removeAttempts = 0;
	const flaky: GitRun = async (cwd, ...args) => {
		if (args[0] === "worktree" && args[1] === "remove") {
			removeAttempts++;
			if (removeAttempts < 3) throw new Error("simulated: file in use (handle held by just-killed child)");
		}
		return git(cwd, ...args);
	};

	const result = await removeTaskWorktree(repo, "e1-retry", { env, force: true, gitRun: flaky });

	assert.deepEqual(result, { removed: true });
	assert.equal(removeAttempts, 3);
	assert.equal((await git(repo, "branch", "--list", "her-task/e1-retry")).stdout.trim(), "");
});

test("E2 removeTaskWorktree gives up and surfaces the error once every retry is exhausted", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	await ensureTaskWorktree(repo, "e2-exhausted", { env });

	let removeAttempts = 0;
	const alwaysFails: GitRun = async (cwd, ...args) => {
		if (args[0] === "worktree" && args[1] === "remove") {
			removeAttempts++;
			throw new Error("simulated: file permanently locked");
		}
		return git(cwd, ...args);
	};

	await assert.rejects(
		() => removeTaskWorktree(repo, "e2-exhausted", { env, force: true, gitRun: alwaysFails }),
		/simulated: file permanently locked/,
	);
	assert.equal(removeAttempts, 3);
	// Cleanup with the real executor since the simulated one never actually removed it.
	await removeTaskWorktree(repo, "e2-exhausted", { env, force: true });
});

test("D1 purgeOrphanTaskWorktrees removes only the dead-and-clean tree, leaves the live one alone", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	const dead = await ensureTaskWorktree(repo, "d1-dead", { env });
	const alive = await ensureTaskWorktree(repo, "d1-alive", { env });
	const isLive = (taskId: string) => taskId === "d1-alive";

	const results = await purgeOrphanTaskWorktrees(repo, isLive, { env });

	const deadResult = results.find((r) => r.taskId === "d1-dead");
	const aliveResult = results.find((r) => r.taskId === "d1-alive");
	assert.equal(deadResult?.removed, true);
	assert.equal(aliveResult?.removed, false);
	assert.equal(existsSync(dead.worktreePath), false);
	assert.equal(existsSync(alive.worktreePath), true);
});

test("D2 purgeOrphanTaskWorktrees never deletes a dead-but-dirty tree", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	const dirty = await ensureTaskWorktree(repo, "d2-dirty", { env });
	await writeFile(join(dirty.worktreePath, "uncommitted.md"), "someone's work\n", "utf8");

	const results = await purgeOrphanTaskWorktrees(repo, () => false, { env });

	const result = results.find((r) => r.taskId === "d2-dirty");
	assert.equal(result?.removed, false);
	assert.match(String(result?.reason), /dirty/);
	assert.equal(existsSync(dirty.worktreePath), true);
});

test("D3 purgeOrphanTaskWorktrees never deletes a dead-but-committed tree", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	const committed = await ensureTaskWorktree(repo, "d3-committed", { env });
	await writeFile(join(committed.worktreePath, "shipped.txt"), "real work\n", "utf8");
	await git(committed.worktreePath, "add", "shipped.txt");
	await git(committed.worktreePath, "commit", "-q", "-m", "orphaned but real");

	const results = await purgeOrphanTaskWorktrees(repo, () => false, { env });

	const result = results.find((r) => r.taskId === "d3-committed");
	assert.equal(result?.removed, false);
	assert.match(String(result?.reason), /commit/);
	assert.equal(existsSync(committed.worktreePath), true);
});

test('F7 concurrent isolation:"worktree" spawns get independent worktrees and never touch the main checkout', async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const memory = await memoryRoot();

	await withWorktreeRoot(worktreeRoot, async () => {
		const [resultA, resultB] = await Promise.all([
			spawnBgTask(memory, {
				objective: "concurrent A",
				command: [process.execPath, "-e", "require('fs').writeFileSync('same-name.txt', 'A')"],
				isolation: "worktree",
				codeRoot: repo,
				skipGates: true,
				heartbeatMs: 1000,
			}),
			spawnBgTask(memory, {
				objective: "concurrent B",
				command: [process.execPath, "-e", "require('fs').writeFileSync('same-name.txt', 'B')"],
				isolation: "worktree",
				codeRoot: repo,
				skipGates: true,
				heartbeatMs: 1000,
			}),
		]);

		assert.equal(resultA.status, "running");
		assert.equal(resultB.status, "running");
		if (resultA.status !== "running" || resultB.status !== "running") return;

		const loadedA = await loadBgTask(memory, resultA.id);
		const loadedB = await loadBgTask(memory, resultB.id);
		assert.notEqual(loadedA?.record.worktree, loadedB?.record.worktree);
		assert.notEqual(loadedA?.record.worktreeBranch, loadedB?.record.worktreeBranch);

		await waitForDone(memory, resultA.id);
		await waitForDone(memory, resultB.id);

		const fileA = join(String(loadedA?.record.worktree), "same-name.txt");
		const fileB = join(String(loadedB?.record.worktree), "same-name.txt");
		assert.equal(await readFile(fileA, "utf8"), "A");
		assert.equal(await readFile(fileB, "utf8"), "B");

		assert.equal(await statusPorcelain(repo), "");

		await stopBgTask(memory, resultA.id);
		await stopBgTask(memory, resultB.id);
	});
});
