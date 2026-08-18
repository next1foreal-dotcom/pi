import assert from "node:assert/strict";
import test from "node:test";
import { runSelfMod } from "../src/her-core/selfmod.ts";
import {
	applySkillLine,
	applySkillTs,
	destroyFixture,
	greenHooks,
	makeFixture,
	proposalFor,
} from "./selfmod-harness.ts";

test("encoding: added Chinese in a skill .md is clean", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("enc-md-zh");
	try {
		const result = await runSelfMod({
			hooks: {
				...greenHooks,
				apply: async ({ worktreePath }) => applySkillLine(worktreePath, `# \u4e2d\u6587`),
			},
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.record.gate?.encodingScanClean, true);
		assert.equal(result.record.stage, "merge");
	} finally {
		await destroyFixture(fx);
	}
});

test("encoding: added Cyrillic in a skill .md is dirty", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("enc-md-cy");
	try {
		const result = await runSelfMod({
			hooks: {
				...greenHooks,
				apply: async ({ worktreePath }) => applySkillLine(worktreePath, `# \u041f\u0440\u0438\u0432\u0435\u0442`),
			},
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.record.gate?.encodingScanClean, false);
		assert.equal(result.record.stage, "rejected");
		assert.equal(result.record.mergeCommit, undefined);
	} finally {
		await destroyFixture(fx);
	}
});

test("encoding: added non-ASCII in a skill .ts is dirty", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("enc-ts");
	try {
		const result = await runSelfMod({
			hooks: {
				...greenHooks,
				apply: async ({ worktreePath }) => applySkillTs(worktreePath, `export const note = "\u4e2d\u6587";\n`),
			},
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.record.gate?.encodingScanClean, false);
		assert.equal(result.record.stage, "rejected");
		assert.equal(result.record.mergeCommit, undefined);
	} finally {
		await destroyFixture(fx);
	}
});
