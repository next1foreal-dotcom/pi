import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseTasksPublish } from "../src/her-core/bg-task-config.ts";
import { loadBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask } from "../src/her-core/bg-task-spawn.ts";
import { ensureTaskWorktree } from "../src/her-core/long-task-worktree.ts";
import {
	claimWarmWorktree,
	clampWarmWorktreePoolSize,
	drainWarmWorktreePool,
	ensureWarmWorktreePool,
	listReadyWarmSlots,
	WARM_WORKTREE_POOL_MAX,
} from "../src/her-core/warm-worktree-pool.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

async function tempGitRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-warm-wt-repo-"));
	await git(root, "init", "-q");
	await git(root, "config", "user.email", "warm@example.com");
	await git(root, "config", "user.name", "Her Warm WT");
	for (let i = 0; i < 40; i++) {
		await writeFile(join(root, `f${i}.txt`), "x".repeat(800), "utf8");
	}
	await git(root, "add", "-A");
	await git(root, "commit", "-q", "-m", "initial");
	return root;
}

async function tempWorktreeRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "her-warm-wt-root-"));
}

function avg(xs: number[]): number {
	return xs.reduce((a, b) => a + b, 0) / xs.length;
}

test("clampWarmWorktreePoolSize clamps 0..2", () => {
	assert.equal(clampWarmWorktreePoolSize(-1), 0);
	assert.equal(clampWarmWorktreePoolSize(0), 0);
	assert.equal(clampWarmWorktreePoolSize(1), 1);
	assert.equal(clampWarmWorktreePoolSize(2), 2);
	assert.equal(clampWarmWorktreePoolSize(9), WARM_WORKTREE_POOL_MAX);
});

test("parseTasksPublish reads warm_worktree_pool_size", () => {
	const parsed = parseTasksPublish("tasks:\n  warm_worktree_pool_size: 2\n");
	assert.equal(parsed.tasks?.warmWorktreePoolSize, 2);
});

test("empty pool claim returns null immediately (<50ms)", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	const t0 = performance.now();
	const hit = await claimWarmWorktree(repo, "t-empty", { env });
	const ms = performance.now() - t0;
	assert.equal(hit, null);
	assert.ok(ms < 50, `empty claim blocked for ${ms.toFixed(1)}ms`);
});

test("ensure fills ready slots; claim rebinds to task path/branch", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };

	await ensureWarmWorktreePool(repo, 1, { env });
	assert.deepEqual(listReadyWarmSlots(env), ["w0"]);

	const claimed = await claimWarmWorktree(repo, "t-20260727-abc123", { env });
	assert.ok(claimed);
	assert.equal(claimed.warmClaimed, true);
	assert.equal(claimed.branch, "her-task/t-20260727-abc123");
	assert.ok(existsSync(claimed.worktreePath));
	assert.equal(
		(await git(claimed.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim(),
		"her-task/t-20260727-abc123",
	);
	assert.deepEqual(listReadyWarmSlots(env), []);

	// Canonical location is resumable via ensureTaskWorktree.
	const resumed = await ensureTaskWorktree(repo, "t-20260727-abc123", { env });
	assert.equal(resumed.resumed, true);
	assert.equal(resumed.worktreePath, claimed.worktreePath);

	await drainWarmWorktreePool(repo, { env });
});

test("LATENCY GATE: warm claim avg must beat cold ensureTaskWorktree", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };

	const cold: number[] = [];
	for (let i = 0; i < 4; i++) {
		const t0 = performance.now();
		await ensureTaskWorktree(repo, `cold-${i}`, { env });
		cold.push(performance.now() - t0);
	}

	const warm: number[] = [];
	for (let i = 0; i < 4; i++) {
		await ensureWarmWorktreePool(repo, 1, { env });
		assert.equal(listReadyWarmSlots(env).length, 1);
		const t0 = performance.now();
		const hit = await claimWarmWorktree(repo, `warm-${i}`, { env });
		warm.push(performance.now() - t0);
		assert.ok(hit?.warmClaimed);
	}

	const coldAvg = avg(cold);
	const warmAvg = avg(warm);
	const ratio = warmAvg / coldAvg;
	const delta = coldAvg - warmAvg;
	// Absolute win matters more than a brittle ratio: claim still pays branch -m + worktree move.
	assert.ok(
		warmAvg < coldAvg && delta >= 80 && ratio < 0.8,
		`warm claim not fast enough: cold_avg=${coldAvg.toFixed(0)}ms warm_avg=${warmAvg.toFixed(0)}ms ratio=${ratio.toFixed(2)} delta=${delta.toFixed(0)}ms`,
	);

	await drainWarmWorktreePool(repo, { env });
});

test("exclusive claim: second claimant misses", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	await ensureWarmWorktreePool(repo, 1, { env });

	const a = await claimWarmWorktree(repo, "t-a", { env });
	const b = await claimWarmWorktree(repo, "t-b", { env });
	assert.ok(a?.warmClaimed);
	assert.equal(b, null);

	await drainWarmWorktreePool(repo, { env });
});

test("spawnBgTask worktree=true claims warm slot when pool ready", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const memory = await mkdtemp(join(tmpdir(), "her-warm-mem-"));
	await mkdir(join(memory, ".her", "tasks"), { recursive: true });
	const fixture = join(memory, "exit.mjs");
	await writeFile(fixture, "process.exit(0)\n", "utf8");
	await writeFile(
		join(memory, ".her", "config.yaml"),
		[
			"tasks:",
			"  warm_worktree_pool_size: 1",
			"workers:",
			"  fake:",
			`    argv: ${JSON.stringify([process.execPath, fixture])}`,
			"",
		].join("\n"),
		"utf8",
	);

	const prev = process.env.HER_LONGTASK_WORKTREE_ROOT;
	process.env.HER_LONGTASK_WORKTREE_ROOT = worktreeRoot;
	try {
		await ensureWarmWorktreePool(repo, 1);
		assert.equal(listReadyWarmSlots().length, 1);

		const result = await spawnBgTask(memory, {
			objective: "warm spawn",
			worker: "fake",
			brief: "x",
			worktree: true,
			codeRoot: repo,
			skipGates: true,
			heartbeatMs: 1000,
		});
		assert.equal(result.status, "running");
		if (result.status !== "running") return;
		const loaded = await loadBgTask(memory, result.id);
		assert.equal(loaded?.record.warmWorktreeClaim, true);
		assert.ok(typeof result.worktree === "string" && existsSync(result.worktree));
		// Wait for exit so we don't leak runners.
		const done = join(tasksDir(memory), `${result.id}.done`);
		const start = Date.now();
		while (Date.now() - start < 10_000 && !existsSync(done)) {
			await new Promise((r) => setTimeout(r, 40));
		}
		assert.ok(existsSync(done));
		await drainWarmWorktreePool(repo);
	} finally {
		if (prev === undefined) delete process.env.HER_LONGTASK_WORKTREE_ROOT;
		else process.env.HER_LONGTASK_WORKTREE_ROOT = prev;
	}
});
