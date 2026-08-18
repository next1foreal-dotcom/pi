import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSelfMod } from "../src/her-core/selfmod.ts";
import { acquireSelfmodLock, selfmodLockPath } from "../src/her-core/selfmod-lock.ts";
import { createSelfmodWorktree, removeSelfmodWorktree } from "../src/her-core/selfmod-worktree.ts";
import { writeJson } from "../src/her-core/store.ts";
import { applySkillLine, destroyFixture, git, greenHooks, makeFixture, proposalFor } from "./selfmod-harness.ts";

async function provisionHostLayout(repoRoot: string): Promise<void> {
	await mkdir(join(repoRoot, "node_modules", ".bin"), { recursive: true });
	await writeFile(join(repoRoot, "node_modules", ".bin", "dummy"), "host\n", "utf8");
	await mkdir(join(repoRoot, "packages", "ai", "src", "providers", "data"), { recursive: true });
	await writeFile(
		join(repoRoot, "packages", "ai", "src", "providers", "data", "x.json"),
		`${JSON.stringify({ ok: true })}\n`,
		"utf8",
	);
}

test("createSelfmodWorktree junctions node_modules and copies providers/data", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("wt-junc");
	try {
		await provisionHostLayout(fx.repoRoot);
		const tree = await createSelfmodWorktree({
			id: fx.id,
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		const linked = join(tree.worktreePath, "node_modules", ".bin", "dummy");
		assert.equal((await readFile(linked, "utf8")).trim(), "host");
		const hostNm = await realpath(join(fx.repoRoot, "node_modules"));
		const treeNm = await realpath(join(tree.worktreePath, "node_modules"));
		assert.equal(treeNm, hostNm);
		const copied = await readFile(
			join(tree.worktreePath, "packages", "ai", "src", "providers", "data", "x.json"),
			"utf8",
		);
		assert.match(copied, /"ok":\s*true/);
	} finally {
		await destroyFixture(fx);
	}
});

test(
	"removeSelfmodWorktree unlinks the junction before deleting the tree and prunes",
	{ timeout: 60_000 },
	async () => {
		const fx = await makeFixture("wt-rm");
		try {
			await provisionHostLayout(fx.repoRoot);
			const tree = await createSelfmodWorktree({
				id: fx.id,
				repoRoot: fx.repoRoot,
				worktreeRoot: fx.worktreeRoot,
			});
			const result = await removeSelfmodWorktree({
				branch: tree.branch,
				git,
				repoRoot: fx.repoRoot,
				worktreePath: tree.worktreePath,
			});
			assert.ok(result.steps.indexOf("unlink-junction") < result.steps.indexOf("remove-tree"));
			assert.ok(result.steps.indexOf("remove-tree") < result.steps.indexOf("prune"));
			assert.ok(result.steps.indexOf("prune") < result.steps.indexOf("delete-branch"));
			assert.ok(result.steps.includes("scan-junctions"));
			await assert.rejects(stat(tree.worktreePath));
			assert.equal((await git(fx.repoRoot, "branch", "--list", tree.branch)).stdout.trim(), "");
			assert.equal((await readFile(join(fx.repoRoot, "node_modules", ".bin", "dummy"), "utf8")).trim(), "host");
		} finally {
			await destroyFixture(fx);
		}
	},
);

test("a live selfmod lock refuses a new run", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("lock-live");
	try {
		const now = new Date("2026-08-18T12:00:00.000Z");
		await writeJson(selfmodLockPath(fx.memoryDir), {
			by: "other",
			startedAt: "2026-08-18T11:30:00.000Z",
			expiresAt: "2026-08-18T12:30:00.000Z",
			reason: "busy",
		});
		const result = await runSelfMod({
			hooks: { ...greenHooks, apply: async ({ worktreePath }) => applySkillLine(worktreePath) },
			memoryDir: fx.memoryDir,
			now,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.outcome, "not-run");
		assert.equal(result.record.worktreePath, undefined);
		assert.equal(result.record.mergeCommit, undefined);
	} finally {
		await destroyFixture(fx);
	}
});

test("an expired selfmod lock is treated as absent", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("lock-exp");
	try {
		const now = new Date("2026-08-18T12:00:00.000Z");
		await writeJson(selfmodLockPath(fx.memoryDir), {
			by: "stale",
			startedAt: "2026-08-18T08:00:00.000Z",
			expiresAt: "2026-08-18T09:00:00.000Z",
			reason: "old",
		});
		const result = await runSelfMod({
			hooks: { ...greenHooks, apply: async ({ worktreePath }) => applySkillLine(worktreePath) },
			memoryDir: fx.memoryDir,
			now,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.record.stage, "merge");
	} finally {
		await destroyFixture(fx);
	}
});

test("acquireSelfmodLock reports held when a valid lock is present", async () => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-g281-lock-"));
	await mkdir(join(memoryDir, ".her"), { recursive: true });
	const now = new Date("2026-08-18T12:00:00.000Z");
	await writeJson(selfmodLockPath(memoryDir), {
		by: "holder",
		startedAt: "2026-08-18T11:00:00.000Z",
		expiresAt: "2026-08-18T12:30:00.000Z",
		reason: "held",
	});
	const first = await acquireSelfmodLock({ memoryDir, now, by: "challenger" });
	assert.equal(first.acquired, false);
});
