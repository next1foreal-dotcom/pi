import { ANCHOR_PATHS, SELFMOD_ALLOWED_PATHS_V1 } from "../rsi/anchors.ts";

export { ANCHOR_PATHS, SELFMOD_ALLOWED_PATHS_V1 };

export type SelfModStage = "propose" | "worktree" | "apply" | "gate" | "merge" | "rolledback" | "rejected";

export interface SelfModMotivation {
	kind: "failure-anchored" | "idea";
	evidenceRef: string;
}

export interface SelfModProposal {
	id: string;
	createdAt: string;
	motivation: SelfModMotivation;
	targetPaths: string[];
	planSummary: string;
}

export interface SelfModGateResult {
	typecheckExit: number;
	testsPassed: number;
	testsFailed: number;
	evalGateFixturesPassed: boolean;
	anchorScanClean: boolean;
	encodingScanClean: boolean;
}

export interface SelfModRunRecord {
	proposal: SelfModProposal;
	stage: SelfModStage;
	worktreePath?: string;
	branch?: string;
	gate?: SelfModGateResult;
	mergeCommit?: string;
	anchorCommit: string;
	rollback?: { at: string; revertCommit: string; pulseEvidence: string };
	updatedAt: string;
}

export const SELFMOD_LEDGER_PATH = "her-memory/audit/selfmod.jsonl";

export const MERGE_CRITERIA = {
	typecheckExit: 0,
	testsFailed: 0,
	evalGateFixturesPassed: true,
	anchorScanClean: true,
	encodingScanClean: true,
} as const;

export const ROLLBACK_WATCH_HOURS = 24;
