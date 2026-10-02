/**
 * Offline paired evidence assessment. The plan is owned and frozen by the host
 * BEFORE experimentation. Evidence must be supplied by an independent runner.
 * Matching digests bind records; they do NOT authenticate a runner, prove that
 * an artifact exists, or prove that held-out inputs were never exposed.
 * This function never executes, persists, merges, or grants permission.
 */
export interface ImprovementCase {
	id: string;
	inputDigest: string;
	split: "holdout" | "regression";
}

export interface ImprovementPlan {
	version: 1;
	proposalId: string;
	baselineDigest: string;
	candidateDigest: string;
	suiteDigest: string;
	evaluatorDigest: string;
	trainingInputDigests: string[];
	cases: ImprovementCase[];
	minHoldoutGain: number;
	maxTotalCost: number;
}

export interface ImprovementAssessment {
	status: "eligible-for-review" | "rejected" | "needs-evidence";
	reasons: string[];
	holdoutGain?: number;
	totalCost?: number;
}

type Measurement = { outcome: "pass" | "fail"; cost: number; evidenceDigest: string };
type Pair = { id: string; inputDigest: string; baseline: Measurement; candidate: Measurement };

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an evidence record");
	return value as Record<string, unknown>;
}

function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("missing or invalid SHA-256 digest");
	return value;
}

function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value))
		throw new Error("invalid evidence identifier");
	return value;
}

function cost(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid measured cost");
	return value;
}

function measurement(value: unknown): Measurement {
	const row = record(value);
	if (row.outcome !== "pass" && row.outcome !== "fail") throw new Error("a required evaluation did not finish");
	return { outcome: row.outcome, cost: cost(row.cost), evidenceDigest: digest(row.evidenceDigest) };
}

function validatePlan(plan: ImprovementPlan): void {
	record(plan);
	if (plan.version !== 1) throw new Error("unsupported plan version");
	identifier(plan.proposalId);
	for (const key of ["baselineDigest", "candidateDigest", "suiteDigest", "evaluatorDigest"] as const)
		digest(plan[key]);
	if (plan.baselineDigest === plan.candidateDigest) throw new Error("candidate must differ from baseline");
	cost(plan.maxTotalCost);
	if (!Number.isFinite(plan.minHoldoutGain) || plan.minHoldoutGain <= 0 || plan.minHoldoutGain > 1) {
		throw new Error("positive held-out gain threshold required");
	}
	if (!Array.isArray(plan.trainingInputDigests) || !Array.isArray(plan.cases)) throw new Error("invalid plan arrays");
	const training = new Set(plan.trainingInputDigests.map(digest));
	const ids = new Set<string>();
	const inputs = new Set<string>();
	let heldout = 0;
	let regression = 0;
	for (const item of plan.cases) {
		record(item);
		const id = identifier(item.id);
		const input = digest(item.inputDigest);
		if (ids.has(id) || inputs.has(input)) throw new Error("duplicate evaluation case");
		if (training.has(input)) throw new Error("training and evaluation inputs overlap");
		if (item.split === "holdout") heldout++;
		else if (item.split === "regression") regression++;
		else throw new Error("unknown evaluation split");
		ids.add(id);
		inputs.add(input);
	}
	if (heldout === 0 || regression === 0) throw new Error("both held-out and regression cases are required");
}

function readEvidence(plan: ImprovementPlan, raw: unknown): { pairs: Pair[]; overhead: number } {
	const data = record(raw);
	if (data.version !== 1) throw new Error("unsupported evidence version");
	for (const key of ["proposalId", "baselineDigest", "candidateDigest", "suiteDigest", "evaluatorDigest"] as const) {
		if (data[key] !== plan[key]) throw new Error(`evidence is bound to a different ${key}`);
	}
	if (!Array.isArray(data.cases) || data.cases.length !== plan.cases.length)
		throw new Error("incomplete evaluation suite");
	const expected = new Map(plan.cases.map((item) => [item.id, item]));
	const seen = new Set<string>();
	const pairs: Pair[] = [];
	for (const item of data.cases) {
		const row = record(item);
		const id = identifier(row.id);
		const spec = expected.get(id);
		if (!spec || seen.has(id)) throw new Error("unexpected or duplicate evidence case");
		if (row.inputDigest !== spec.inputDigest) throw new Error("case contents do not match the frozen suite");
		seen.add(id);
		pairs.push({
			id,
			inputDigest: spec.inputDigest,
			baseline: measurement(row.baseline),
			candidate: measurement(row.candidate),
		});
	}
	return { pairs, overhead: cost(data.overheadCost) };
}

export function assessImprovement(plan: ImprovementPlan, evidence: unknown): ImprovementAssessment {
	try {
		validatePlan(plan);
		const { pairs, overhead } = readEvidence(plan, evidence);
		const specs = new Map(plan.cases.map((item) => [item.id, item]));
		const reasons: string[] = [];
		let totalCost = overhead;
		let heldout = 0;
		let gains = 0;
		for (const pair of pairs) {
			totalCost += pair.baseline.cost + pair.candidate.cost;
			const before = pair.baseline.outcome === "pass";
			const after = pair.candidate.outcome === "pass";
			const split = specs.get(pair.id)?.split;
			if ((!after && before) || (split === "regression" && !after)) {
				reasons.push(`regression:${pair.id}`);
			}
			if (split === "holdout") {
				heldout++;
				gains += Number(after) - Number(before);
			}
		}
		if (!Number.isFinite(totalCost)) throw new Error("evaluation cost overflow");
		const holdoutGain = gains / heldout;
		if (gains <= 0 || holdoutGain < plan.minHoldoutGain) reasons.push("insufficient-heldout-gain");
		if (totalCost > plan.maxTotalCost) reasons.push("evaluation-budget-exceeded");
		return {
			status: reasons.length ? "rejected" : "eligible-for-review",
			reasons,
			holdoutGain,
			totalCost,
		};
	} catch (error) {
		return {
			status: "needs-evidence",
			reasons: [error instanceof Error ? error.message : "invalid evaluation evidence"],
		};
	}
}
