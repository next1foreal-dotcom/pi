import { createHash, randomUUID } from "node:crypto";
import { INSTRUCTIONS } from "./model.ts";
import * as parse from "./parse.ts";
import type {
	Experience,
	GrowthHost,
	GrowthState,
	Method,
	Observation,
	Probe,
	ReasonRequest,
	ReviewReceipt,
	Selection,
	Trial,
	TrialTask,
	UseObservation,
	UseRequest,
} from "./types.ts";

function freeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
async function commit(state: GrowthState, patch: Partial<GrowthState>, host: GrowthHost): Promise<GrowthState> {
	const next = freeze(structuredClone({ ...state, ...patch, revision: state.revision + 1 }));
	await host.save(next, state.revision);
	return next;
}
function message(error: unknown): string {
	return error instanceof Error ? error.message : "host operation failed";
}
export function startInquiry(
	id: string,
	input: Experience[],
	limits: { thoughts: number; probes: number },
): GrowthState {
	parse.text(id, "inquiry id");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id)) throw new Error("invalid inquiry id");
	for (const key of ["thoughts", "probes"] as const) {
		const limit = limits[key];
		if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) throw new Error(`invalid ${key} budget`);
	}
	return freeze({
		schema: 1,
		id,
		revision: 0,
		phase: "discover",
		experiences: parse.experiences(input),
		probes: [],
		retired: [],
		trials: [],
		limits: { ...limits },
		spent: { thoughts: 0, probes: 0 },
		note: "",
	});
}
async function think(
	state: GrowthState,
	stage: ReasonRequest["stage"],
	data: unknown,
	host: GrowthHost,
	signal?: AbortSignal,
): Promise<{ state: GrowthState; response?: Record<string, unknown> }> {
	signal?.throwIfAborted();
	if (state.spent.thoughts >= state.limits.thoughts) {
		return { state: await commit(state, { phase: "deferred", note: "thought budget exhausted" }, host) };
	}
	// CAS reservation happens before the model call, so concurrent readers cannot both spend.
	const reserved = await commit(state, { spent: { ...state.spent, thoughts: state.spent.thoughts + 1 } }, host);
	try {
		const response = await host.reason(
			freeze({ stage, instruction: INSTRUCTIONS[stage], data: structuredClone(data) }),
			signal,
		);
		signal?.throwIfAborted();
		return { state: reserved, response: parse.record(response, "model response") };
	} catch (error) {
		return { state: await commit(reserved, { phase: "blocked", note: message(error) }, host) };
	}
}
/** One bounded learning step. A pending external action is never automatically retried. */
export async function advance(state: GrowthState, host: GrowthHost, signal?: AbortSignal): Promise<GrowthState> {
	signal?.throwIfAborted();
	if (state.phase === "candidate") return reviewCandidate(state, host, signal);
	if (state.phase !== "discover" && state.phase !== "investigate") return state;
	const stage = state.phase;
	const answer = await think(
		state,
		stage,
		{
			experiences: state.experiences,
			question: state.question,
			probes: state.probes,
			retired: state.retired.map((item) => ({ id: item.id, draft: item.draft, status: item.status })),
			failedUses: state.trials.filter((item) => item.observation && item.observation.outcome !== "success"),
		},
		host,
		signal,
	);
	state = answer.state;
	const raw = answer.response;
	if (!raw) return state;
	let update: Partial<GrowthState> | undefined;
	let nextProbe: Probe | undefined;
	try {
		if (raw.decision === "defer") update = { phase: "deferred", note: parse.text(raw.reason, "reason") };
		else if (stage === "discover" && raw.decision === "investigate") {
			update = { phase: "investigate", question: parse.question(raw.question), note: "" };
		} else if (stage === "investigate" && raw.decision === "probe" && state.question) {
			nextProbe = parse.probe(raw.probe, state.question);
		} else if (stage === "investigate" && raw.decision === "method") {
			if (!state.probes.length) throw new Error("method needs an observed experiment");
			const refs = new Set([
				...state.experiences.flatMap((item) => item.evidence.map((e) => e.ref)),
				...state.probes.flatMap((item) => item.observation.evidence.map((e) => e.ref)),
			]);
			const draft = parse.method(raw.method, refs);
			const id = createHash("sha256").update(JSON.stringify(draft)).digest("hex");
			update = { phase: "candidate", method: { id, draft, status: "candidate" }, note: "" };
		} else throw new Error("decision is not valid for this phase");
	} catch (error) {
		update = { phase: "blocked", note: message(error) };
	}
	if (nextProbe) return performProbe(state, nextProbe, host, signal);
	return commit(state, update ?? { phase: "blocked", note: "no valid decision" }, host);
}
async function performProbe(
	state: GrowthState,
	probe: Probe,
	host: GrowthHost,
	signal?: AbortSignal,
): Promise<GrowthState> {
	if (state.spent.probes >= state.limits.probes) {
		return commit(state, { phase: "deferred", note: "probe budget exhausted" }, host);
	}
	const request = freeze({ runId: randomUUID(), inquiryId: state.id, probe });
	let authorized: boolean;
	try {
		authorized = await host.authorizeProbe(request, signal);
	} catch (error) {
		return commit(state, { phase: "blocked", note: message(error) }, host);
	}
	signal?.throwIfAborted();
	if (authorized !== true) return commit(state, { phase: "deferred", note: "probe not authorized" }, host);
	const pending = await commit(
		state,
		{
			phase: "pending-probe",
			pending: { kind: "probe", runId: request.runId, probe },
			spent: { ...state.spent, probes: state.spent.probes + 1 },
			note: "",
		},
		host,
	);
	let observed: Observation;
	try {
		signal?.throwIfAborted();
		observed = parse.observation(await host.runProbe(request, signal), request.runId);
	} catch (error) {
		return commit(pending, { note: `needs reconciliation: ${message(error)}` }, host);
	}
	return reconcile(pending, observed, host);
}
async function reviewCandidate(state: GrowthState, host: GrowthHost, signal?: AbortSignal): Promise<GrowthState> {
	if (!state.method) throw new Error("candidate method missing");
	// Reserve before a potentially costly independent review; a crashed review is not auto-replayed.
	state = await commit(state, { phase: "pending-review", note: "independent review pending" }, host);
	const training = trainingIds(state);
	let receipt: ReviewReceipt;
	try {
		signal?.throwIfAborted();
		receipt = await host.review(state.method!, [...training], signal);
		signal?.throwIfAborted();
	} catch (error) {
		return commit(state, { note: `review needs reconciliation: ${message(error)}` }, host);
	}
	return reconcileReview(state, receipt, host);
}
function trainingIds(state: GrowthState): Set<string> {
	return new Set([
		...state.experiences.map((item) => item.taskId),
		...state.probes.map((item) => item.observation.runId),
	]);
}
/** A trusted host may finish a previously reserved review from its durable result. */
export async function reconcileReview(
	state: GrowthState,
	receipt: ReviewReceipt,
	host: GrowthHost,
): Promise<GrowthState> {
	if (state.phase !== "pending-review" || !state.method) throw new Error("no pending review");
	let review: ReviewReceipt;
	try {
		review = parse.review(receipt, state.method.id, trainingIds(state));
	} catch (error) {
		return commit(state, { phase: "blocked", note: message(error) }, host);
	}
	const eligible = review.decision === "eligible-for-review";
	const method: Method = { ...state.method, review, status: eligible ? "trial-ready" : "candidate" };
	// "trial-ready" is research scope only. No merge, deployment, or production authority.
	return commit(state, { method, phase: eligible ? "trial-ready" : "deferred", note: review.decision }, host);
}
async function unused(
	state: GrowthState,
	task: TrialTask,
	selection: Selection,
	status: Trial["status"],
	evidence: Trial["evidence"],
	host: GrowthHost,
): Promise<GrowthState> {
	if (!state.method) throw new Error("method missing");
	return commit(
		state,
		{
			trials: [...state.trials, { task, methodId: state.method.id, selection, status, evidence }],
			note: status,
		},
		host,
	);
}
/** A fresh task receives the method as optional context; applicability and permission are host checks. */
export async function tryMethod(
	state: GrowthState,
	task: TrialTask,
	host: GrowthHost,
	signal?: AbortSignal,
): Promise<GrowthState> {
	signal?.throwIfAborted();
	if (state.phase !== "trial-ready" || state.method?.status !== "trial-ready") return state;
	task = {
		id: parse.text(task.id, "task id"),
		description: parse.text(task.description, "task"),
		environment: parse.text(task.environment, "environment"),
	};
	const answer = await think(
		state,
		"select",
		{
			task,
			availableMethod: { id: state.method.id, draft: state.method.draft },
		},
		host,
		signal,
	);
	state = answer.state;
	if (!answer.response) return state;
	let selection: Selection;
	try {
		selection = parse.selection(answer.response);
	} catch (error) {
		return commit(state, { phase: "blocked", note: message(error) }, host);
	}
	if (selection.decision === "deliberate") return unused(state, task, selection, "declined", [], host);
	if (!state.method) throw new Error("method missing");
	let applicability: Awaited<ReturnType<GrowthHost["checkApplicability"]>>;
	try {
		applicability = await host.checkApplicability(state.method, task, signal);
		applicability = { met: applicability.met, evidence: parse.evidenceList(applicability.evidence) };
		if (typeof applicability.met !== "boolean") throw new Error("invalid applicability result");
	} catch (error) {
		return commit(state, { phase: "blocked", note: message(error) }, host);
	}
	signal?.throwIfAborted();
	if (!applicability.met) return unused(state, task, selection, "out-of-scope", applicability.evidence, host);
	const request: UseRequest = freeze({
		runId: randomUUID(),
		task,
		method: state.method,
		adaptation: selection.adaptation,
	});
	let authorized: boolean;
	try {
		authorized = await host.authorizeUse(request, signal);
	} catch (error) {
		return commit(state, { phase: "blocked", note: message(error) }, host);
	}
	signal?.throwIfAborted();
	if (authorized !== true) return unused(state, task, selection, "denied", applicability.evidence, host);
	const pending = await commit(
		state,
		{
			phase: "pending-use",
			pending: { kind: "use", runId: request.runId, task, methodId: state.method.id, selection },
			note: "",
		},
		host,
	);
	let result: UseObservation;
	try {
		signal?.throwIfAborted();
		result = await host.runUse(request, signal);
		validateUseResult(result, pending);
	} catch (error) {
		return commit(pending, { note: `needs reconciliation: ${message(error)}` }, host);
	}
	return reconcile(pending, result, host);
}
function validateUseResult(value: unknown, state: GrowthState): void {
	if (state.pending?.kind !== "use" || !state.method) throw new Error("no pending method use");
	const raw = parse.record(value, "use observation");
	if (
		raw.taskId !== state.pending.task.id ||
		raw.methodId !== state.pending.methodId ||
		state.method.id !== state.pending.methodId
	)
		throw new Error("method/task receipt mismatch");
	parse.observation(value, state.pending.runId);
}
/** The host reconciles reality after an interrupted call; this function never re-executes it. */
export async function reconcile(
	state: GrowthState,
	receipt: Observation | UseObservation,
	host: GrowthHost,
): Promise<GrowthState> {
	const pending = state.pending;
	if (!pending) throw new Error("no pending action");
	const observation = parse.observation(receipt, pending.runId);
	// Prevent a source ref from silently changing in this inquiry.
	const prior = [
		...state.experiences.flatMap((item) => item.evidence),
		...state.probes.flatMap((item) => item.observation.evidence),
		...state.trials.flatMap((item) => item.evidence),
	];
	for (const item of observation.evidence) {
		if (prior.some((old) => old.ref === item.ref && old.digest !== item.digest)) {
			throw new Error("evidence ref changed content");
		}
	}
	if (pending.kind === "probe")
		return commit(
			state,
			{
				phase: "investigate",
				pending: undefined,
				note: "",
				probes: [...state.probes, { plan: pending.probe, observation }],
			},
			host,
		);
	validateUseResult(receipt, state);
	if (!state.method) throw new Error("method missing");
	const suspended = observation.outcome !== "success";
	return commit(
		state,
		{
			phase: suspended ? "suspended" : "trial-ready",
			pending: undefined,
			method: { ...state.method, status: suspended ? "suspended" : "trial-ready" },
			trials: [
				...state.trials,
				{
					task: pending.task,
					methodId: pending.methodId,
					selection: pending.selection,
					status: "observed",
					evidence: observation.evidence,
					observation,
				},
			],
			note: suspended
				? "method suspended pending investigation; failure is not yet causally attributed"
				: "trial observed",
		},
		host,
	);
}
/** Reopen after fresh evidence; old method stays retired and cannot bypass a new review. */
export async function reopen(state: GrowthState, fresh: Experience[], host: GrowthHost): Promise<GrowthState> {
	if (!["suspended", "deferred", "blocked"].includes(state.phase) || state.pending) {
		throw new Error("cannot reopen active or pending inquiry");
	}
	const combined = parse.experiences([...state.experiences, ...fresh]);
	if (combined.length === state.experiences.length) throw new Error("fresh evidence required");
	const retired = state.method ? [...state.retired, { ...state.method, status: "suspended" as const }] : state.retired;
	return commit(
		state,
		{
			phase: "discover",
			experiences: combined,
			retired,
			method: undefined,
			note: "reopened; previous budgets are not reset",
		},
		host,
	);
}
