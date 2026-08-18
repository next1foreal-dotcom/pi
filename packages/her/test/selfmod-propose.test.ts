import assert from "node:assert/strict";
import test from "node:test";
import { readSelfmodRecords, runSelfMod } from "../src/her-core/selfmod.ts";
import { destroyFixture, greenHooks, makeFixture, proposalFor } from "./selfmod-harness.ts";

test("idea motivation stops at propose and does not run", async () => {
	const fx = await makeFixture("idea");
	try {
		const result = await runSelfMod({
			hooks: greenHooks,
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx, { motivation: { kind: "idea", evidenceRef: "" } }),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.outcome, "not-run");
		assert.equal(result.record.stage, "propose");
		assert.equal(result.record.worktreePath, undefined);
		assert.equal(result.record.mergeCommit, undefined);
		const stages = (await readSelfmodRecords(fx.memoryDir)).map((row) => row.stage);
		assert.deepEqual(stages, ["propose"]);
	} finally {
		await destroyFixture(fx);
	}
});

test("targetPaths outside the v1 allowlist reject at propose", async () => {
	const fx = await makeFixture("deny");
	try {
		const result = await runSelfMod({
			hooks: greenHooks,
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx, { targetPaths: ["prompts/her.md"] }),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.record.stage, "rejected");
		assert.equal(result.record.worktreePath, undefined);
		assert.equal(result.record.mergeCommit, undefined);
	} finally {
		await destroyFixture(fx);
	}
});
