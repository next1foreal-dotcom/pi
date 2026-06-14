export const delegationTiers = ["tier0", "tier1", "tier2"] as const;
export type DelegationTier = (typeof delegationTiers)[number];

export const incidentLevels = ["none", "L1", "L2", "L3"] as const;
export type IncidentLevel = (typeof incidentLevels)[number];

export interface DelegatedOperation {
	branch?: string;
	costUsd?: number;
	deletesFiles?: boolean;
	destructive?: boolean;
	externalPublish?: boolean;
	kind: string;
	path?: string;
	repository?: string;
	target?: string;
}

export interface DelegationDecision {
	reason: string;
	requiresConfirmation: boolean;
	tier: DelegationTier;
}

export interface TrustEvent {
	boundaryScore?: number;
	incident?: IncidentLevel;
	kind: "success" | "boundary-refusal" | "incident";
	operation: string;
	ts?: string;
}

export interface TrustUpgradeProposal {
	evidence: string[];
	from: DelegationTier;
	operation: string;
	requiresFeiApproval: true;
	to: DelegationTier;
}

export interface TrustIncidentAction {
	incident: IncidentLevel;
	nextTier: DelegationTier;
	requiresReview: boolean;
	reason: string;
}

const tierOneRepositories = new Set(["her-memory", "Her", "Her-repo", "next1foreal-dotcom/Her"]);
const protectedBranches = new Set(["main", "master", "production", "release"]);
const tierTwoKinds = new Set(["push-main", "formal-pr", "delete", "deploy", "publish", "spend", "pi-fork-change"]);
const tierZeroKinds = new Set(["scratch", "sandbox", "temp"]);

export function classifyDelegatedOperation(operation: DelegatedOperation): DelegationDecision {
	if (operation.repository === "pi" || operation.repository === "samantha" || operation.kind === "pi-fork-change") {
		return tier2("pi fork changes stay confirm-gated");
	}
	if (operation.destructive || operation.deletesFiles || operation.externalPublish) {
		return tier2("destructive, delete, or external publish operation");
	}
	if (typeof operation.costUsd === "number" && operation.costUsd > 0) {
		return tier2("spend requires single-use confirmation");
	}
	if (operation.branch && protectedBranches.has(operation.branch)) {
		return tier2("protected branch requires confirmation");
	}
	if (tierTwoKinds.has(operation.kind)) return tier2(`${operation.kind} requires confirmation`);
	if (isTierZero(operation)) {
		return { tier: "tier0", requiresConfirmation: false, reason: "sandbox or Her-owned scratch space" };
	}
	if (isTierOne(operation)) {
		return {
			tier: "tier1",
			requiresConfirmation: false,
			reason: "scoped Her repository work on a non-protected branch",
		};
	}
	return tier2("unrecognized operation defaults to confirmation");
}

export function proposeTrustUpgrade(
	operation: string,
	events: TrustEvent[],
	opts: { currentTier?: DelegationTier; minSuccesses?: number } = {},
): TrustUpgradeProposal | null {
	const currentTier = opts.currentTier ?? "tier0";
	const minSuccesses = opts.minSuccesses ?? 10;
	if (currentTier === "tier2") return null;
	let consecutiveSuccesses = 0;
	let hasHighQualityRefusal = false;
	const evidence: string[] = [];
	for (const event of events.filter((item) => item.operation === operation)) {
		if (event.kind === "incident" && event.incident && event.incident !== "none") {
			consecutiveSuccesses = 0;
			hasHighQualityRefusal = false;
			evidence.length = 0;
			continue;
		}
		if (event.kind === "boundary-refusal" && event.boundaryScore === 2) {
			hasHighQualityRefusal = true;
			evidence.push("high-quality boundary refusal counted positively");
			continue;
		}
		if (event.kind === "success") {
			consecutiveSuccesses += 1;
			evidence.push(`success ${consecutiveSuccesses}/${minSuccesses}`);
		}
	}
	if (consecutiveSuccesses < minSuccesses || !hasHighQualityRefusal) return null;
	return {
		operation,
		from: currentTier,
		to: currentTier === "tier0" ? "tier1" : "tier2",
		requiresFeiApproval: true,
		evidence: evidence.slice(-Math.min(evidence.length, minSuccesses + 1)),
	};
}

export function downgradeAfterIncident(currentTier: DelegationTier, incident: IncidentLevel): TrustIncidentAction {
	if (incident === "none") {
		return { incident, nextTier: currentTier, requiresReview: false, reason: "no incident" };
	}
	if (incident === "L1") {
		return { incident, nextTier: currentTier, requiresReview: true, reason: "log and review minor reversible issue" };
	}
	if (incident === "L2") {
		return {
			incident,
			nextTier: currentTier === "tier0" ? "tier1" : "tier2",
			requiresReview: true,
			reason: "recoverable damage moves the operation to a more restrictive tier",
		};
	}
	return {
		incident,
		nextTier: "tier2",
		requiresReview: true,
		reason: "serious damage requires confirmation-gated operation and postmortem",
	};
}

function tier2(reason: string): DelegationDecision {
	return { tier: "tier2", requiresConfirmation: true, reason };
}

function isTierZero(operation: DelegatedOperation): boolean {
	if (tierZeroKinds.has(operation.kind)) return true;
	const normalizedPath = normalizePath(operation.path);
	return (
		normalizedPath.startsWith("tmp/") ||
		normalizedPath.startsWith("scratch/") ||
		normalizedPath.startsWith("worktree/") ||
		normalizedPath.startsWith("samantha/journal/") ||
		normalizedPath.startsWith("samantha/wants/")
	);
}

function isTierOne(operation: DelegatedOperation): boolean {
	if (!operation.repository || !tierOneRepositories.has(operation.repository)) return false;
	if (operation.branch && protectedBranches.has(operation.branch)) return false;
	return ["docs", "test", "draft-pr", "memory-note", "status-update"].includes(operation.kind);
}

function normalizePath(path: string | undefined): string {
	return path?.replace(/\\/g, "/").replace(/^\/+/, "") ?? "";
}
