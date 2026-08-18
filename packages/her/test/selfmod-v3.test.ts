import assert from "node:assert/strict";
import test from "node:test";
import { listHerEvents } from "../src/her-core/event-history.ts";
import { runSelfMod } from "../src/her-core/selfmod.ts";
import { destroyFixture, greenHooks, makeFixture, proposalFor } from "./selfmod-harness.ts";

test("V3: exploding typecheck is an evidenced reject, never a claimed merge", async () => {
	const fx = await makeFixture("v3");
	try {
		const boom = Object.assign(new Error("typecheck exploded: tsgo ENOENT"), { code: "ENOENT" });
		const result = await runSelfMod({
			hooks: {
				...greenHooks,
				runTypecheck: async () => {
					throw boom;
				},
			},
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.notEqual(result.record.stage, "merge");
		assert.equal(result.record.stage, "rejected");
		assert.equal(result.record.mergeCommit, undefined);
		const gate = result.record.gate;
		assert.ok(gate);
		assert.equal(typeof gate.typecheckExit, "number");
		assert.notEqual(gate.typecheckExit, 0);
		assert.equal(typeof gate.testsPassed, "number");
		assert.equal(typeof gate.testsFailed, "number");
		assert.equal(typeof gate.evalGateFixturesPassed, "boolean");
		assert.equal(typeof gate.anchorScanClean, "boolean");
		assert.equal(typeof gate.encodingScanClean, "boolean");
		const events = await listHerEvents(fx.memoryDir, { kind: "selfmod.transition" });
		const rejected = events.find((event) => event.data?.stage === "rejected");
		assert.ok(rejected, "rejected transition must be in the event history");
		assert.match(String(rejected?.data?.error ?? ""), /typecheck exploded|ENOENT|tsgo/i);
		assert.equal(result.outcome, "rejected");
	} finally {
		await destroyFixture(fx);
	}
});
