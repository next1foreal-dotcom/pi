/** Candidate research driver. No production tool registration or live skill writes. */
export type Phase =
	| "discover"
	| "investigate"
	| "pending-probe"
	| "candidate"
	| "pending-review"
	| "trial-ready"
	| "pending-use"
	| "suspended"
	| "deferred"
	| "blocked";
export type Outcome = "success" | "failure" | "unknown";

export interface Evidence {
	ref: string;
	digest: string;
	origin: "environment" | "user";
	summary: string;
}
export interface Experience {
	id: string;
	taskId: string;
	expectation: string;
	observation: string;
	evidence: Evidence[];
}
export interface Question {
	problem: string;
	hypotheses: Array<{ id: string; explanation: string }>;
	wakeWhen: string;
}
export interface Probe {
	purpose: string;
	action: string;
	predictions: Array<{ hypothesisId: string; outcome: string }>;
}
export interface Observation {
	runId: string;
	outcome: Outcome;
	summary: string;
	evidence: Evidence[];
}
export interface MethodDraft {
	name: string;
	problem: string;
	preconditions: string[];
	steps: string[];
	stopWhen: string[];
	counterexamples: string[];
	sourceEvidenceRefs: string[];
}
export interface Method {
	id: string;
	draft: MethodDraft;
	status: "candidate" | "trial-ready" | "suspended";
	review?: ReviewReceipt;
}
export interface ReviewReceipt {
	methodId: string;
	planDigest: string;
	decision: "eligible-for-review" | "rejected" | "insufficient-evidence";
	heldOutTaskIds: string[];
	evidence: Evidence[];
}
export interface TrialTask {
	id: string;
	description: string;
	environment: string;
}
export interface Selection {
	decision: "use" | "deliberate";
	reason: string;
	adaptation: string[];
}
export interface Trial {
	task: TrialTask;
	methodId: string;
	selection: Selection;
	status: "declined" | "out-of-scope" | "denied" | "observed";
	evidence: Evidence[];
	observation?: Observation;
}
export type Pending =
	| { kind: "probe"; runId: string; probe: Probe }
	| { kind: "use"; runId: string; task: TrialTask; methodId: string; selection: Selection };

export interface GrowthState {
	schema: 1;
	id: string;
	revision: number;
	phase: Phase;
	experiences: Experience[];
	question?: Question;
	probes: Array<{ plan: Probe; observation: Observation }>;
	method?: Method;
	retired: Method[];
	trials: Trial[];
	pending?: Pending;
	limits: { thoughts: number; probes: number };
	spent: { thoughts: number; probes: number };
	note: string;
}
export interface ReasonRequest {
	stage: "discover" | "investigate" | "select";
	instruction: string;
	data: unknown;
}
export interface ProbeRequest {
	runId: string;
	inquiryId: string;
	probe: Probe;
}
export interface UseRequest {
	runId: string;
	task: TrialTask;
	method: Method;
	adaptation: string[];
}
export interface UseObservation extends Observation {
	taskId: string;
	methodId: string;
}
/**
 * All ports are supplied by the trusted Her host, never by generated code.
 * save must atomically compare expectedRevision and append a durable snapshot.
 * authorize/run ports own OS isolation, STOP, tool permissions and monetary budgets.
 * This driver implements no OS sandbox or credential boundary.
 */
export interface GrowthHost {
	reason(request: ReasonRequest, signal?: AbortSignal): Promise<unknown>;
	save(next: Readonly<GrowthState>, expectedRevision: number): Promise<void>;
	authorizeProbe(request: ProbeRequest, signal?: AbortSignal): Promise<boolean>;
	runProbe(request: ProbeRequest, signal?: AbortSignal): Promise<Observation>;
	review(method: Method, trainingTaskIds: readonly string[], signal?: AbortSignal): Promise<ReviewReceipt>;
	checkApplicability(
		method: Method,
		task: TrialTask,
		signal?: AbortSignal,
	): Promise<{ met: boolean; evidence: Evidence[] }>;
	authorizeUse(request: UseRequest, signal?: AbortSignal): Promise<boolean>;
	runUse(request: UseRequest, signal?: AbortSignal): Promise<UseObservation>;
}
