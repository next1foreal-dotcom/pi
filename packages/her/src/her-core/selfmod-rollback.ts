import { eventHistoryPath, type HistoryEvent, isEventKind } from "./event-history.ts";
import { git as defaultGit } from "./memory-utils.ts";
import { appendSelfmodSnapshot, latestSelfmodRecord, readSelfmodRecords } from "./selfmod-ledger.ts";
import { acquireSelfmodLock, releaseSelfmodLock } from "./selfmod-lock.ts";
import type { SelfModRunRecord } from "./selfmod-types.ts";
import { ROLLBACK_WATCH_HOURS } from "./selfmod-types.ts";
import { removeSelfmodWorktree, revertSelfmodMerge, type SelfmodGit, selfmodRefName } from "./selfmod-worktree.ts";
import { readText } from "./store.ts";

export interface CheckRollbackOptions {
	git?: SelfmodGit;
	id: string;
	memoryDir: string;
	now?: Date;
	readHistoryText?: (memoryDir: string) => Promise<string>;
	repoRoot: string;
}
export interface SelfModRollbackResult {
	action: "reverted" | "window-closed" | "watching" | "noop" | "busy" | "needs-evidence";
	record: SelfModRunRecord;
}

export async function checkRollback(opts: CheckRollbackOptions): Promise<SelfModRollbackResult> {
	// Share the adoption lock; historical observation clocks must not expire a live lease.
	const lock = await acquireSelfmodLock({ memoryDir: opts.memoryDir, by: "selfmod-rollback", reason: opts.id });
	if (!lock.acquired)
		return {
			action: "busy",
			record: latestSelfmodRecord(await readSelfmodRecords(opts.memoryDir), opts.id) ?? missingRecord(opts.id),
		};
	try {
		return await checkLocked(opts);
	} finally {
		await releaseSelfmodLock(opts.memoryDir);
	}
}

async function checkLocked(opts: CheckRollbackOptions): Promise<SelfModRollbackResult> {
	const rows = await readSelfmodRecords(opts.memoryDir);
	const current = latestSelfmodRecord(rows, opts.id);
	if (!current || current.stage !== "merge" || !current.mergeCommit) {
		return { action: "noop", record: current ?? missingRecord(opts.id) };
	}
	// A durable intent precedes Git. An interruption/conflict requires reconciliation,
	// never a blind second revert, even if the first revert already committed.
	if (current.rollbackCheck?.status === "prepared" || current.rollbackCheck?.status === "failed") {
		return { action: "needs-evidence", record: current };
	}
	const now = opts.now ?? new Date();
	const adopted = rows.find(
		(row) => row.stage === "merge" && row.proposal.id === opts.id && row.mergeCommit === current.mergeCommit,
	);
	const start = timestamp(adopted?.updatedAt);
	if (!Number.isFinite(start) || !Number.isFinite(now.getTime()) || start > now.getTime()) {
		return pending(opts, current, "invalid adoption or observation time");
	}
	if (now.getTime() - start > ROLLBACK_WATCH_HOURS * 60 * 60 * 1000)
		return { action: "window-closed", record: current };
	const text = opts.readHistoryText
		? await opts.readHistoryText(opts.memoryDir)
		: ((await readText(eventHistoryPath(opts.memoryDir))) ?? "");
	const evidence = scanHistory(text, current, start, now.getTime());
	if (!evidence.pulse) {
		return evidence.reason ? pending(opts, current, evidence.reason) : { action: "watching", record: current };
	}
	const git = opts.git ?? defaultGit;
	try {
		if ((await git(opts.repoRoot, "status", "--porcelain")).stdout.trim())
			throw new Error("working tree is not clean");
		const tag = (await git(opts.repoRoot, "rev-parse", `refs/tags/${selfmodRefName(opts.id)}`)).stdout.trim();
		if (tag !== current.mergeCommit) throw new Error("adoption tag does not match ledger");
		await git(opts.repoRoot, "merge-base", "--is-ancestor", current.mergeCommit, "HEAD");
		const parents = (await git(opts.repoRoot, "rev-list", "--parents", "-n", "1", current.mergeCommit)).stdout
			.trim()
			.split(/\s+/);
		if (parents.length !== 2 || parents[1] !== current.anchorCommit)
			throw new Error("multi-commit adoption requires manual rollback");
		const changed = (
			await git(opts.repoRoot, "diff", "--name-only", "-z", current.anchorCommit, current.mergeCommit)
		).stdout
			.split("\0")
			.filter(Boolean);
		if (!changed.length || changed.some((path) => !current.proposal.targetPaths.includes(path)))
			throw new Error("adopted diff contains unbound targets");
		if ((await git(opts.repoRoot, "diff", current.mergeCommit, "HEAD", "--", ...current.proposal.targetPaths)).stdout)
			throw new Error("targets changed after adoption");
	} catch (error) {
		return pending(opts, current, message(error), evidence.pulse);
	}
	const intent = {
		at: new Date().toISOString(),
		status: "prepared" as const,
		reason: "revert intent persisted",
		pulseEvidence: evidence.pulse,
	};
	const prepared: SelfModRunRecord = { ...current, rollbackCheck: intent };
	await appendSelfmodSnapshot(opts.memoryDir, prepared, "merge", { rollbackCheck: prepared.rollbackCheck });
	let revertCommit: string;
	try {
		revertCommit = await revertSelfmodMerge({ git, mergeCommit: current.mergeCommit, repoRoot: opts.repoRoot });
		if (
			(await git(opts.repoRoot, "diff", current.anchorCommit, revertCommit, "--", ...current.proposal.targetPaths))
				.stdout
		)
			throw new Error("reverted target bytes differ from adoption baseline");
	} catch (error) {
		const failed: SelfModRunRecord = {
			...prepared,
			rollbackCheck: { ...intent, status: "failed", reason: message(error) },
		};
		await appendSelfmodSnapshot(opts.memoryDir, failed, "merge", { rollbackCheck: failed.rollbackCheck });
		return { action: "needs-evidence", record: failed };
	}
	const record: SelfModRunRecord = {
		...current,
		stage: "rolledback",
		rollbackCheck: undefined,
		rollback: { at: now.toISOString(), revertCommit, pulseEvidence: evidence.pulse },
		updatedAt: now.toISOString(),
	};
	await appendSelfmodSnapshot(opts.memoryDir, record, "merge", { pulseEvidence: evidence.pulse, revertCommit });
	if (record.worktreePath) {
		const teardown = await removeSelfmodWorktree({
			branch: record.branch ?? selfmodRefName(opts.id),
			git,
			repoRoot: opts.repoRoot,
			worktreePath: record.worktreePath,
		});
		if (teardown.warning)
			await appendSelfmodSnapshot(opts.memoryDir, record, "rolledback", {
				error: `teardown failed: ${teardown.warning}`,
			});
	}
	return { action: "reverted", record };
}

async function pending(
	opts: CheckRollbackOptions,
	current: SelfModRunRecord,
	reason: string,
	pulseEvidence?: string,
): Promise<SelfModRollbackResult> {
	const previous = current.rollbackCheck;
	if (previous?.status === "needs-evidence" && previous.reason === reason && previous.pulseEvidence === pulseEvidence)
		return { action: "needs-evidence", record: current };
	// Keep updatedAt (adoption time) intact: polling must not extend the watch window.
	const record: SelfModRunRecord = {
		...current,
		rollbackCheck: {
			at: new Date().toISOString(),
			status: "needs-evidence",
			reason,
			...(pulseEvidence ? { pulseEvidence } : {}),
		},
	};
	await appendSelfmodSnapshot(opts.memoryDir, record, "merge", { rollbackCheck: record.rollbackCheck });
	return { action: "needs-evidence", record };
}

// ponytail: open-run correlation is quadratic; index actor/runId if history size makes scans slow.
function scanHistory(
	text: string,
	record: SelfModRunRecord,
	adopted: number,
	now: number,
): { pulse?: string; reason?: string } {
	const events: HistoryEvent[] = [];
	let reason: string | undefined;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const event = parseEvent(line);
		if (event) events.push(event);
		else reason = "unreadable history observation";
	}
	for (const event of events) {
		const time = timestamp(event.ts);
		if (!Number.isFinite(time) || time > now) {
			reason ??= "invalid or future observation time";
			continue;
		}
		if (time <= adopted || event.derived) continue;
		const failure =
			event.data?.ok === false &&
			(event.kind === "organ.round.end" ||
				(event.kind === "host.run.end" && Number.isInteger(event.data.exitCode) && event.data.exitCode !== 0));
		const open =
			event.kind === "organ.round.start" &&
			!events.some(
				(end) =>
					end.kind === "organ.round.end" &&
					end.actor === event.actor &&
					end.data?.runId === event.data?.runId &&
					timestamp(end.ts) >= time &&
					timestamp(end.ts) <= now,
			);
		if (!failure && !open) continue;
		if (!matchesAdoption(event, record)) {
			reason ??= "observation lacks exact adoption identity";
			continue;
		}
		if (open) {
			reason ??= "unfinished task is not a confirmed crash";
			continue;
		}
		const planned = events.some(
			(plan) =>
				plan.kind === "host.restart_planned" &&
				timestamp(plan.ts) > adopted &&
				timestamp(plan.ts) <= time &&
				((plan.actor === event.actor && plan.data?.runId === event.data?.runId) ||
					(plan.actor === "drain-cli" &&
						plan.data?.source === "drain" &&
						typeof plan.data.ttlMinutes === "number" &&
						time <= timestamp(plan.ts) + plan.data.ttlMinutes * 60_000)),
		);
		if (planned) {
			reason ??= "planned restart requires review";
			continue;
		}
		return { pulse: JSON.stringify(event) };
	}
	return { reason };
}

// Only the trusted host can bind observations to the adopted skill. Existing
// generic organ error text carries no such identity and remains pending review.
function matchesAdoption(event: HistoryEvent, record: SelfModRunRecord): boolean {
	const refs = object(event.refs);
	const binding = object(refs?.selfmod);
	const paths = binding?.targetPaths;
	return (
		typeof event.data?.runId === "string" &&
		event.data.runId.length > 0 &&
		binding?.proposalId === record.proposal.id &&
		binding.mergeCommit === record.mergeCommit &&
		Array.isArray(paths) &&
		paths.length === record.proposal.targetPaths.length &&
		new Set(paths).size === paths.length &&
		paths.every((path) => typeof path === "string" && record.proposal.targetPaths.includes(path))
	);
}
function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function timestamp(value: unknown): number {
	if (typeof value !== "string") return NaN;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}
function parseEvent(line: string): HistoryEvent | undefined {
	try {
		const rec = object(JSON.parse(line));
		if (
			!rec ||
			typeof rec.id !== "string" ||
			typeof rec.ts !== "string" ||
			typeof rec.actor !== "string" ||
			typeof rec.kind !== "string" ||
			!isEventKind(rec.kind)
		)
			return undefined;
		if (rec.data !== undefined && !object(rec.data)) return undefined;
		return {
			id: rec.id,
			ts: rec.ts,
			kind: rec.kind,
			actor: rec.actor,
			refs: rec.refs,
			data: object(rec.data),
			derived: rec.derived === true,
		};
	} catch {
		return undefined;
	}
}
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function missingRecord(id: string): SelfModRunRecord {
	return {
		proposal: {
			id,
			createdAt: new Date(0).toISOString(),
			motivation: { kind: "idea", evidenceRef: "" },
			targetPaths: [],
			planSummary: "",
		},
		stage: "propose",
		anchorCommit: "",
		updatedAt: new Date(0).toISOString(),
	};
}
