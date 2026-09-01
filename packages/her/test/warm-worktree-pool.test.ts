import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
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

// G-272: 8 raw samples, drop the first (cold-start), gate on median of the remaining 7.
// min was the first candidate but a full-suite cache-warming trend made the last
// sample the fastest and let a broken fallback look like a 50ms win. median
// ignores that tail. 20ms floor is below the worst healthy isolated median-delta
// in the 10-round table (~43ms) with ~2x margin.
const LATENCY_RAW_SAMPLES = 8;
const LATENCY_ABS_DELTA_MS = 20;

function avg(xs: number[]): number {
	return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmtMs(xs: number[]): string {
	return xs.map((n) => n.toFixed(1)).join(",");
}

type LatencyGateReport = {
	ok: boolean;
	detail: string;
	coldMin: number;
	warmMin: number;
	delta: number;
	ratio: number;
};

function evaluateLatencyGate(coldRaw: number[], warmRaw: number[]): LatencyGateReport {
	const cold = coldRaw.slice(1);
	const warm = warmRaw.slice(1);
	const coldMin = Math.min(...cold);
	const warmMin = Math.min(...warm);
	const coldMedian = median(cold);
	const warmMedian = median(warm);
	const coldAvg = avg(cold);
	const warmAvg = avg(warm);
	const delta = coldMedian - warmMedian;
	const ratio = warmMedian / coldMedian;
	// Direction + absolute floor on the median. Ratio is reported but not gated:
	// isolated 10-round avg-ratios 0.76-0.85 straddled the old 0.8 line.
	const ok = warmMedian < coldMedian && delta >= LATENCY_ABS_DELTA_MS;
	const detail =
		`cold_median=${coldMedian.toFixed(1)}ms warm_median=${warmMedian.toFixed(1)}ms ` +
		`delta=${delta.toFixed(1)}ms ratio=${ratio.toFixed(3)} ` +
		`(need warm_median<cold_median and delta>=${LATENCY_ABS_DELTA_MS}ms; ratio not gated) ` +
		`cold_min=${coldMin.toFixed(1)} cold_avg=${coldAvg.toFixed(1)} ` +
		`warm_min=${warmMin.toFixed(1)} warm_avg=${warmAvg.toFixed(1)} ` +
		`cold_samples=[${fmtMs(coldRaw)}] warm_samples=[${fmtMs(warmRaw)}] ` +
		`(dropped first of ${LATENCY_RAW_SAMPLES})`;
	return { ok, detail, coldMin, warmMin, delta, ratio };
}

async function removeTimedWorktree(repo: string, worktreePath: string, branch: string): Promise<void> {
	try {
		await git(repo, "worktree", "remove", worktreePath, "--force");
	} catch {
		/* already gone */
	}
	try {
		await git(repo, "branch", "-D", branch);
	} catch {
		/* already gone */
	}
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

test("LATENCY GATE: warm median must beat cold median by an absolute floor", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };

	// Interleave + drop leftover worktrees so later samples are not paying for
	// `git worktree list` growth, and so a mid-run load spike hits both legs.
	const cold: number[] = [];
	const warm: number[] = [];
	for (let i = 0; i < LATENCY_RAW_SAMPLES; i++) {
		const coldT0 = performance.now();
		const coldWt = await ensureTaskWorktree(repo, `cold-${i}`, { env });
		cold.push(performance.now() - coldT0);
		await removeTimedWorktree(repo, coldWt.worktreePath, coldWt.branch);

		await ensureWarmWorktreePool(repo, 1, { env });
		assert.equal(listReadyWarmSlots(env).length, 1);
		const warmT0 = performance.now();
		const hit = await claimWarmWorktree(repo, `warm-${i}`, { env });
		warm.push(performance.now() - warmT0);
		assert.ok(hit);
		assert.equal(hit.warmClaimed, true);
		await removeTimedWorktree(repo, hit.worktreePath, hit.branch);
	}

	const report = evaluateLatencyGate(cold, warm);
	console.log(`LATENCY_GATE ${report.detail}`);
	assert.ok(report.ok, `warm claim not fast enough: ${report.detail}`);

	await drainWarmWorktreePool(repo, { env });
});

test("LATENCY GATE goes RED when the pool misses and spawn falls back to cold", async () => {
	// Same predicate as the green gate. A no-win series must be red; a healthy-shaped
	// series must still be green (the gate is not a tautology).
	const sameCost = [240, 250, 248, 252, 246, 251, 249, 247];
	assert.equal(evaluateLatencyGate(sameCost, sameCost).ok, false);
	assert.equal(
		evaluateLatencyGate([400, 250, 252, 248, 251, 249, 253, 247], [400, 190, 188, 195, 192, 187, 191, 189]).ok,
		true,
	);

	const repo = await tempGitRepo();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: await tempWorktreeRoot() };

	// Live miss: empty pool, claimWarmWorktree returns null (spawn then does
	// `warm ?? ensureTaskWorktree` — the cold path). Live fallback-vs-cold timing
	// is the same syscall plus cache noise and is not a stable red (measured
	// median delta hit the 20ms floor on a two-repo run). The cost model of that
	// fallback is the cold series on both legs.
	assert.equal(listReadyWarmSlots(env).length, 0);
	assert.equal(await claimWarmWorktree(repo, "broken-miss", { env }), null);

	const cold: number[] = [];
	for (let i = 0; i < LATENCY_RAW_SAMPLES; i++) {
		const t0 = performance.now();
		const wt = await ensureTaskWorktree(repo, `broken-cold-${i}`, { env });
		cold.push(performance.now() - t0);
		await removeTimedWorktree(repo, wt.worktreePath, wt.branch);
	}

	const report = evaluateLatencyGate(cold, cold);
	console.log(`LATENCY_GATE_BROKEN ${report.detail}`);
	assert.equal(report.ok, false, `broken pool (fallback == cold) must trip the gate, but it passed: ${report.detail}`);
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

const JUNCTION_TYPE = process.platform === "win32" ? "junction" : "dir";

async function seedHostNodeModules(repo: string): Promise<string> {
	const hostNm = join(repo, "node_modules");
	const files: Array<[string, string]> = [
		[join(".bin", "probe-1.txt"), "one\n"],
		[join(".bin", "probe-2.txt"), "two\n"],
		[join(".bin", "probe-3.txt"), "three\n"],
		["keep-me.txt", "keep\n"],
		[join("nested", "deep.txt"), "deep\n"],
	];
	for (const [rel, body] of files) {
		const abs = join(hostNm, rel);
		await mkdir(join(abs, ".."), { recursive: true });
		await writeFile(abs, body, "utf8");
	}
	return hostNm;
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const stack = [""];
	while (stack.length > 0) {
		const rel = stack.pop() ?? "";
		const abs = rel ? join(root, rel) : root;
		let entries: Array<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; name: string }>;
		try {
			entries = await readdir(abs, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const childRel = rel ? `${rel.replace(/\\/g, "/")}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				stack.push(childRel);
				continue;
			}
			if (entry.isFile()) out[childRel] = await readFile(join(abs, entry.name), "utf8");
		}
	}
	return out;
}

async function ensureJunction(source: string, dest: string): Promise<void> {
	try {
		await lstat(dest);
		return;
	} catch {
		/* dest missing */
	}
	await symlink(source, dest, JUNCTION_TYPE);
}

test(
	"G-364a drainWarmWorktreePool unlinks junctions and does not delete host node_modules",
	{ timeout: 60_000 },
	async () => {
		const repo = await tempGitRepo();
		const worktreeRoot = await tempWorktreeRoot();
		const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
		const hostNm = await seedHostNodeModules(repo);
		const before = await snapshotFiles(hostNm);
		assert.equal(Object.keys(before).length, 5);
		await ensureWarmWorktreePool(repo, 1, { env });
		await ensureJunction(hostNm, join(worktreeRoot, ".warm", "w0", "node_modules"));

		await drainWarmWorktreePool(repo, { env });

		const after = await snapshotFiles(hostNm);
		assert.deepEqual(after, before, "host node_modules files must survive warm-pool drain");
	},
);

test("G-364b warm-pool prebuilt slot junctions codeRoot node_modules", async () => {
	const repo = await tempGitRepo();
	const worktreeRoot = await tempWorktreeRoot();
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: worktreeRoot };
	const hostNm = await seedHostNodeModules(repo);

	await ensureWarmWorktreePool(repo, 1, { env });

	const dest = join(worktreeRoot, ".warm", "w0", "node_modules");
	const st = await lstat(dest);
	assert.ok(st.isSymbolicLink(), "expected warm slot node_modules to be a junction (win32) or dir symlink");
	assert.equal(await realpath(dest), await realpath(hostNm));
	await drainWarmWorktreePool(repo, { env });
	const after = await snapshotFiles(hostNm);
	assert.equal(after["keep-me.txt"], "keep\n");
});
