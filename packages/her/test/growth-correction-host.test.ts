import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type GrowthHostPlan, HerGrowthHost } from "../src/growth-experiment/host.ts";
import { advance, reopen, startInquiry, tryMethod } from "../src/growth-experiment/loop.ts";
import type { GrowthState, Method, UseObservation } from "../src/growth-experiment/types.ts";
import { sha256 } from "../src/her-core/improvement-plan.ts";
import { FakeModel } from "../src/her-core/model.ts";

// All replies/methods below are fixtures. Actual journals/executors test wiring, never autonomous learning.
const old = {
	id: "old",
	taskId: "old-task",
	expectation: "raw original task",
	observation: "original failure",
	evidence: [
		{
			ref: "old-artifact",
			digest: sha256("original failure"),
			origin: "environment" as const,
			summary: "original failure",
		},
	],
};
function method(version = "v1"): Method {
	const draft = {
		name: version,
		problem: "fixture",
		preconditions: ["fixture"],
		steps: [version],
		stopWhen: ["unknown"],
		counterexamples: ["fixture"],
		sourceEvidenceRefs: ["old-artifact"],
	};
	return { id: sha256(JSON.stringify(draft)), draft, status: "candidate" };
}
async function fixture(t: test.TestContext, configure?: (plan: GrowthHostPlan) => void) {
	const root = await mkdtemp(join(tmpdir(), "her-growth-correction-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source =
		'import {readFileSync} from "node:fs";const r=JSON.parse(readFileSync(0,"utf8"));console.log(JSON.stringify({value:r.answer??r,met:true}));';
	await mkdir(join(root, "evals"));
	await writeFile(join(root, "evals/op.mjs"), source);
	const task = (id: string) => ({
		id,
		description: `isolated task ${id}`,
		environment: "text",
		input: { marker: id },
		expected: { ok: true },
	});
	const plan: GrowthHostPlan = {
		version: 1,
		inquiryId: "inquiry",
		approvedBy: "offline engineering fixture",
		expiresAt: new Date(Date.now() + 120000).toISOString(),
		model: {
			request: "deepseek-v4-flash",
			reported: ["deepseek-v4-flash"],
			provider: "api.deepseek.com",
			maxOutputTokens: 128,
			inputUsdPerMillion: 0.3,
			outputUsdPerMillion: 1.2,
			requestOptions: { requireComplete: true },
		},
		budget: { tokens: 100000, usd: 1, wallMs: 120000, processMs: 10000, outputBytes: 65536, requests: 32 },
		operations: {
			observe: {
				file: "evals/op.mjs",
				sha256: sha256(source),
				purposes: ["probe", "applicability", "use", "review"],
			},
		},
		applicabilityOperation: "observe",
		useOperation: "observe",
		reviewOperation: "observe",
		tasks: [task("development"), task("final")],
		review: {
			minGain: 0.5,
			cases: [
				{ ...task("holdout-v1"), split: "holdout" },
				{ ...task("regression-v1"), split: "regression" },
			],
		},
		correction: {
			developmentTaskIds: ["development"],
			review: {
				minGain: 0.5,
				cases: [
					{ ...task("holdout-v2"), split: "holdout" },
					{ ...task("regression-v2"), split: "regression" },
				],
			},
		},
	};
	configure?.(plan);
	await writeFile(join(root, "evals/plan.json"), JSON.stringify(plan));
	const model = new FakeModel("{}", false, {
		model: plan.model.request,
		provider: plan.model.provider,
		finishReason: "stop",
		usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
	});
	model.completeWithMeta = (prompt, options) => {
		model.calls.push({ prompt, maxTokens: options?.maxTokens, strong: false });
		assert.equal(options?.singleRequest, true);
		const selecting = prompt.includes("Untrusted input as JSON:");
		const data = selecting ? undefined : JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
		const text = selecting
			? JSON.stringify({ decision: "use", reason: "fixture", adaptation: ["fixture"] })
			: JSON.stringify({
					ok:
						data.task.id.startsWith("regression") ||
						(data.availableMethod && data.task.id !== "development") ||
						data.availableMethod?.name === "v2",
				});
		return {
			text,
			model: plan.model.request,
			provider: plan.model.provider,
			finishReason: "stop",
			usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
		};
	};
	const host = await HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model);
	const initial = startInquiry("inquiry", [old], { thoughts: 12, probes: 2 });
	await host.save({ ...initial, phase: "candidate", method: method() }, -1);
	return { root, plan, model, host };
}
async function developmentFailure(host: HerGrowthHost) {
	let state = await advance((await host.journal.state())!, host);
	assert.equal(state.phase, "trial-ready", state.note);
	const task = host.plan.tasks[0];
	state = await tryMethod(state, { id: task.id, description: task.description, environment: task.environment }, host);
	assert.equal(state.phase, "suspended", state.note);
	const observed = state.trials.at(-1)!.observation as UseObservation;
	assert.equal(observed.outcome, "failure");
	for (const e of observed.evidence) assert.equal(sha256(await readFile(join(host.journal.root, e.ref))), e.digest);
	return {
		state,
		observed,
		fresh: {
			id: `development-${observed.runId}`,
			taskId: task.id,
			expectation: task.description,
			observation: observed.summary,
			evidence: observed.evidence,
		},
	};
}
async function secondCandidate(host: HerGrowthHost, state: GrowthState, fresh: Parameters<typeof reopen>[1]) {
	const reopened = await reopen(state, fresh, host);
	const revised = method("v2");
	revised.draft.sourceEvidenceRefs.push(fresh[0].evidence[0].ref);
	revised.id = sha256(JSON.stringify(revised.draft));
	await host.save(
		{ ...reopened, revision: reopened.revision + 1, phase: "candidate", method: revised },
		reopened.revision,
	);
	return (await host.journal.state())!;
}

test("real development failure enables exactly one new sealed review with cumulative usage across restart", async (t) => {
	const { host, model, root } = await fixture(t);
	const { state, fresh } = await developmentFailure(host);
	const candidate = await secondCandidate(host, state, [fresh]);
	const restarted = await HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model);
	const result = await advance(candidate, restarted);
	assert.equal(result.phase, "trial-ready", result.note);
	assert.deepEqual(result.method!.review!.heldOutTaskIds, ["holdout-v2", "regression-v2"]);
	const rows = await host.journal.read();
	assert.equal(rows.filter((r) => r.kind === "review-reserved").length, 2);
	assert.equal(rows.filter((r) => r.kind === "model-reserve").length, 10);
	assert.equal(
		rows.filter((r) => r.kind === "model-result").reduce((sum, r) => sum + Number(r.data.tokens), 0),
		300,
	);
	assert.deepEqual(result.spent, state.spent);
	assert.equal(result.retired.length, 1);
	assert.ok(model.calls.every((c) => !c.prompt.includes('"expected"')));
	const pending = { ...result, revision: result.revision + 1, phase: "pending-review" as const };
	await host.save(pending, result.revision);
	const count = model.calls.length;
	await assert.rejects(host.review(pending.method!, ["old-task"]), /already consumed/);
	assert.equal(model.calls.length, count);
});

for (const mode of ["no-fresh", "identical-draft", "final-exposed"] as const) {
	test(`correction ${mode} cannot consume another suite or spend on learning`, async (t) => {
		const { host, model } = await fixture(t);
		const { state, fresh } = await developmentFailure(host);
		let candidate = await secondCandidate(
			host,
			state,
			mode === "no-fresh" ? [{ ...old, id: "unrelated", taskId: "unrelated" }] : [fresh],
		);
		if (mode === "identical-draft") {
			candidate = {
				...candidate,
				revision: candidate.revision + 1,
				method: { ...method(), id: sha256("forged-new-id") },
			};
			await host.save(candidate, candidate.revision - 1);
		}
		if (mode === "final-exposed")
			await host.journal.append("baseline-reserved", { taskId: "final", deliberate: true });
		const before = model.calls.length;
		if (mode === "final-exposed")
			await assert.rejects(host.reason({ stage: "discover", instruction: "JSON", data: {} }), /final.*exposed/);
		const result = await advance(candidate, host);
		assert.equal(result.phase, "pending-review");
		assert.match(result.note, /fresh|changed|final.*exposed/);
		assert.equal(model.calls.length, before);
		assert.equal((await host.journal.read()).filter((r) => r.kind === "review-reserved").length, 1);
	});
}

for (const mode of ["duplicate-input", "missing-regression", "unknown-development", "lowered-threshold"] as const) {
	test(`invalid frozen correction plan ${mode} is rejected before journal/model`, async (t) => {
		let calls = 0;
		await assert.rejects(
			fixture(t, (plan) => {
				calls++;
				if (mode === "duplicate-input") plan.correction!.review.cases[0].input = plan.tasks[1].input;
				if (mode === "missing-regression")
					plan.correction!.review.cases = plan.correction!.review.cases.slice(0, 1);
				if (mode === "unknown-development") plan.correction!.developmentTaskIds = ["not-approved"];
				if (mode === "lowered-threshold") plan.correction!.review.minGain = 0.1;
			}),
			/duplicate|held-out|development|threshold/,
		);
		assert.equal(calls, 1);
	});
}

test("fresh correction holdout is sealed against direct and batched probes before method formation", async (t) => {
	const { host, plan } = await fixture(t);
	for (const input of [plan.correction!.review.cases[0].input, { cases: [plan.correction!.review.cases[1].input] }]) {
		assert.equal(
			await host.authorizeProbe({
				runId: "sealed",
				inquiryId: plan.inquiryId,
				probe: { purpose: "fixture", predictions: [], action: JSON.stringify({ operationId: "observe", input }) },
			}),
			false,
		);
	}
	assert.ok(!(await host.journal.read()).some((r) => r.kind === "grant"));
});

for (const invalid of ["null", "[]", "true"]) {
	test(`invalid task answer ${invalid} never reaches evaluator; real receipt stays charged`, async (t) => {
		const { host, model } = await fixture(t);
		model.completeWithMeta = () => ({
			text: invalid,
			model: host.plan.model.request,
			provider: host.plan.model.provider,
			finishReason: "stop",
			usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
		});
		await assert.rejects(host.runBaseline("final", false), /task answer must be an object/);
		const rows = await host.journal.read();
		assert.equal(rows.filter((r) => r.kind === "model-result").length, 1);
		assert.ok(!rows.some((r) => r.kind === "execution-intent" || r.kind === "baseline-result"));
	});
}

test("second review shares request cap and cannot reset spent usage", async (t) => {
	const { host, model } = await fixture(t, (plan) => {
		plan.budget.requests = 6;
	});
	const { state, fresh } = await developmentFailure(host);
	const candidate = await secondCandidate(host, state, [fresh]);
	const before = model.calls.length;
	const result = await advance(candidate, host);
	assert.equal(result.phase, "pending-review");
	assert.match(result.note, /request budget/);
	assert.equal(model.calls.length, before);
	assert.equal((await host.journal.read()).filter((r) => r.kind === "model-reserve").length, 6);
});
test("final selection seals research even when no trial result exists; failed selection cannot replay", async (t) => {
	const { host, model } = await fixture(t);
	const task = host.plan.tasks.find((t) => t.id === "final")!;
	const request = {
		stage: "select" as const,
		instruction: "fixture",
		data: { task: { id: task.id, description: task.description, environment: task.environment } },
	};
	await host.reason(request);
	assert.equal((await host.journal.state())!.trials.length, 0);
	const calls = model.calls.length;
	await assert.rejects(host.reason({ stage: "discover", instruction: "fixture", data: {} }), /final.*exposed/);
	await assert.rejects(host.reason(request), /already consumed/);
	assert.equal(model.calls.length, calls);
});

for (const gate of ["unknown", "stop", "artifact-changed"] as const) {
	test(`correction ${gate} preserves reconciliation and cannot spend another request`, async (t) => {
		const { host, model } = await fixture(t);
		const { state, fresh } = await developmentFailure(host);
		const candidate = await secondCandidate(host, state, [fresh]);
		if (gate === "unknown") await host.journal.append("model-reserve", { runId: "unreconciled-new" });
		if (gate === "stop") await host.journal.append("pilot-stop", { reason: "fixture STOP" });
		if (gate === "artifact-changed") await writeFile(join(host.journal.root, fresh.evidence[0].ref), "changed");
		const calls = model.calls.length;
		const result = await advance(candidate, host);
		assert.equal(result.phase, "pending-review");
		assert.match(result.note, /unreconciled|stopped|artifact changed/);
		assert.equal(model.calls.length, calls);
	});
}
