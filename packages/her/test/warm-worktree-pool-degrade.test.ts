import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitRun } from "../src/her-core/long-task-worktree.ts";
import { claimWarmWorktree, ensureWarmWorktreePool, listReadyWarmSlots } from "../src/her-core/warm-worktree-pool.ts";

async function fixture(): Promise<{ repo: string; root: string; env: NodeJS.ProcessEnv }> {
	const repo = await mkdtemp(join(tmpdir(), "her-warm-degrade-repo-"));
	const root = await mkdtemp(join(tmpdir(), "her-warm-degrade-root-"));
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: root };
	await mkdir(join(root, ".warm", "w0"), { recursive: true });
	await writeFile(join(root, ".warm", "w0.ready"), "{}", "utf8");
	return { repo, root, env };
}

function readyGit(
	slotPath: string,
	overrides: Partial<
		Record<string, (cwd: string, ...args: string[]) => Promise<{ stdout: string; stderr: string }>>
	> = {},
): GitRun {
	return async (cwd, ...args) => {
		const key = args.join(" ");
		const override = overrides[key];
		if (override) return override(cwd, ...args);
		if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { stdout: "true\n", stderr: "" };
		if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: "branch\n", stderr: "" };
		if (args[0] === "worktree" && args[1] === "list") {
			return {
				stdout: [`worktree ${slotPath}`, "branch refs/heads/her-warm/w0", ""].join("\n"),
				stderr: "",
			};
		}
		return { stdout: "", stderr: "" };
	};
}

test("bad ready slot with missing branch is discarded without throwing", async () => {
	const { repo, root, env } = await fixture();
	const gitRun: GitRun = async (_cwd, ...args) => {
		if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { stdout: "true\n", stderr: "" };
		if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("missing branch");
		return { stdout: "", stderr: "" };
	};

	assert.equal(await claimWarmWorktree(repo, "t-missing-branch", { env, gitRun }), null);
	assert.deepEqual(listReadyWarmSlots(env), []);
	assert.equal(existsSync(join(root, ".warm", "w0.claiming")), false);
});

test("branch rename failure degrades to a cold miss and clears claiming marker", async () => {
	const { repo, root, env } = await fixture();
	const gitRun = readyGit(join(root, ".warm", "w0"), {
		"branch -m her-warm/w0 her-task/t-rename-fails": async () => {
			throw new Error("rename failed");
		},
	});

	assert.equal(await claimWarmWorktree(repo, "t-rename-fails", { env, gitRun }), null);
	assert.equal(existsSync(join(root, ".warm", "w0.claiming")), false);
});

test("worktree move failure rolls the renamed branch back and leaves no task branch", async () => {
	const { repo, root, env } = await fixture();
	const branches = new Set(["her-warm/w0"]);
	const calls: string[] = [];
	const gitRun: GitRun = async (_cwd, ...args) => {
		calls.push(args.join(" "));
		if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { stdout: "true\n", stderr: "" };
		if (args[0] === "rev-parse" && args[1] === "--verify") {
			if (!branches.has("her-warm/w0")) throw new Error("missing branch");
			return { stdout: "branch\n", stderr: "" };
		}
		if (args[0] === "worktree" && args[1] === "list") {
			return {
				stdout: `worktree ${join(root, ".warm", "w0")}\nbranch refs/heads/her-warm/w0\n`,
				stderr: "",
			};
		}
		if (args[0] === "branch" && args[1] === "-m") {
			branches.delete(args[2]);
			branches.add(args[3]);

			return { stdout: "", stderr: "" };
		}
		if (args[0] === "worktree" && args[1] === "move") throw new Error("move failed");
		if (args[0] === "branch" && args[1] === "-D") branches.delete(args[2]);
		return { stdout: "", stderr: "" };
	};

	assert.equal(await claimWarmWorktree(repo, "t-move-fails", { env, gitRun }), null);
	assert.equal(branches.has("her-warm/w0"), false);
	assert.equal(branches.has("her-task/t-move-fails"), false);
	assert.equal(calls.includes("branch -m her-task/t-move-fails her-warm/w0"), true);
	assert.equal(existsSync(join(root, ".warm", "w0.claiming")), false);
});

test("refill does not publish ready marker when worktree creation fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-warm-refill-root-"));
	const env = { ...process.env, HER_LONGTASK_WORKTREE_ROOT: root };
	const gitRun: GitRun = async (_cwd, ...args) => {
		if (args[0] === "worktree" && args[1] === "add") throw new Error("add failed");
		return { stdout: "", stderr: "" };
	};

	await assert.rejects(() => ensureWarmWorktreePool("repo", 1, { env, gitRun }), /add failed/);
	assert.deepEqual(listReadyWarmSlots(env), []);
});
