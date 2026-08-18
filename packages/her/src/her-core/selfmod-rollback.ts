import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { appendSelfmodSnapshot, latestSelfmodRecord, readSelfmodRecords } from "./selfmod-ledger.ts";
import type { SelfModRunRecord } from "./selfmod-types.ts";
import { ROLLBACK_WATCH_HOURS } from "./selfmod-types.ts";
import { revertSelfmodMerge, type SelfmodGit } from "./selfmod-worktree.ts";
import { readText } from "./store.ts";

export interface CheckRollbackOptions {
	git?: SelfmodGit;
	id: string;
	memoryDir: string;
	now?: Date;
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
	const pulseEvidence = await findPulseEvidence(opts.memoryDir, current);
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
	return { action: "reverted", record };
}

function windowClosed(mergedAt: string, now: Date): boolean {
	const start = Date.parse(mergedAt);
	if (Number.isNaN(start)) return false;
	return now.getTime() - start > ROLLBACK_WATCH_HOURS * 60 * 60 * 1000;
}

async function findPulseEvidence(memoryDir: string, record: SelfModRunRecord): Promise<string | undefined> {
	const dir = join(memoryDir, "organs");
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return undefined;
	}
	const needles = [record.proposal.id, ...record.proposal.targetPaths];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const text = await readText(join(dir, name));
		if (!text) continue;
		const hit = scanOrganText(text, needles);
		if (hit) return hit;
	}
	return undefined;
}

function scanOrganText(text: string, needles: string[]): string | undefined {
	for (const line of text.split(/\n/)) {
		if (line.trim() === "") continue;
		if (!lineIsRed(line)) continue;
		if (needles.some((needle) => line.includes(needle))) return line;
	}
	return undefined;
}

function lineIsRed(line: string): boolean {
	try {
		const value: unknown = JSON.parse(line);
		if (!value || typeof value !== "object") return false;
		const rec = value as Record<string, unknown>;
		return rec.ok === false || rec.status === "red" || rec.pulse === "red";
	} catch {
		return false;
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
