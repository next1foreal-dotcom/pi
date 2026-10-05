import { randomUUID } from "node:crypto";
import { assessImprovement } from "../her-core/improvement-assessment.ts";
import { canonicalJson, readProtectedFile, sha256 } from "../her-core/improvement-plan.ts";
import { storeLock } from "../her-core/store-lock.ts";
import type { GrowthHostPlan, HostTask } from "./host.ts";
import type { GrowthJournal, GrowthReceipt } from "./journal.ts";
import { record, text } from "./parse.ts";
import type { Evidence, GrowthState, Method, ReviewReceipt, UseObservation } from "./types.ts";

export interface GrowthReviewSuite {
	cases: Array<HostTask & { split: "holdout" | "regression" }>;
	minGain: number;
}
interface GrowthReviewHost {
	plan: Readonly<GrowthHostPlan>;
	planDigest: string;
	journal: GrowthJournal;
	assertRunning(signal?: AbortSignal): Promise<void>;
	solve(task: HostTask, method: Method | undefined, adaptation: string[], signal?: AbortSignal): Promise<unknown>;
	execute(
		operationId: string,
		purpose: "review",
		input: unknown,
		runId: string,
		signal?: AbortSignal,
	): Promise<{ value: Record<string, unknown>; evidence: Evidence[] }>;
}
const evidence = (ref: string, bytes: string): Evidence => ({
	ref,
	digest: sha256(bytes),
	origin: "environment",
	summary: bytes.slice(0, 15000),
});

export function sealedReviewTasks(plan: Readonly<GrowthHostPlan>): HostTask[] {
	return [...plan.review.cases, ...(plan.correction?.review.cases ?? [])];
}
/** Both suites and all task inputs are frozen together, never selected from observed scores. */
export function validateGrowthReviewPlan(plan: GrowthHostPlan): void {
	const suites = [plan.review, ...(plan.correction ? [plan.correction.review] : [])];
	for (const suite of suites) {
		if (!Number.isFinite(suite.minGain) || suite.minGain <= 0 || suite.minGain > 1)
			throw new Error("invalid review threshold");
		if (!suite.cases.some((c) => c.split === "holdout") || !suite.cases.some((c) => c.split === "regression"))
			throw new Error("unique tasks and held-out/regression cases required");
	}
	if (plan.correction) {
		const ids = plan.correction.developmentTaskIds;
		if (
			!Array.isArray(ids) ||
			!ids.length ||
			new Set(ids).size !== ids.length ||
			ids.some((id) => !plan.tasks.some((t) => t.id === id)) ||
			ids.length === plan.tasks.length
		)
			throw new Error("invalid approved development tasks");
		if (plan.correction.review.minGain < plan.review.minGain)
			throw new Error("correction threshold cannot be lowered");
	}
	const cases = [...plan.tasks, ...sealedReviewTasks(plan)];
	if (!cases.length || new Set(cases.map((c) => c.id)).size !== cases.length)
		throw new Error("unique tasks and held-out/regression cases required");
	for (const c of cases) {
		text(c.id, "task id");
		text(c.description, "task description");
		text(c.environment, "task environment");
		canonicalJson(c.input);
		canonicalJson(c.expected);
	}
	const inputs = cases.map((c) => sha256(canonicalJson(c.input)));
	if (new Set(inputs).size !== inputs.length) throw new Error("duplicate host task input");
}
/** A final-task attempt cannot become training material, even if it was declined or failed. */
export function assertResearchUnexposed(
	plan: Readonly<GrowthHostPlan>,
	state: GrowthState | undefined,
	rows: GrowthReceipt[],
): void {
	if (!plan.correction) return;
	const finals = plan.tasks.filter((t) => !plan.correction!.developmentTaskIds.includes(t.id)).map((t) => t.id);
	if (
		state?.trials.some((t) => finals.includes(t.task.id)) ||
		rows.some(
			(r) =>
				["baseline-reserved", "use-result", "task-selection-reserved"].includes(r.kind) &&
				finals.includes(String(r.data.taskId)),
		)
	)
		throw new Error("final tasks exposed; research/correction prohibited");
}

/** Existing independent paired gate, with one optional preregistered correction suite. */
export async function reviewGrowthCandidate(
	host: GrowthReviewHost,
	method: Method,
	trainingIds: readonly string[],
	signal?: AbortSignal,
): Promise<ReviewReceipt> {
	await host.assertRunning(signal);
	const state = await host.journal.state();
	if (
		state?.method?.id !== method.id ||
		state.phase !== "pending-review" ||
		canonicalJson(state.method) !== canonicalJson(method)
	)
		throw new Error("method not bound to pending host review");
	assertResearchUnexposed(host.plan, state, await host.journal.read());
	const { review, suiteIndex } = await storeLock(host.journal.root, async () => {
		const rows = await host.journal.read();
		const current = await host.journal.state();
		if (current?.phase !== "pending-review" || canonicalJson(current.method) !== canonicalJson(method))
			throw new Error("stale pending host review");
		const prior = rows.filter((r) => r.kind === "review-reserved");
		let review = host.plan.review;
		const suiteIndex = prior.length;
		if (suiteIndex) {
			if (!host.plan.correction || suiteIndex !== 1 || prior[0].data.methodId === method.id)
				throw new Error("final suite already consumed; no tuning/replay");
			assertResearchUnexposed(host.plan, state, rows);
			const previous = state.retired.find((m) => m.id === prior[0].data.methodId && m.status === "suspended");
			if (
				!previous ||
				sha256(canonicalJson(previous.draft)) !== prior[0].data.methodDraftDigest ||
				canonicalJson(previous.draft) === canonicalJson(method.draft)
			)
				throw new Error("correction needs a changed method after suspension");
			if (
				!rows.some(
					(r) =>
						r.kind === "review-result" &&
						(r.data.receipt as ReviewReceipt | undefined)?.methodId === previous.id &&
						(r.data.receipt as ReviewReceipt | undefined)?.decision === "eligible-for-review",
				)
			)
				throw new Error("correction requires completed eligible first review");
			const failure = rows.find(
				(r) =>
					r.kind === "use-result" &&
					r.data.methodId === previous.id &&
					r.data.outcome === "failure" &&
					host.plan.correction!.developmentTaskIds.includes(String(r.data.taskId)),
			);
			if (
				!failure ||
				!state.trials.some(
					(t) =>
						t.methodId === previous.id &&
						t.observation?.runId === failure.data.runId &&
						t.observation?.outcome === "failure",
				)
			)
				throw new Error("fresh actual development failure required");
			const observed = failure.data as unknown as UseObservation;
			if (
				!rows.some(
					(r) =>
						r.kind === "execution-result" &&
						r.data.runId === observed.runId &&
						r.data.exitCode === 0 &&
						canonicalJson(r.data.evidence) === canonicalJson(observed.evidence),
				) ||
				!rows.some(
					(r) =>
						r.kind === "execution-intent" &&
						r.data.runId === observed.runId &&
						r.data.operationId === host.plan.useOperation,
				)
			)
				throw new Error("fresh development execution evidence required");
			const fresh = state.experiences.find(
				(e) =>
					e.taskId === observed.taskId &&
					e.observation === observed.summary &&
					canonicalJson(e.evidence) === canonicalJson(observed.evidence),
			);
			if (!fresh || !observed.evidence.some((e) => method.draft.sourceEvidenceRefs.includes(e.ref)))
				throw new Error("fresh development evidence must ground correction");
			for (const e of observed.evidence)
				if (sha256(await readProtectedFile(host.journal.root, e.ref, host.plan.budget.outputBytes)) !== e.digest)
					throw new Error("fresh development artifact changed");
			review = host.plan.correction.review;
		}
		if (
			review.cases.some(
				(c) =>
					trainingIds.includes(c.id) ||
					state.experiences.some((e) => sha256(e.expectation) === sha256(c.description)),
			)
		)
			throw new Error("final tasks overlap training");
		const trained = state.probes.flatMap((p) => {
			const action = record(JSON.parse(p.plan.action), "probe action");
			const input = record(action.input, "probe input");
			const key = host.plan.operations[String(action.operationId)]?.probeInputContract?.batch?.key ?? "cases";
			return (Array.isArray(input[key]) ? input[key] : [input]).map((i) => sha256(canonicalJson(i)));
		});
		if (review.cases.some((c) => trained.includes(sha256(canonicalJson(c.input)))))
			throw new Error("final inputs overlap observed probes");
		await host.journal.append("review-reserved", {
			methodId: method.id,
			methodDraftDigest: sha256(canonicalJson(method.draft)),
			planDigest: host.planDigest,
			suiteIndex,
			suiteDigest: sha256(canonicalJson(review)),
		});
		return { review, suiteIndex };
	});
	const pairs = [];
	const refs: Evidence[] = [];
	const trainingInputs = state.experiences.flatMap((e) => e.evidence.map((v) => v.digest));
	for (const probe of state.probes) {
		try {
			trainingInputs.push(sha256(canonicalJson(record(JSON.parse(probe.plan.action), "probe action").input)));
		} catch {
			throw new Error("probe input digest unavailable for final isolation");
		}
	}
	const beforeReview = (await host.journal.read())
		.filter((r) => r.kind === "model-result")
		.reduce((n, r) => n + Number(r.data.usd), 0);
	for (const task of review.cases) {
		const measurements = [];
		for (const candidate of [undefined, method]) {
			const before = (await host.journal.read())
				.filter((r) => r.kind === "model-result")
				.reduce((n, r) => n + Number(r.data.usd), 0);
			const answer = await host.solve(task, candidate, [], signal);
			const after = (await host.journal.read())
				.filter((r) => r.kind === "model-result")
				.reduce((n, r) => n + Number(r.data.usd), 0);
			const result = await host.execute(
				host.plan.reviewOperation,
				"review",
				{ task: { id: task.id, input: task.input }, answer },
				randomUUID(),
				signal,
			);
			refs.push(...result.evidence);
			measurements.push({
				outcome:
					canonicalJson(result.value.value) === canonicalJson(task.expected)
						? ("pass" as const)
						: ("fail" as const),
				cost: after - before,
				evidenceDigest: sha256(canonicalJson(result.value)),
			});
		}
		pairs.push({
			id: task.id,
			inputDigest: sha256(canonicalJson(task.input)),
			baseline: measurements[0],
			candidate: measurements[1],
		});
	}
	const binding = {
		version: 1 as const,
		proposalId: host.plan.inquiryId,
		baselineDigest: sha256(canonicalJson(state.experiences)),
		candidateDigest: method.id,
		suiteDigest: sha256(canonicalJson({ planDigest: host.planDigest, suiteIndex, review })),
		evaluatorDigest: host.plan.operations[host.plan.reviewOperation].sha256,
	};
	const assessment = assessImprovement(
		{
			...binding,
			trainingInputDigests: trainingInputs,
			cases: review.cases.map((c) => ({
				id: c.id,
				split: c.split,
				inputDigest: sha256(canonicalJson(c.input)),
			})),
			minHoldoutGain: review.minGain,
			maxTotalCost: host.plan.budget.usd,
		},
		{ ...binding, cases: pairs, overheadCost: beforeReview },
	);
	const receipt: ReviewReceipt = {
		methodId: method.id,
		planDigest: host.planDigest,
		decision:
			assessment.status === "eligible-for-review"
				? "eligible-for-review"
				: assessment.status === "rejected"
					? "rejected"
					: "insufficient-evidence",
		heldOutTaskIds: review.cases.map((c) => c.id),
		evidence: [
			evidence(
				`growth-review:${method.id}`,
				JSON.stringify({ assessment, artifactDigests: refs.map((e) => e.digest) }),
			),
		],
	};
	await host.journal.append("review-result", {
		receipt,
		pairs,
		evidence: refs,
		suiteIndex,
		suiteDigest: sha256(canonicalJson(review)),
	});
	return receipt;
}
