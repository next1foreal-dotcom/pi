import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { growthExitCode, runGrowthCli } from "../src/growth-experiment/cli.ts";
import { GrowthJournal } from "../src/growth-experiment/journal.ts";
import { runGrowthTask } from "../src/growth-experiment/task.ts";
import { startDrain } from "../src/her-core/drain.ts";
import { sha256 } from "../src/her-core/improvement-plan.ts";
import { fixture, original } from "./fixtures/growth-task-host.ts";

test("control and no-method task deliberation have separate once-only slots", async (t) => {
	const { host, model } = await fixture(t);
	await host.runBaseline("final", true);
	const result = await host.runBaseline("final", true, undefined, { condition: "task" });
	assert.equal(result.outcome, "success");
	assert.equal(model.calls.length, 4);
	await assert.rejects(host.runBaseline("final", false, undefined, { condition: "task" }), /already consumed/);
	assert.equal(model.calls.length, 4);
});

for (const mode of ["use", "decline", "host-block"] as const) {
	test(`ordinary task retrieves without method argument and distinguishes ${mode}`, async (t) => {
		const { host, model } = await fixture(t, mode === "host-block" ? "use" : mode);
		const taskId = mode === "host-block" ? "boundary" : "final";
		await host.runBaseline(taskId, true);
		const before = model.calls.length;
		const result = await runGrowthTask(host, taskId);
		assert.equal(result.status, "task-observed", result.reason);
		assert.equal(
			result.mode,
			mode === "use" ? "method-used" : mode === "decline" ? "model-declined" : "host-blocked",
		);
		assert.equal(result.observation?.outcome, "success");
		assert.deepEqual(result.retrievedMethodIds, [sha256("fixture method")]);
		assert.equal(result.usage.requests, 2);
		assert.equal(result.usage.tokens, 60);
		assert.equal(model.calls.length - before, 2);
		assert.equal(growthExitCode(result), 0);
		await assert.rejects(runGrowthTask(host, taskId), /already consumed/);
		assert.equal(model.calls.length - before, 2);
		const rows = await host.journal.read();
		assert.equal(rows.filter((r) => r.kind === "ordinary-task-result").length, 1);
		if (mode !== "use") assert.ok(!rows.some((r) => r.kind === "use-result"));
		assert.ok(model.calls.every((c) => !c.prompt.includes('"expected"')));
		await assert.rejects(host.reason({ stage: "discover", instruction: "fixture", data: {} }), /final tasks exposed/);
	});
}
test("suspended local method is not reactivated; foreign active method is not granted", async (t) => {
	const { host, model, root } = await fixture(t);
	const state = (await host.journal.state())!;
	await new GrowthJournal(root, "foreign").save({ ...state, id: "foreign" }, -1);
	await host.save(
		{ ...state, revision: state.revision + 1, phase: "suspended", method: { ...state.method!, status: "suspended" } },
		state.revision,
	);
	const result = await runGrowthTask(host, "final");
	assert.equal(result.mode, "no-active-method");
	assert.equal(result.status, "task-observed");
	assert.deepEqual(result.retrievedMethodIds, []);
	assert.equal(model.calls.length, 2);
	assert.equal((await host.journal.state())!.method!.status, "suspended");
	assert.ok(model.calls.every((c) => !c.prompt.includes('"availableMethod"')));
});
test("failed method use preserves suspension and cannot spend a fallback or replay", async (t) => {
	const { host, model } = await fixture(t, "wrong");
	const result = await runGrowthTask(host, "final");
	assert.equal(result.status, "task-observed");
	assert.equal(result.mode, "method-used");
	assert.equal(result.observation?.outcome, "failure");
	assert.equal((await host.journal.state())!.phase, "suspended");
	assert.equal(model.calls.length, 2);
	assert.ok(!(await host.journal.read()).some((r) => r.kind === "baseline-reserved"));
	await assert.rejects(runGrowthTask(host, "final"), /already consumed/);
});
for (const mode of ["bad-selection", "unknown-usage"] as const) {
	test(`ordinary task ${mode} is interrupted without automatic fallback`, async (t) => {
		const { host, model } = await fixture(t, mode);
		if (mode === "unknown-usage")
			model.completeWithMeta = (prompt) => {
				model.calls.push({ prompt, strong: false });
				return { text: "{}", finishReason: "stop" };
			};
		const result = await runGrowthTask(host, "final");
		assert.equal(result.status, "task-failed");
		assert.equal(growthExitCode(result), 1);
		assert.equal(result.mode, "interrupted");
		assert.equal(result.usage.requests, 1);
		assert.equal(result.usage.tokens, mode === "unknown-usage" ? null : 30);
		assert.equal(model.calls.length, 1);
		assert.ok(
			!(await host.journal.read()).some((r) => r.kind === "baseline-reserved" || r.kind === "execution-intent"),
		);
		await assert.rejects(runGrowthTask(host, "final"));
		assert.equal(model.calls.length, 1);
	});
}
test("STOP prevents task reservation and call; malformed gate is never recalled as eligible", async (t) => {
	const { host, root, model } = await fixture(t);
	const state = (await host.journal.state())!;
	await host.save(
		{
			...state,
			revision: state.revision + 1,
			method: { ...state.method!, review: { ...state.method!.review!, planDigest: "wrong" } },
		},
		state.revision,
	);
	const result = await runGrowthTask(host, "final");
	assert.equal(result.status, "task-failed");
	assert.match(result.reason!, /matching independent gate/);
	assert.equal(model.calls.length, 0);
	await startDrain({ memoryDir: root, reason: "fixture STOP" });
	await assert.rejects(runGrowthTask(host, "boundary"), /STOP/);
	assert.equal((await host.journal.read()).filter((r) => r.kind === "ordinary-task-reserved").length, 1);
});
test("common observations and one source-blind reflection reach both conditions equally", async (t) => {
	const { host, model } = await fixture(t, "decline");
	const state = (await host.journal.state())!;
	await host.save(
		{
			...state,
			revision: state.revision + 1,
			probes: [
				{
					plan: { purpose: "fixture", action: "{}", predictions: [] },
					observation: {
						runId: "probe",
						outcome: "success",
						summary: "shared observation marker",
						evidence: original.evidence,
					},
				},
			],
		},
		state.revision,
	);
	await host.reflect();
	await host.runBaseline("final", true);
	const result = await runGrowthTask(host, "final");
	assert.equal(result.usage.requests, 2);
	assert.ok(model.calls.every((c) => c.prompt.includes("shared observation marker")));
	assert.ok(model.calls.slice(1).every((c) => c.prompt.includes('"reflection"')));
	assert.ok(model.calls.slice(1, 3).every((c) => !c.prompt.includes('"availableMethod"')));
	assert.ok(!model.calls[0].prompt.includes('"availableMethod"'));
});
test("formal growth task CLI reaches configured adapter over loopback, with no operator method argument", async (t) => {
	let requests = 0;
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		requests++;
		const prompt = body.messages[0].content as string;
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify({
				model: "deepseek-v4-flash",
				id: `local-${requests}`,
				choices: [
					{
						finish_reason: "stop",
						message: {
							content: prompt.includes("Untrusted input as JSON:")
								? '{"decision":"use","reason":"fixture","adaptation":["fixture adaptation"]}'
								: '{"ok":true}',
						},
					},
				],
				usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
			}),
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const { root } = await fixture(t, "use", `127.0.0.1:${address.port}`);
	const result = (await runGrowthCli(["task", root, "evals/plan.json", "final"], {
		TEST_TASK_KEY: "loopback-fixture-only",
	})) as { status: string; mode: string };
	assert.equal(result.status, "task-observed");
	assert.equal(result.mode, "method-used");
	assert.equal(requests, 2);
	await assert.rejects(
		runGrowthCli(["task", root, "evals/plan.json", "final"], { TEST_TASK_KEY: "loopback-fixture-only" }),
	);
	assert.equal(requests, 2);
});

test("interrupted review and consumed task reservation cannot become an independent retry", async (t) => {
	const { host, model } = await fixture(t);
	const state = (await host.journal.state())!;
	await host.save({ ...state, revision: state.revision + 1, phase: "pending-review" }, state.revision);
	await assert.rejects(runGrowthTask(host, "final"), /completed learning/);
	assert.equal(model.calls.length, 0);
	const pending = (await host.journal.state())!;
	await host.save({ ...state, revision: pending.revision + 1 }, pending.revision);
	await host.journal.append("ordinary-task-reserved", { taskId: "final", planDigest: host.planDigest });
	await assert.rejects(runGrowthTask(host, "final"), /already consumed/);
	assert.equal(model.calls.length, 0);
});
