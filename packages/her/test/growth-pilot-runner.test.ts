import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runGrowthPilot } from "../src/growth-experiment/pilot.ts";
import { CompletionResponseError } from "../src/her-core/model.ts";
import { fixture } from "./fixtures/growth-task-host.ts";

// Preset decisions/methods are protocol fixtures. Real journal, process, gate and budget tests do not prove learning.
async function pilotFixture(t: test.TestContext, scenario = "promising") {
	const { host, model } = await fixture(
		t,
		"use",
		undefined,
		(plan) => {
			const task = (id: string) => ({
				id,
				description: `sealed task ${id}`,
				environment: "text",
				input: { marker: id },
				expected: { ok: true },
			});
			plan.tasks = [task("T1"), task("T2"), task("T3"), task("T4"), task("development")];
			plan.pilot = {
				finalTaskIds: ["T1", "T2", "T3", "T4"],
				developmentTaskId: "development",
				thoughts: 12,
				probes: 2,
			};
		},
		true,
	);
	let paidAttempts = 0;
	model.completeWithMeta = (prompt, options) => {
		paidAttempts++;
		model.calls.push({ prompt, strong: false, maxTokens: options?.maxTokens });
		assert.equal(options?.singleRequest, true);
		if (scenario === "unknown") return { text: "{}", finishReason: "stop" };
		const selecting = prompt.includes("Choose an approach to the new task");
		if (scenario === "provider-failure" && selecting)
			throw new CompletionResponseError("empty_content", {
				model: host.plan.model.request,
				provider: host.plan.model.provider,
				finishReason: "stop",
				usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
			});
		const reasoning = prompt.includes("Untrusted input as JSON:");
		const data = JSON.parse(
			reasoning ? prompt.split("Untrusted input as JSON:\n")[1] : prompt.slice(prompt.indexOf("\n") + 1),
		);
		let reply: unknown;
		if (prompt.includes("Compare expectations with observations"))
			reply = {
				decision: "investigate",
				question: {
					problem: "fixture gap",
					hypotheses: [
						{ id: "a", explanation: "fixture A" },
						{ id: "b", explanation: "fixture B" },
					],
					wakeWhen: "fresh observation",
				},
			};
		else if (prompt.includes("Use the existing question")) {
			reply = !data.probes.length
				? {
						decision: "probe",
						probe: {
							purpose: "fixture distinguish",
							action: JSON.stringify({ operationId: "observe", input: { marker: "nonsealed-probe" } }),
							predictions: [
								{ hypothesisId: "a", outcome: "one" },
								{ hypothesisId: "b", outcome: "two" },
							],
						},
					}
				: {
						decision: "method",
						method: {
							name: data.experiences.length > 1 ? "revised fixture" : "original fixture",
							problem: "fixture gap",
							preconditions: ["text"],
							steps: [data.experiences.length > 1 ? "changed fixture" : "fixture"],
							stopWhen: ["unknown"],
							counterexamples: ["binary"],
							sourceEvidenceRefs: [data.experiences.at(-1).evidence[0].ref],
						},
					};
		} else if (selecting) reply = { decision: "use", reason: "fixture fit", adaptation: ["fixture adaptation"] };
		else if (prompt.startsWith("Summarize"))
			reply = { observations: ["shared fixture observation"], uncertainties: ["fixture uncertainty"] };
		else if (prompt.startsWith("Choose an approach to this task"))
			reply = { approach: "fixture raw approach", limitations: ["fixture"] };
		else {
			const method = data.availableMethod;
			const taskId = data.task.id as string;
			let ok = true;
			if (taskId.startsWith("holdout")) ok = scenario === "review-rejected" || !!method;
			else if (taskId === "development") ok = scenario !== "correction" || method?.name === "revised fixture";
			else if (taskId.startsWith("T")) ok = scenario === "no-gain" || !!method;
			if (scenario === "final-suspension" && taskId === "T1" && method) ok = false;
			reply = { ok };
		}
		return {
			text: JSON.stringify(reply),
			model: host.plan.model.request,
			provider: host.plan.model.provider,
			finishReason: "stop",
			usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
		};
	};
	return { host, model, attempts: () => paidAttempts };
}

test("continuous runner uses real gate, one development task, blind reflection and eight fixed paired conditions", async (t) => {
	const { host, model, attempts } = await pilotFixture(t);
	const result = await runGrowthPilot(host);
	assert.equal(result.status, "PROMISING-PILOT", result.reason);
	assert.equal(result.correction, "not-needed");
	assert.deepEqual(
		result.rows.map((r) => `${r.taskId}/${r.condition}`),
		["T1/A", "T1/B", "T2/B", "T2/A", "T3/B", "T3/A", "T4/A", "T4/B"],
	);
	assert.equal(result.rows.length, 8);
	assert.ok(result.rows.every((r) => r.status === "observed" && r.usage?.requests === 2 && r.usage.tokens === 60));
	assert.equal(result.usage.requests, 26);
	assert.equal(result.usage.tokens, 26 * 30);
	assert.equal(attempts(), 26);
	assert.equal((await host.journal.state())!.spent.probes, 1);
	assert.ok(model.calls.every((c) => !c.prompt.includes('"expected"')));
	const rows = await host.journal.read();
	assert.equal(rows.filter((r) => r.kind === "common-reflection").length, 1);
	assert.equal(rows.filter((r) => r.kind === "review-reserved").length, 1);
	await assert.rejects(runGrowthPilot(host), /stopped/);
	assert.equal(attempts(), 26);
});
test("actual development failure reopens without resetting probes/budget and uses a fresh gate once", async (t) => {
	const { host, attempts } = await pilotFixture(t, "correction");
	const result = await runGrowthPilot(host);
	assert.equal(result.status, "PROMISING-PILOT", result.reason);
	assert.equal(result.correction, "revised");
	assert.equal(result.development?.observation?.outcome, "failure");
	assert.equal(result.usage.requests, 32);
	assert.equal(attempts(), 32);
	const state = (await host.journal.state())!;
	assert.equal(state.retired.length, 1);
	assert.equal(state.spent.probes, 1);
	assert.equal(state.experiences.length, 2);
	assert.equal((await host.journal.read()).filter((r) => r.kind === "review-reserved").length, 2);
	assert.ok(result.rows.every((r) => r.status === "observed"));
});
test("rejected independent gate leaves all eight missing conditions and does not force method use", async (t) => {
	const { host, attempts } = await pilotFixture(t, "review-rejected");
	const result = await runGrowthPilot(host);
	assert.equal(result.status, "REVIEW-REJECTED", result.reason);
	assert.equal(result.rows.length, 8);
	assert.ok(result.rows.every((r) => r.status === "missing" && r.usage === null && r.observation === null));
	assert.equal(result.development, null);
	assert.equal(attempts(), 7);
});
test("final failure suspends method and keeps all later B conditions missing while A continues safely", async (t) => {
	const { host } = await pilotFixture(t, "final-suspension");
	const result = await runGrowthPilot(host);
	assert.equal(result.status, "INCOMPLETE");
	assert.equal(result.rows[1].observation?.outcome, "failure");
	assert.equal(result.rows.filter((r) => r.condition === "A" && r.status === "observed").length, 4);
	assert.equal(result.rows.filter((r) => r.condition === "B" && r.status === "missing" && r.usage === null).length, 3);
	assert.equal(result.rows.length, 8);
	assert.equal((await host.journal.state())!.phase, "suspended");
	assert.equal((await host.journal.read()).filter((r) => r.kind === "pilot-development-wake").length, 0);
});
for (const scenario of ["unknown", "provider-failure", "no-gain"] as const) {
	test(`pilot ${scenario} keeps measured usage/denominator and stops without retry`, async (t) => {
		const { host, attempts } = await pilotFixture(t, scenario);
		const result = await runGrowthPilot(host);
		assert.equal(result.status, scenario === "no-gain" ? "NO-OBSERVED-GAIN" : "INCOMPLETE", result.reason);
		assert.equal(result.rows.length, 8);
		assert.equal(result.usage.requests, attempts());
		assert.equal(result.usage.tokens, scenario === "unknown" ? null : attempts() * 30);
		if (scenario !== "no-gain") assert.ok(result.rows.every((r) => r.status === "missing" && r.usage === null));
		const before = attempts();
		await assert.rejects(runGrowthPilot(host), /stopped/);
		assert.equal(attempts(), before);
	});
}

for (const block of [
	"old-contract",
	"interrupted-run",
	"changed-probe-budget",
	"historical-spend",
	"changed-artifact",
] as const) {
	test(`pilot ${block} rejects before a supplier call without freshening history`, async (t) => {
		const { host, model } = await fixture(
			t,
			"use",
			undefined,
			(plan) => {
				const task = (id: string) => ({
					id,
					description: id,
					environment: "text",
					input: { marker: id },
					expected: { ok: true },
				});
				plan.tasks = [task("T1"), task("T2"), task("T3"), task("T4"), task("development")];
				if (block !== "old-contract")
					plan.pilot = {
						finalTaskIds: ["T1", "T2", "T3", "T4"],
						developmentTaskId: "development",
						thoughts: 12,
						probes: 2,
					};
			},
			true,
		);
		if (block === "interrupted-run") await host.journal.append("pilot-run-reserved", { planDigest: host.planDigest });
		if (block === "historical-spend") await host.journal.append("model-reserve", { runId: "unreconciled" });
		if (block === "changed-probe-budget") {
			const state = (await host.journal.state())!;
			await host.save({ ...state, revision: 1, limits: { thoughts: 12, probes: 3 } }, 0);
		}
		if (block === "changed-artifact") await writeFile(join(host.journal.root, "old.txt"), "changed");
		await assert.rejects(runGrowthPilot(host), /contract|revision zero|artifact mismatch|unreconciled/);
		assert.equal(model.calls.length, 0);
		assert.ok(!(await host.journal.read()).some((r) => r.kind === "pilot-stop"));
	});
}
