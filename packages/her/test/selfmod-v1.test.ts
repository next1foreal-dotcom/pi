import assert from "node:assert/strict";
import test from "node:test";
import { listHerEvents } from "../src/her-core/event-history.ts";
import { readSelfmodRecords, runSelfMod } from "../src/her-core/selfmod.ts";
import { destroyFixture, greenHooks, makeFixture, proposalFor } from "./selfmod-harness.ts";

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
