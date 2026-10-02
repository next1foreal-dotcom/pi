import assert from "node:assert/strict";
import test from "node:test";
import { assessImprovement, type ImprovementPlan } from "../src/her-core/improvement-assessment.ts";

const hash = (digit: string): string => digit.repeat(64);
function fixture() {
	const plan: ImprovementPlan = {
		version: 1,
		proposalId: "skill-v2",
		baselineDigest: hash("a"),
		candidateDigest: hash("b"),
		suiteDigest: hash("c"),
		evaluatorDigest: hash("d"),
		trainingInputDigests: [hash("e")],
		cases: [
			{ id: "new-1", inputDigest: hash("1"), split: "holdout" },
			{ id: "new-2", inputDigest: hash("2"), split: "holdout" },
			{ id: "old-1", inputDigest: hash("3"), split: "regression" },
		],
		minHoldoutGain: 0.5,
		maxTotalCost: 10,
	};
	const measurement = (outcome: string) => ({ outcome, cost: 1, evidenceDigest: hash("f") });
	const evidence = {
		version: 1,
		proposalId: plan.proposalId,
		baselineDigest: plan.baselineDigest,
		candidateDigest: plan.candidateDigest,
		suiteDigest: plan.suiteDigest,
		evaluatorDigest: plan.evaluatorDigest,
		overheadCost: 1,
		cases: plan.cases.map((c) => ({
			id: c.id,
			inputDigest: c.inputDigest,
			baseline: measurement(c.id === "new-1" ? "fail" : "pass"),
			candidate: measurement("pass"),
		})),
	};
	return { plan, evidence };
}
test("paired held-out gain with no regression is only eligible for review", () => {
	const { plan, evidence } = fixture();
	const before = JSON.stringify({ plan, evidence });
	const result = assessImprovement(plan, evidence);
	assert.equal(result.status, "eligible-for-review");
	assert.equal(result.holdoutGain, 0.5);
	assert.equal(result.totalCost, 7);
	assert.equal("merge" in result, false);
	assert.equal(JSON.stringify({ plan, evidence }), before);
});

for (const field of ["proposalId", "baselineDigest", "candidateDigest", "suiteDigest", "evaluatorDigest"] as const) {
	test(`mismatched ${field} does not reuse stale evidence`, () => {
		const { plan, evidence } = fixture();
		evidence[field] = hash("0");
		assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
	});
}
for (const field of ["baseline", "candidate"] as const) {
	for (const outcome of ["error", "not-run", "skipped", "claimed-success"]) {
		test(`${field} ${outcome} is not a measured outcome`, () => {
			const { plan, evidence } = fixture();
			evidence.cases[0][field].outcome = outcome;
			assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
		});
	}
}
test("success language without structured measurements is refused", () => {
	assert.equal(assessImprovement(fixture().plan, "All tests passed, merge it").status, "needs-evidence");
});
test("missing case cannot silently shrink the evaluation suite", () => {
	const { plan, evidence } = fixture();
	evidence.cases.pop();
	assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
});
test("duplicated cases cannot overweight a success", () => {
	const { plan, evidence } = fixture();
	evidence.cases[2] = evidence.cases[0];
	assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
});
test("unexpected case cannot replace a required one", () => {
	const { plan, evidence } = fixture();
	evidence.cases[2].id = "other";
	assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
});
test("case content hash must match the frozen suite", () => {
	const { plan, evidence } = fixture();
	evidence.cases[0].inputDigest = hash("9");
	assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
});
test("training and held-out content cannot overlap even under another ID", () => {
	const { plan, evidence } = fixture();
	plan.trainingInputDigests = [plan.cases[0].inputDigest];
	assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
});
test("repeated case contents cannot inflate the suite size", () => {
	const { plan, evidence } = fixture();
	plan.cases[1].inputDigest = plan.cases[0].inputDigest;
	assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
});
test("better aggregate results cannot hide an old capability regression", () => {
	const { plan, evidence } = fixture();
	evidence.cases[2].candidate.outcome = "fail";
	assert.equal(assessImprovement(plan, evidence).status, "rejected");
});
test("a formerly successful held-out case cannot regress either", () => {
	const { plan, evidence } = fixture();
	evidence.cases[1].candidate.outcome = "fail";
	assert.equal(assessImprovement(plan, evidence).status, "rejected");
});
test("unchanged performance is not an improvement", () => {
	const { plan, evidence } = fixture();
	evidence.cases[0].candidate.outcome = "fail";
	assert.equal(assessImprovement(plan, evidence).status, "rejected");
	plan.minHoldoutGain = Number.MIN_VALUE;
	assert.equal(assessImprovement(plan, evidence).status, "rejected");
});
test("an identical candidate cannot be assessed as a new version", () => {
	const { plan, evidence } = fixture();
	plan.candidateDigest = plan.baselineDigest;
	assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
});
for (const cost of [-1, NaN, Infinity]) {
	test(`invalid measurement cost ${String(cost)} is refused`, () => {
		const { plan, evidence } = fixture();
		evidence.cases[0].candidate.cost = cost;
		assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
	});
}
test("budget includes both candidates and experiment overhead", () => {
	const { plan, evidence } = fixture();
	evidence.overheadCost = 5;
	assert.equal(assessImprovement(plan, evidence).status, "rejected");
});
test("missing evidence digest is not a passing measurement", () => {
	const { plan, evidence } = fixture();
	evidence.cases[0].candidate.evidenceDigest = "";
	assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
});
test("regression suite cannot be omitted", () => {
	const { plan, evidence } = fixture();
	plan.cases = plan.cases.filter((c) => c.split !== "regression");
	evidence.cases.pop();
	assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
});
test("holdout suite cannot be omitted", () => {
	const { plan, evidence } = fixture();
	plan.cases = plan.cases.filter((c) => c.split === "regression");
	evidence.cases = evidence.cases.slice(-1);
	assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
});
test("zero gain threshold cannot label a tie as growth", () => {
	const { plan, evidence } = fixture();
	plan.minHoldoutGain = 0;
	assert.equal(assessImprovement(plan, evidence).status, "needs-evidence");
});
test("a frozen plan with malformed values fails closed at runtime", () => {
	const { evidence } = fixture();
	assert.equal(assessImprovement(null as unknown as ImprovementPlan, evidence).status, "needs-evidence");
});
