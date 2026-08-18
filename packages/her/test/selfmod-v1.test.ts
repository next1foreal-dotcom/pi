import assert from "node:assert/strict";
import test from "node:test";
import { listHerEvents } from "../src/her-core/event-history.ts";
import { readSelfmodRecords, runSelfMod } from "../src/her-core/selfmod.ts";
import { applySkillLine, destroyFixture, git, greenHooks, makeFixture, proposalFor } from "./selfmod-harness.ts";

test("V1: injected failing test rejects with full gate result and no merge", async () => {
	const fx = await makeFixture("v1");
	try {
		const result = await runSelfMod({
			hooks: {
				...greenHooks,
				runTests: async () => ({ failed: 1, passed: 0 }),
			},
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.record.stage, "rejected");
		assert.equal(result.record.mergeCommit, undefined);
		const gate = result.record.gate;
		assert.ok(gate, "gate result must be present");
		assert.equal(typeof gate.typecheckExit, "number");
		assert.equal(typeof gate.testsPassed, "number");
		assert.equal(typeof gate.testsFailed, "number");
		assert.equal(typeof gate.evalGateFixturesPassed, "boolean");
		assert.equal(typeof gate.anchorScanClean, "boolean");
		assert.equal(typeof gate.encodingScanClean, "boolean");
		assert.equal(gate.testsFailed, 1);
		assert.notEqual(gate.testsFailed, undefined);
		assert.equal(gate.typecheckExit, 0);
		const rows = await readSelfmodRecords(fx.memoryDir);
		const last = rows[rows.length - 1];
		assert.equal(last.stage, "rejected");
		assert.ok(last.gate);
		assert.equal(last.gate?.testsFailed, 1);
		const events = await listHerEvents(fx.memoryDir, { kind: "selfmod.transition" });
		assert.ok(events.some((event) => event.actor === "selfmod" && event.data?.stage === "rejected"));
	} finally {
		await destroyFixture(fx);
	}
});

test("bare runSelfMod without test/eval runners rejects closed, no merge, no tag", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("bare");
	try {
		const result = await runSelfMod({
			hooks: {
				apply: async ({ worktreePath }) => applySkillLine(worktreePath),
				runTypecheck: async () => 0,
			},
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.outcome, "rejected");
		assert.equal(result.record.stage, "rejected");
		assert.equal(result.record.mergeCommit, undefined);
		const gate = result.record.gate;
		assert.ok(gate, "gate result must be present");
		assert.equal(typeof gate.typecheckExit, "number");
		assert.equal(typeof gate.testsPassed, "number");
		assert.equal(typeof gate.testsFailed, "number");
		assert.equal(typeof gate.evalGateFixturesPassed, "boolean");
		assert.equal(typeof gate.anchorScanClean, "boolean");
		assert.equal(typeof gate.encodingScanClean, "boolean");
		assert.ok(gate.testsFailed >= 1);
		assert.equal(gate.evalGateFixturesPassed, false);
		const events = await listHerEvents(fx.memoryDir, { kind: "selfmod.transition" });
		const rejected = events.find((event) => event.data?.stage === "rejected");
		assert.ok(rejected, "rejected transition must be in the event history");
		const evidence = JSON.stringify(rejected?.data ?? {});
		assert.match(evidence, /no test runner wired/);
		assert.match(evidence, /no selfmod-gate eval fixtures wired/);
		const tags = (await git(fx.repoRoot, "tag", "-l", `selfmod/${fx.id}`)).stdout.trim();
		assert.equal(tags, "");
	} finally {
		await destroyFixture(fx);
	}
});
