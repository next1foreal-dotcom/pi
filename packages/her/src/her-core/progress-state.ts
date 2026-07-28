/**
 * G-160 — StructAgent-inspired unified progress state (Her steal).
 *
 * Core discipline: planner/actor outputs are proposals. Only verifier-backed
 * decisions commit, preserve, or invalidate requirements. Progress is
 * `req / val / ver` — minimum sufficient causal surface for long-horizon work.
 *
 * Source: arXiv:2607.11388 (StructAgent). Steal the state discipline, not CUA.
 */

export type RequirementStatus = "pending" | "verified" | "invalidated";

export type Requirement = {
	id: string;
	/** What must be true for this subgoal. */
	check: string;
	status: RequirementStatus;
};

export type UsefulValue = {
	key: string;
	value: string;
	/** Requirement id that justified carrying this value, if any. */
	fromRequirement?: string;
};

export type VerifiedEvidence = {
	id: string;
	/** Free-form probe result (exit code, path, URL, inventory check, …). */
	kind: string;
	summary: string;
	at: string;
	requirementIds: string[];
};

export type ProgressState = {
	requirements: Requirement[];
	values: UsefulValue[];
	evidences: VerifiedEvidence[];
};

export type VerifyDecision =
	| {
			action: "verify";
			requirementIds: string[];
			evidence: Omit<VerifiedEvidence, "id" | "at" | "requirementIds"> & {
				id?: string;
				at?: string;
				requirementIds?: string[];
			};
			values?: UsefulValue[];
	  }
	| {
			action: "invalidate";
			requirementIds: string[];
			evidence: Omit<VerifiedEvidence, "id" | "at" | "requirementIds"> & {
				id?: string;
				at?: string;
				requirementIds?: string[];
			};
	  }
	| { action: "noop" };

/** Recovery routing when state fails to advance (StructAgent §3.3). */
export type FailureClass =
	| "insufficient_evidence"
	| "conflicting_evidence"
	| "strategy_exhausted"
	| "environment_blocked"
	| "unknown";

export function emptyProgressState(): ProgressState {
	return { requirements: [], values: [], evidences: [] };
}

export function withRequirements(state: ProgressState, reqs: Array<{ id: string; check: string }>): ProgressState {
	const next = [...state.requirements];
	for (const r of reqs) {
		const id = r.id.trim();
		const check = r.check.trim();
		if (!id || !check) {
			throw new Error("progress-state: requirement id and check are required");
		}
		if (next.some((x) => x.id === id)) {
			throw new Error(`progress-state: duplicate requirement id "${id}"`);
		}
		next.push({ id, check, status: "pending" });
	}
	return { ...state, requirements: next };
}

/**
 * Apply a verifier decision. Actor/planner claims never call this — only the
 * verifier (or a coded gate that stands in for one) may commit progress.
 */
export function applyVerifierDecision(
	state: ProgressState,
	decision: VerifyDecision,
	now: Date = new Date(),
): ProgressState {
	if (decision.action === "noop") return state;

	const at = decision.evidence.at ?? now.toISOString();
	const evidenceId = decision.evidence.id?.trim() || `ev-${state.evidences.length + 1}-${decision.action}`;
	const requirementIds = [...new Set(decision.requirementIds.map((x) => x.trim()).filter(Boolean))];
	if (requirementIds.length === 0) {
		throw new Error("progress-state: verify/invalidate needs requirementIds");
	}

	const unknown = requirementIds.filter((id) => !state.requirements.some((r) => r.id === id));
	if (unknown.length > 0) {
		throw new Error(`progress-state: unknown requirement(s): ${unknown.join(", ")}`);
	}

	const evidence: VerifiedEvidence = {
		id: evidenceId,
		kind: decision.evidence.kind,
		summary: decision.evidence.summary,
		at,
		requirementIds,
	};

	const requirements = state.requirements.map((r) => {
		if (!requirementIds.includes(r.id)) return r;
		if (decision.action === "verify") {
			return { ...r, status: "verified" as const };
		}
		return { ...r, status: "invalidated" as const };
	});

	let values = state.values;
	if (decision.action === "verify" && decision.values && decision.values.length > 0) {
		values = upsertValues(values, decision.values);
	}

	return {
		requirements,
		values,
		evidences: [...state.evidences, evidence],
	};
}

function upsertValues(existing: UsefulValue[], incoming: UsefulValue[]): UsefulValue[] {
	const next = [...existing];
	for (const v of incoming) {
		const key = v.key.trim();
		if (!key) throw new Error("progress-state: value key is required");
		const i = next.findIndex((x) => x.key === key);
		const row: UsefulValue = {
			key,
			value: String(v.value),
			...(v.fromRequirement ? { fromRequirement: v.fromRequirement } : {}),
		};
		if (i >= 0) next[i] = row;
		else next.push(row);
	}
	return next;
}

export function requirementStatus(state: ProgressState, id: string): RequirementStatus | null {
	return state.requirements.find((r) => r.id === id)?.status ?? null;
}

export function allVerified(state: ProgressState, ids?: string[]): boolean {
	const target = ids?.length ? state.requirements.filter((r) => ids.includes(r.id)) : state.requirements;
	if (target.length === 0) return false;
	return target.every((r) => r.status === "verified");
}

export function anyInvalidated(state: ProgressState, ids?: string[]): boolean {
	const target = ids?.length ? state.requirements.filter((r) => ids.includes(r.id)) : state.requirements;
	return target.some((r) => r.status === "invalidated");
}

/**
 * Classify why progress stalled — for targeted recovery, not blind retry.
 */
export function classifyStall(state: ProgressState): FailureClass {
	if (anyInvalidated(state)) return "conflicting_evidence";
	const pending = state.requirements.filter((r) => r.status === "pending");
	if (pending.length === 0) return "unknown";
	if (state.evidences.length === 0) return "insufficient_evidence";
	const last = state.evidences[state.evidences.length - 1];
	const kind = last.kind.toLowerCase();
	if (kind.includes("env") || kind.includes("blocked") || kind.includes("timeout")) {
		return "environment_blocked";
	}
	if (kind.includes("retry") || kind.includes("strategy")) {
		return "strategy_exhausted";
	}
	return "insufficient_evidence";
}

/** Compact checkpoint for resume / human audit (markdown-friendly). */
export function formatProgressCheckpoint(state: ProgressState): string {
	const reqLines = state.requirements.map((r) => `- [${r.status}] \`${r.id}\`: ${r.check}`);
	const valLines = state.values.map((v) => `- \`${v.key}\` = ${v.value}`);
	const evLines = state.evidences.map((e) => `- ${e.at} · ${e.kind} · ${e.summary} → ${e.requirementIds.join(",")}`);
	return [
		"## Progress checkpoint",
		"",
		"### Requirements",
		...(reqLines.length ? reqLines : ["- (none)"]),
		"",
		"### Values",
		...(valLines.length ? valLines : ["- (none)"]),
		"",
		"### Evidences",
		...(evLines.length ? evLines : ["- (none)"]),
	].join("\n");
}

/**
 * Display / list overlay: claimed frontmatter status vs disk `.done` evidence.
 * Self-reported `running`/`pending` loses to verifier-backed `.done`.
 */
export type DoneEvidence = { exitCode: number; endedAt?: string };

export type HerTaskDisplayStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export function statusFromDoneEvidence(claimed: string, done: DoneEvidence | null): HerTaskDisplayStatus | null {
	const terminals = new Set(["completed", "failed", "cancelled"]);
	if (terminals.has(claimed)) {
		return claimed as HerTaskDisplayStatus;
	}
	if (!done) {
		if (claimed === "pending" || claimed === "running") {
			return claimed;
		}
		return null;
	}
	return done.exitCode === 0 ? "completed" : "failed";
}
