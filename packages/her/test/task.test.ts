import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initStore, readText } from "../src/her-core/index.ts";
import { createHerTask, listHerTasks, updateHerTask, verifyStep } from "../src/her-core/task.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-task-"));
	await initStore(root);
	return root;
}

test("Her tasks persist steps, block failed verification, recover, and move to done", async () => {
	const store = await tempStore();
	const created = await createHerTask(store, {
		id: "task-demo",
		objective: "Ship a three step task",
		now: "2026-06-13T10:00:00.000Z",
		steps: [
			{ id: "step-1", title: "Analyze", exitCriteria: ["context read"] },
			{ id: "step-2", title: "Write", exitCriteria: ["file exists", "choice model applied"] },
			{ id: "step-3", title: "Verify", exitCriteria: ["tests pass"] },
		],
	});

	assert.equal(created.status, "in_progress");
	assert.equal(created.path, "tasks/active/task-demo.md");

	const first = await updateHerTask(store, "task-demo", {
		stepId: "step-1",
		selfReview: "I read the existing task context before editing.",
		exitCriteriaResults: [{ criterion: "context read", passed: true }],
		checkpoint: "Context mapped.",
		now: "2026-06-13T10:05:00.000Z",
	});
	assert.equal(first.decision.verdict, "ALLOW");
	assert.equal(first.task.steps[1]?.status, "in_progress");

	const failed = await updateHerTask(store, "task-demo", {
		stepId: "step-2",
		selfReview: "I wrote the file but skipped the choice model check.",
		exitCriteriaResults: [
			{ criterion: "file exists", passed: true },
			{ criterion: "choice model applied", passed: false },
		],
		now: "2026-06-13T10:10:00.000Z",
	});
	assert.equal(failed.decision.rule, "exit-criterion-failed");
	assert.equal(failed.task.status, "blocked");
	assert.equal(failed.task.steps[1]?.retryCount, 1);

	const recovered = await updateHerTask(store, "task-demo", {
		stepId: "step-2",
		selfReview: "I fixed the skipped taste rule and checked the result.",
		exitCriteriaResults: [
			{ criterion: "file exists", passed: true },
			{ criterion: "choice model applied", passed: true },
		],
		checkpoint: "Writing step recovered.",
		now: "2026-06-13T10:15:00.000Z",
	});
	assert.equal(recovered.decision.verdict, "ALLOW");
	assert.equal(recovered.task.status, "in_progress");

	const done = await updateHerTask(store, "task-demo", {
		stepId: "step-3",
		selfReview: "I ran the focused tests and they passed.",
		exitCriteriaResults: [{ criterion: "tests pass", passed: true }],
		checkpoint: "All steps verified.",
		now: "2026-06-13T10:20:00.000Z",
	});
	assert.equal(done.task.status, "done");
	assert.equal(await readText(join(store, "tasks", "active", "task-demo.md")), undefined);
	assert.match((await readText(join(store, "tasks", "done", "task-demo.md"))) ?? "", /All steps verified/);

	const restored = await listHerTasks(store, "done");
	assert.deepEqual(
		restored.map((task) => [task.id, task.status, task.steps.map((step) => step.status).join(",")]),
		[["task-demo", "done", "done,done,done"]],
	);
});

test("verifyStep short-circuits authorize, budget, retries, then content", () => {
	assert.deepEqual(
		verifyStep({
			authorization: {
				verdict: "DENY",
				gate: "authorize",
				rule: "forbid_destructive_tool",
				reason: "cedar denied bash",
			},
			remainingTokens: 0,
			minimumTokens: 100,
			retryCount: 3,
			selfReview: "",
			exitCriteriaResults: [{ criterion: "done", passed: false }],
		}).rule,
		"forbid_destructive_tool",
	);
	assert.equal(
		verifyStep({ remainingTokens: 5, minimumTokens: 10, retryCount: 0, selfReview: "ok", exitCriteriaResults: [] })
			.rule,
		"budget-exceeded",
	);
	assert.equal(
		verifyStep({
			remainingTokens: 10,
			minimumTokens: 5,
			retryCount: 2,
			selfReview: "ok",
			exitCriteriaResults: [{ criterion: "done", passed: true }],
		}).rule,
		"retry-limit",
	);
	assert.equal(
		verifyStep({
			remainingTokens: 10,
			minimumTokens: 5,
			retryCount: 0,
			selfReview: "I checked it.",
			exitCriteriaResults: [{ criterion: "done", passed: false }],
		}).rule,
		"exit-criterion-failed",
	);
	assert.equal(
		verifyStep({
			remainingTokens: 10,
			minimumTokens: 5,
			retryCount: 0,
			selfReview: "I checked it.",
			exitCriteriaResults: [{ criterion: "done", passed: true }],
		}).verdict,
		"ALLOW",
	);
});
