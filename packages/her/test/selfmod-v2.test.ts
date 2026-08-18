import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readSelfmodRecords, runSelfMod } from "../src/her-core/selfmod.ts";
import { checkRollback } from "../src/her-core/selfmod-rollback.ts";
import { applySkillLine, destroyFixture, git, greenHooks, makeFixture, proposalFor } from "./selfmod-harness.ts";

test("V2: merge a harmless skill edit then rollback on red organ ledger", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("v2");
	try {
		const merged = await runSelfMod({
			hooks: { ...greenHooks, apply: async ({ worktreePath }) => applySkillLine(worktreePath) },
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(merged.record.stage, "merge");
		assert.equal(typeof merged.record.mergeCommit, "string");
		assert.ok(merged.record.mergeCommit && merged.record.mergeCommit.length >= 7);
		const tag = (await git(fx.repoRoot, "rev-parse", `refs/tags/selfmod/${fx.id}`)).stdout.trim();
		assert.equal(tag, merged.record.mergeCommit);

		await mkdir(join(fx.memoryDir, "organs"), { recursive: true });
		await writeFile(
			join(fx.memoryDir, "organs", "growth.jsonl"),
			`${JSON.stringify({ ok: false, status: "red", selfmod: fx.id })}\n`,
			"utf8",
		);

		const rolled = await checkRollback({
			id: fx.id,
			memoryDir: fx.memoryDir,
			now: new Date("2026-08-18T01:00:00.000Z"),
			repoRoot: fx.repoRoot,
		});
		assert.equal(rolled.record.stage, "rolledback");
		assert.ok(rolled.record.rollback);
		const revertCommit = rolled.record.rollback?.revertCommit;
		assert.equal(typeof revertCommit, "string");
		assert.ok(revertCommit && revertCommit.length >= 7);
		const checked = await git(fx.repoRoot, "checkout", revertCommit);
		assert.equal(checked.stderr.includes("error"), false);
		const head = (await git(fx.repoRoot, "rev-parse", "HEAD")).stdout.trim();
		assert.equal(head, revertCommit);

		const stages = (await readSelfmodRecords(fx.memoryDir)).map((row) => row.stage);
		assert.ok(stages.includes("propose"));
		assert.ok(stages.includes("merge"));
		assert.ok(stages.includes("rolledback"));
	} finally {
		await destroyFixture(fx);
	}
});
