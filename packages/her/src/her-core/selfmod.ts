import { meetsMergeCriteria, runSelfmodGate, type SelfModGateHooks, type SelfModRetry } from "./selfmod-gate.ts";
import { appendSelfmodSnapshot } from "./selfmod-ledger.ts";
import { acquireSelfmodLock, releaseSelfmodLock } from "./selfmod-lock.ts";
import { disallowedTargetPaths } from "./selfmod-paths.ts";
import type { SelfModProposal, SelfModRunRecord, SelfModStage } from "./selfmod-types.ts";
import {
	createSelfmodWorktree,
	mergeSelfmodBranch,
	readHead,
	removeSelfmodWorktree,
	type SelfmodGit,
} from "./selfmod-worktree.ts";

export { latestSelfmodRecord, readSelfmodRecords, selfmodLedgerPath } from "./selfmod-ledger.ts";
export type { CheckRollbackOptions, SelfModRollbackResult } from "./selfmod-rollback.ts";
export { checkRollback } from "./selfmod-rollback.ts";
export type {
	SelfModGateResult,
	SelfModMotivation,
	SelfModProposal,
	SelfModRunRecord,
	SelfModStage,
} from "./selfmod-types.ts";
export {
	ANCHOR_PATHS,
	MERGE_CRITERIA,
	ROLLBACK_WATCH_HOURS,
	SELFMOD_ALLOWED_PATHS_V1,
	SELFMOD_LEDGER_PATH,
} from "./selfmod-types.ts";

export interface SelfModHooks extends SelfModGateHooks {
	apply?: (ctx: { branch: string; repoRoot: string; worktreePath: string }) => Promise<void>;
}

export interface RunSelfModOptions {
	git?: SelfmodGit;
	hooks?: SelfModHooks;
	memoryDir: string;
	now?: Date;
	proposal: SelfModProposal;
	repoRoot: string;
	retry?: SelfModRetry;
	worktreeRoot: string;
}

export interface SelfModRunResult {
	outcome: "not-run" | "rejected" | "merged";
	record: SelfModRunRecord;
}

export async function runSelfMod(opts: RunSelfModOptions): Promise<SelfModRunResult> {
	const now = () => (opts.now ?? new Date()).toISOString();
	const anchorCommit = await readHead(opts.repoRoot, opts.git);
	const base = baseRecord(opts.proposal, anchorCommit, now());
	if (opts.proposal.motivation.kind === "idea") {
		return snapshot(opts.memoryDir, base, "start", "not-run");
	}
	if (opts.proposal.motivation.evidenceRef.trim() === "") {
		return snapshot(opts.memoryDir, { ...base, stage: "rejected" }, "start", "rejected");
	}
	const denied = disallowedTargetPaths(opts.proposal.targetPaths);
	if (denied.length > 0) {
		return snapshot(opts.memoryDir, { ...base, stage: "rejected" }, "start", "rejected", {
			allowlistViolations: denied,
			anchorHits: [],
		});
	}
	await appendSelfmodSnapshot(opts.memoryDir, base, "start");
	return continueAfterPropose(opts, base, now);
}

async function continueAfterPropose(
	opts: RunSelfModOptions,
	proposed: SelfModRunRecord,
	now: () => string,
): Promise<SelfModRunResult> {
	const lock = await acquireSelfmodLock({
		by: "selfmod",
		memoryDir: opts.memoryDir,
		now: opts.now,
		reason: opts.proposal.id,
	});
	if (!lock.acquired) return { outcome: "not-run", record: proposed };
	let worktreePath: string | undefined;
	try {
		const tree = await createSelfmodWorktree({
			git: opts.git,
			id: opts.proposal.id,
			repoRoot: opts.repoRoot,
			worktreeRoot: opts.worktreeRoot,
		});
		worktreePath = tree.worktreePath;
		const withTree: SelfModRunRecord = {
			...proposed,
			stage: "worktree",
			worktreePath: tree.worktreePath,
			branch: tree.branch,
			anchorCommit: tree.anchorCommit,
			updatedAt: now(),
		};
		await appendSelfmodSnapshot(opts.memoryDir, withTree, "propose");
		if (opts.hooks?.apply) {
			await opts.hooks.apply({
				branch: tree.branch,
				repoRoot: opts.repoRoot,
				worktreePath: tree.worktreePath,
			});
		}
		const applied: SelfModRunRecord = { ...withTree, stage: "apply", updatedAt: now() };
		await appendSelfmodSnapshot(opts.memoryDir, applied, "worktree");
		const result = await finishGateAndMerge(opts, applied, now);
		await teardownTerminal(opts, result.record);
		return result;
	} catch (error) {
		if (worktreePath) {
			await removeSelfmodWorktree({
				git: opts.git,
				repoRoot: opts.repoRoot,
				worktreePath,
			});
		}
		throw error;
	} finally {
		await releaseSelfmodLock(opts.memoryDir);
	}
}

async function finishGateAndMerge(
	opts: RunSelfModOptions,
	applied: SelfModRunRecord,
	now: () => string,
): Promise<SelfModRunResult> {
	const worktreePath = applied.worktreePath;
	if (!worktreePath || !applied.branch) {
		return snapshot(opts.memoryDir, { ...applied, stage: "rejected", updatedAt: now() }, "apply", "rejected");
	}
	const report = await runSelfmodGate({
		anchorCommit: applied.anchorCommit,
		git: opts.git,
		hooks: opts.hooks,
		memoryDir: opts.memoryDir,
		proposal: opts.proposal,
		retry: opts.retry,
		targetPaths: opts.proposal.targetPaths,
		worktreePath,
	});
	const gated: SelfModRunRecord = { ...applied, stage: "gate", gate: report.gate, updatedAt: now() };
	await appendSelfmodSnapshot(opts.memoryDir, gated, "apply", extraOf(report));
	if (!meetsMergeCriteria(report.gate)) {
		const rejected: SelfModRunRecord = { ...gated, stage: "rejected", updatedAt: now() };
		return snapshot(opts.memoryDir, rejected, "gate", "rejected", extraOf(report));
	}
	const mergeCommit = await mergeSelfmodBranch({
		branch: applied.branch,
		git: opts.git,
		id: opts.proposal.id,
		repoRoot: opts.repoRoot,
	});
	const merged: SelfModRunRecord = { ...gated, stage: "merge", mergeCommit, updatedAt: now() };
	return snapshot(opts.memoryDir, merged, "gate", "merged");
}

function extraOf(report: {
	allowlistViolations: string[];
	anchorHits: string[];
	error?: string;
	errors: string[];
}): Record<string, unknown> {
	const errors = report.errors;
	return {
		allowlistViolations: report.allowlistViolations,
		anchorHits: report.anchorHits,
		...(errors.length > 0 ? { error: errors.join("; "), errors } : {}),
	};
}

async function snapshot(
	memoryDir: string,
	record: SelfModRunRecord,
	from: SelfModStage | "start",
	outcome: SelfModRunResult["outcome"],
	extra?: Record<string, unknown>,
): Promise<SelfModRunResult> {
	await appendSelfmodSnapshot(memoryDir, record, from, extra);
	return { outcome, record };
}

function baseRecord(proposal: SelfModProposal, anchorCommit: string, updatedAt: string): SelfModRunRecord {
	return { proposal, stage: "propose", anchorCommit, updatedAt };
}

async function teardownTerminal(opts: RunSelfModOptions, record: SelfModRunRecord): Promise<void> {
	if (!record.worktreePath) return;
	if (record.stage !== "merge" && record.stage !== "rejected" && record.stage !== "rolledback") return;
	const result = await removeSelfmodWorktree({
		git: opts.git,
		repoRoot: opts.repoRoot,
		worktreePath: record.worktreePath,
	});
	if (result.warning) {
		await appendSelfmodSnapshot(opts.memoryDir, record, record.stage, {
			error: `teardown failed: ${result.warning}`,
		});
	}
}
