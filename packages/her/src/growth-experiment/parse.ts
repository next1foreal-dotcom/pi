import type {
	Evidence,
	Experience,
	MethodDraft,
	Observation,
	Probe,
	Question,
	ReviewReceipt,
	Selection,
} from "./types.ts";

export function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}
export function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 16_000) {
		throw new Error(`${label} must be nonempty bounded text`);
	}
	return value.trim();
}
export function verbatim(value: unknown, label: string): string {
	text(value, label);
	return value as string;
}
export function texts(value: unknown, label: string, minimum = 1): string[] {
	if (!Array.isArray(value) || value.length < minimum || value.length > 32) {
		throw new Error(`${label} needs ${minimum}..32 entries`);
	}
	return value.map((item) => text(item, label));
}
export function evidenceList(value: unknown): Evidence[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error("host evidence is required");
	const result = value.map((entry): Evidence => {
		const raw = record(entry, "evidence");
		if (raw.origin !== "environment" && raw.origin !== "user") throw new Error("invalid evidence origin");
		const digest = text(raw.digest, "digest");
		if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid evidence digest");
		return {
			ref: text(raw.ref, "evidence ref"),
			digest,
			origin: raw.origin,
			summary: verbatim(raw.summary, "summary"),
		};
	});
	if (new Set(result.map((item) => item.ref)).size !== result.length) throw new Error("duplicate evidence ref");
	return result;
}
export function experiences(value: unknown): Experience[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error("1..32 experiences required");
	const result = value.map((entry): Experience => {
		const raw = record(entry, "experience");
		return {
			id: text(raw.id, "experience id"),
			taskId: text(raw.taskId, "task id"),
			expectation: text(raw.expectation, "expectation"),
			observation: text(raw.observation, "observation"),
			evidence: evidenceList(raw.evidence),
		};
	});
	if (new Set(result.map((item) => item.id)).size !== result.length) throw new Error("duplicate experience id");
	// A ref must not silently change content across experiences.
	const refs = new Map<string, string>();
	for (const item of result.flatMap((entry) => entry.evidence)) {
		if (refs.has(item.ref) && refs.get(item.ref) !== item.digest) throw new Error("evidence ref changed content");
		refs.set(item.ref, item.digest);
	}
	return result;
}
export function question(value: unknown): Question {
	const raw = record(value, "question");
	if (!Array.isArray(raw.hypotheses) || raw.hypotheses.length < 2 || raw.hypotheses.length > 8) {
		throw new Error("2..8 competing hypotheses required");
	}
	const hypotheses = raw.hypotheses.map((item) => {
		const hypothesis = record(item, "hypothesis");
		return { id: text(hypothesis.id, "hypothesis id"), explanation: text(hypothesis.explanation, "explanation") };
	});
	if (new Set(hypotheses.map((item) => item.id)).size !== hypotheses.length)
		throw new Error("duplicate hypothesis id");
	return { problem: text(raw.problem, "problem"), hypotheses, wakeWhen: text(raw.wakeWhen, "wakeWhen") };
}
export function probe(value: unknown, known: Question): Probe {
	const raw = record(value, "probe");
	if (!Array.isArray(raw.predictions) || raw.predictions.length < 2 || raw.predictions.length > 8) {
		throw new Error("probe must distinguish at least two hypotheses");
	}
	const ids = new Set(known.hypotheses.map((item) => item.id));
	const predictions = raw.predictions.map((entry) => {
		const item = record(entry, "prediction");
		const hypothesisId = text(item.hypothesisId, "hypothesisId");
		if (!ids.has(hypothesisId)) throw new Error("unknown hypothesis id");
		return { hypothesisId, outcome: text(item.outcome, "outcome") };
	});
	if (new Set(predictions.map((item) => item.hypothesisId)).size !== predictions.length) {
		throw new Error("duplicate prediction hypothesis");
	}
	// Syntactic check only. The trusted host must check semantic informativeness.
	const alternatives = predictions.map((item) => item.outcome.toLowerCase().replace(/\s+/g, " "));
	if (new Set(alternatives).size < 2) throw new Error("probe predictions do not distinguish hypotheses");
	return { purpose: text(raw.purpose, "purpose"), action: text(raw.action, "action"), predictions };
}
export function method(value: unknown, allowedRefs: Set<string>): MethodDraft {
	const raw = record(value, "method");
	const refs = texts(raw.sourceEvidenceRefs, "sourceEvidenceRefs");
	if (refs.some((ref) => !allowedRefs.has(ref))) throw new Error("method cites unknown evidence");
	return {
		name: text(raw.name, "name"),
		problem: text(raw.problem, "problem"),
		preconditions: texts(raw.preconditions, "preconditions"),
		steps: texts(raw.steps, "steps"),
		stopWhen: texts(raw.stopWhen, "stopWhen"),
		counterexamples: texts(raw.counterexamples, "counterexamples"),
		sourceEvidenceRefs: refs,
	};
}
export function observation(value: unknown, runId: string): Observation {
	const raw = record(value, "observation");
	if (raw.runId !== runId) throw new Error("observation runId mismatch");
	if (raw.outcome !== "success" && raw.outcome !== "failure" && raw.outcome !== "unknown") {
		throw new Error("invalid observation outcome");
	}
	return {
		runId,
		outcome: raw.outcome,
		summary: verbatim(raw.summary, "summary"),
		evidence: evidenceList(raw.evidence),
	};
}
export function selection(value: unknown): Selection {
	const raw = record(value, "selection");
	if (raw.decision !== "use" && raw.decision !== "deliberate") throw new Error("invalid selection decision");
	return {
		decision: raw.decision,
		reason: text(raw.reason, "reason"),
		adaptation: texts(raw.adaptation, "adaptation", raw.decision === "use" ? 1 : 0),
	};
}
export function review(value: unknown, methodId: string, trainingIds: Set<string>): ReviewReceipt {
	const raw = record(value, "review");
	if (raw.methodId !== methodId) throw new Error("review methodId mismatch");
	const planDigest = text(raw.planDigest, "planDigest");
	if (!/^[a-f0-9]{64}$/.test(planDigest)) throw new Error("invalid plan digest");
	if (!["eligible-for-review", "rejected", "insufficient-evidence"].includes(String(raw.decision))) {
		throw new Error("invalid review decision");
	}
	const heldOutTaskIds = texts(raw.heldOutTaskIds, "held-out task ids");
	if (new Set(heldOutTaskIds).size !== heldOutTaskIds.length || heldOutTaskIds.some((id) => trainingIds.has(id))) {
		throw new Error("held-out tasks overlap training or each other");
	}
	return {
		methodId,
		planDigest,
		decision: raw.decision as ReviewReceipt["decision"],
		heldOutTaskIds,
		evidence: evidenceList(raw.evidence),
	};
}
