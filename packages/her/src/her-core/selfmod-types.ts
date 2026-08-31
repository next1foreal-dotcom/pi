import { ANCHOR_PATHS, SELFMOD_ALLOWED_PATHS_V1 } from "../rsi/anchors.ts";

export { ANCHOR_PATHS, SELFMOD_ALLOWED_PATHS_V1 };

// Source: Her-repo/docs/specs/her-rsi-contracts/selfmod.ts.
// Lives outside the selfmod allowlist (and outside the hook-protected anchors.ts)
// so she cannot expand her own fence. Updating this list is an our-side commit.
export const SELFMOD_OWNED_SKILLS: readonly string[] = [
	"her-batch-intake",
	"her-design",
	"her-hands-desktop",
	"her-intake",
	"her-jina-read",
	"her-scan",
	"her-skill-sharpen",
	"her-status-brief",
	"her-telegram-bridge-smoke",
];

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
	patch?: string;
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

export const SELFMOD_PATCH_MAX_BYTES = 64 * 1024;
