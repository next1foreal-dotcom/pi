import { basename } from "node:path";
import { detectPresumedCrashes, eventHistoryPath, type HistoryEvent } from "./event-history.ts";
import { appendSelfmodSnapshot, latestSelfmodRecord, readSelfmodRecords } from "./selfmod-ledger.ts";
import type { SelfModRunRecord } from "./selfmod-types.ts";
import { ROLLBACK_WATCH_HOURS } from "./selfmod-types.ts";
import { removeSelfmodWorktree, revertSelfmodMerge, type SelfmodGit } from "./selfmod-worktree.ts";
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
	action: "reverted" | "window-closed" | "watching" | "noop";
	record: SelfModRunRecord;
}

export async function checkRollback(opts: CheckRollbackOptions): Promise<SelfModRollbackResult> {
	const rows = await readSelfmodRecords(opts.memoryDir);
	const current = latestSelfmodRecord(rows, opts.id);
	if (!current || current.stage !== "merge" || !current.mergeCommit) {
		return { action: "noop", record: current ?? missingRecord(opts.id) };
	}
	const now = opts.now ?? new Date();
	if (windowClosed(current.updatedAt, now)) {
		return { action: "window-closed", record: current };
	}
	const pulseEvidence = await findPulseEvidence(opts.memoryDir, current, opts.readHistoryText);
	if (!pulseEvidence) return { action: "watching", record: current };
	const revertCommit = await revertSelfmodMerge({
		git: opts.git,
		mergeCommit: current.mergeCommit,
		repoRoot: opts.repoRoot,
	});
	const record: SelfModRunRecord = {
		...current,
		stage: "rolledback",
		rollback: { at: now.toISOString(), revertCommit, pulseEvidence },
		updatedAt: now.toISOString(),
	};
	await appendSelfmodSnapshot(opts.memoryDir, record, "merge", { pulseEvidence, revertCommit });
	if (record.worktreePath) {
		const teardown = await removeSelfmodWorktree({
			git: opts.git,
			repoRoot: opts.repoRoot,
			worktreePath: record.worktreePath,
		});
		if (teardown.warning) {
			await appendSelfmodSnapshot(opts.memoryDir, record, "rolledback", {
				error: `teardown failed: ${teardown.warning}`,
			});
		}
	}
	return { action: "reverted", record };
}

function windowClosed(mergedAt: string, now: Date): boolean {
	const start = Date.parse(mergedAt);
	if (Number.isNaN(start)) return false;
	return now.getTime() - start > ROLLBACK_WATCH_HOURS * 60 * 60 * 1000;
}

async function findPulseEvidence(
	memoryDir: string,
	record: SelfModRunRecord,
	readHistoryText?: (memoryDir: string) => Promise<string>,
): Promise<string | undefined> {
	const text = readHistoryText
		? await readHistoryText(memoryDir)
		: ((await readText(eventHistoryPath(memoryDir))) ?? "");
	return scanHistoryText(text, record);
}

function scanHistoryText(text: string, record: SelfModRunRecord): string | undefined {
	const needles = pulseNeedles(record);
	const events: HistoryEvent[] = [];
	for (const line of text.split(/\n/)) {
		if (line.trim() === "") continue;
		const event = parseHistoryLineLoose(line);
		if (event) events.push(event);
		if (event?.kind === "organ.round.end" && organEndIsRed(event.data) && lineMatches(line, needles)) {
			return line;
		}
	}
	for (const derived of detectPresumedCrashes(events)) {
		if (derived.kind !== "organ.presumed_crash") continue;
		const blob = JSON.stringify(derived);
		if (lineMatches(blob, needles)) return blob;
	}
	return undefined;
}

function organEndIsRed(data?: Record<string, unknown>): boolean {
	if (!data) return false;
	if (data.ok === false) return true;
	if (data.error !== undefined && data.error !== null && data.error !== "") return true;
	return false;
}

function pulseNeedles(record: SelfModRunRecord): string[] {
	const paths = record.proposal.targetPaths;
	const names = paths.map((path) => basename(path.replace(/\\/g, "/")));
	return [record.proposal.id, ...paths, ...names].filter((needle) => needle.length > 0);
}

function lineMatches(line: string, needles: string[]): boolean {
	return needles.some((needle) => line.includes(needle));
}

function parseHistoryLineLoose(line: string): HistoryEvent | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (!value || typeof value !== "object") return undefined;
		const rec = value as Record<string, unknown>;
		if (typeof rec.id !== "string" || typeof rec.ts !== "string" || typeof rec.actor !== "string") return undefined;
		if (typeof rec.kind !== "string") return undefined;
		const event: HistoryEvent = {
			id: rec.id,
			ts: rec.ts,
			kind: rec.kind as HistoryEvent["kind"],
			actor: rec.actor,
		};
		if (rec.data !== undefined) {
			if (!rec.data || typeof rec.data !== "object" || Array.isArray(rec.data)) return undefined;
			event.data = rec.data as Record<string, unknown>;
		}
		return event;
	} catch {
		return undefined;
	}
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
