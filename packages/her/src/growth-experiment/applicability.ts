import { canonicalJson, sha256 } from "../her-core/improvement-plan.ts";
import type { GrowthJournal, GrowthReceipt } from "./journal.ts";
import type { Evidence, Method, TrialTask } from "./types.ts";

/** Explicit finite scalar facts, supplied only by the frozen independent operation. */
export type ApplicabilityFacts = Record<string, { type: "string" | "boolean" | "number"; description?: string }>;
interface Verdict {
	status: "met" | "unmet" | "unknown";
	issues: string[];
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function scalar(value: unknown, type: string): boolean {
	return (
		typeof value === type &&
		(type === "number" ? Number.isSafeInteger(value) : type !== "string" || (value as string).length <= 1000)
	);
}
export function validateApplicabilityFacts(contract: ApplicabilityFacts | undefined): void {
	if (contract === undefined) return;
	if (!object(contract) || Object.keys(contract).length < 1 || Object.keys(contract).length > 32)
		throw new Error("invalid applicability fact catalog");
	for (const [name, field] of Object.entries(contract)) {
		if (
			!/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*){0,3}$/.test(name) ||
			name.split(".").some((part) => ["constructor", "prototype", "__proto__"].includes(part)) ||
			!object(field) ||
			Object.keys(field).some((key) => !["type", "description"].includes(key)) ||
			!["string", "boolean", "number"].includes(field.type) ||
			(field.description !== undefined && (typeof field.description !== "string" || field.description.length > 512))
		)
			throw new Error("invalid applicability fact field");
	}
}
export function renderApplicabilityFacts(contract: ApplicabilityFacts | undefined): string {
	if (!contract) return "";
	validateApplicabilityFacts(contract);
	return [
		"Host-checkable method preconditions are JSON-encoded strings, each exactly {fact: an approved fact name, oneOf: 1..16 literal values of its declared type}. All preconditions must be verified. Choose your own conditions from observed evidence; no method or scope values are prescribed.",
		"Free text, missing facts, unsupported constraints or type mismatches remain unknown and block use. A matching fact does not prove method quality or expand permission. This is a bounded fact protocol, not natural-language inference.",
		JSON.stringify({ applicabilityFacts: contract }),
	].join("\n");
}
/** Unknown dominates mismatch: unavailable evidence is not a verified negative. */
export function evaluateApplicability(
	preconditions: unknown,
	observed: unknown,
	contract: ApplicabilityFacts,
): Verdict {
	validateApplicabilityFacts(contract);
	const issues: string[] = [];
	if (
		!object(observed) ||
		Object.keys(observed).some((key) => !["status", "facts"].includes(key)) ||
		observed.status !== "observed" ||
		!object(observed.facts)
	)
		return { status: "unknown", issues: ["independent facts unavailable"] };
	const facts = observed.facts;
	if (Object.keys(facts).some((name) => !Object.hasOwn(contract, name) || !scalar(facts[name], contract[name].type)))
		return { status: "unknown", issues: ["independent fact catalog/type mismatch"] };
	if (!Array.isArray(preconditions) || preconditions.length < 1 || preconditions.length > 32)
		return { status: "unknown", issues: ["1..32 explicit preconditions required"] };
	let met = true;
	for (const [i, encoded] of preconditions.entries()) {
		let condition: unknown;
		try {
			condition = typeof encoded === "string" && encoded.length <= 16000 ? JSON.parse(encoded) : null;
		} catch {
			condition = null;
		}
		if (
			!object(condition) ||
			Object.keys(condition).length !== 2 ||
			!Object.hasOwn(condition, "fact") ||
			!Object.hasOwn(condition, "oneOf") ||
			typeof condition.fact !== "string" ||
			!Object.hasOwn(contract, condition.fact) ||
			!Array.isArray(condition.oneOf) ||
			condition.oneOf.length < 1 ||
			condition.oneOf.length > 16 ||
			!condition.oneOf.every((value) => scalar(value, contract[condition.fact as string].type))
		) {
			issues.push(`preconditions[${i}]: unsupported explicit condition`);
			continue;
		}
		if (!Object.hasOwn(facts, condition.fact)) {
			issues.push(`preconditions[${i}]: fact unavailable`);
			continue;
		}
		if (!condition.oneOf.includes(facts[condition.fact])) met = false;
	}
	return { status: issues.length ? "unknown" : met ? "met" : "unmet", issues };
}
export async function recordApplicability(
	journal: GrowthJournal,
	method: Method,
	task: TrialTask,
	planDigest: string,
	contract: ApplicabilityFacts,
	runId: string,
	result: { value: Record<string, unknown>; evidence: Evidence[] },
): Promise<{ met: boolean; evidence: Evidence[] }> {
	const verdict = evaluateApplicability(method.draft.preconditions, result.value, contract);
	await journal.append("applicability-result", {
		runId,
		methodId: method.id,
		methodDigest: sha256(canonicalJson(method)),
		taskId: task.id,
		taskDigest: sha256(canonicalJson(task)),
		planDigest,
		status: verdict.status,
		issues: verdict.issues,
		factsDigest: sha256(canonicalJson(result.value)),
		evidence: result.evidence,
	});
	if (verdict.status === "unknown") throw new Error(`method applicability unknown: ${verdict.issues.join("; ")}`);
	return { met: verdict.status === "met", evidence: result.evidence };
}
/** Positive receipts cannot be borrowed across tasks, method revisions or a later unknown check. */
export function hasMetApplicability(
	rows: GrowthReceipt[],
	method: Method,
	task: TrialTask,
	planDigest: string,
	operationId: string,
): boolean {
	const receipt = [...rows]
		.reverse()
		.find(
			(row) => row.kind === "applicability-result" && row.data.methodId === method.id && row.data.taskId === task.id,
		)?.data;
	if (
		!receipt ||
		receipt.status !== "met" ||
		receipt.planDigest !== planDigest ||
		receipt.methodDigest !== sha256(canonicalJson(method)) ||
		receipt.taskDigest !== sha256(canonicalJson(task))
	)
		return false;
	return (
		rows.some(
			(row) =>
				row.kind === "execution-intent" && row.data.runId === receipt.runId && row.data.operationId === operationId,
		) &&
		rows.some(
			(row) =>
				row.kind === "execution-result" &&
				row.data.runId === receipt.runId &&
				row.data.exitCode === 0 &&
				canonicalJson(row.data.evidence) === canonicalJson(receipt.evidence),
		)
	);
}
