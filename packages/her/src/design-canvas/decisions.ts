import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
import type { Thread } from "./feed.ts";

export interface CanvasDecision {
	id: string;
	at: string;
	noteId: string;
	screenId: string | null;
	his: string;
	hers: string;
}

export interface RuleProposal {
	id: string;
	at: string;
	rule: string;
	from: string[];
	status: "pending";
}

export interface RecordDecisionOpts {
	repoRoot?: string;
	now?: () => string;
}

function decisionsPath(repoRoot: string): string {
	return join(repoRoot, "design", "canvas", "decisions.jsonl");
}

function proposalsPath(repoRoot: string): string {
	return join(repoRoot, "design", "canvas", "rule-proposals.jsonl");
}

function rootOf(repoRoot?: string): string {
	return repoRoot ?? SAMANTHA_REPO_ROOT;
}

function newRecordId(prefix: "d" | "p"): string {
	let hex = "";
	while (hex.length < 12) hex += Math.floor(Math.random() * 16).toString(16);
	return `${prefix}_${hex.slice(0, 12)}`;
}

function appendJsonl(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function readJsonl<T>(file: string, guard: (value: unknown) => value is T): T[] {
	if (!existsSync(file)) return [];
	const out: T[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (guard(parsed)) out.push(parsed);
		} catch {
			// torn line — skip it
		}
	}
	return out;
}

function isDecision(value: unknown): value is CanvasDecision {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.at === "string" &&
		typeof row.noteId === "string" &&
		(row.screenId === null || typeof row.screenId === "string") &&
		typeof row.his === "string" &&
		typeof row.hers === "string"
	);
}

function isProposal(value: unknown): value is Pick<RuleProposal, "from"> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return Array.isArray(row.from) && row.from.every((id) => typeof id === "string");
}

function lastSamanthaReply(thread: Thread): string {
	for (let i = thread.replies.length - 1; i >= 0; i--) {
		const reply = thread.replies[i];
		if (reply && reply.author === "samantha") return reply.text;
	}
	return "";
}

function allDecisions(repoRoot: string): CanvasDecision[] {
	return readJsonl(decisionsPath(repoRoot), isDecision);
}

function digestedIds(repoRoot: string): Set<string> {
	const ids = new Set<string>();
	for (const proposal of readJsonl(proposalsPath(repoRoot), isProposal)) {
		for (const id of proposal.from) ids.add(id);
	}
	return ids;
}

/** Decisions not yet named by any rule proposal. */
export function pendingDecisions(repoRoot?: string): CanvasDecision[] {
	const root = rootOf(repoRoot);
	try {
		const used = digestedIds(root);
		return allDecisions(root).filter((row) => !used.has(row.id));
	} catch {
		return [];
	}
}

/**
 * Fold same-screen opinions into one candidate rule. Fewer than 3 related
 * notes is not a rule — a single complaint is not a taste.
 *
 * Pure: no I/O, no model.
 */
export function proposeRule(decisions: CanvasDecision[]): { rule: string; from: string[] } | null {
	const groups = new Map<string, CanvasDecision[]>();
	const order: string[] = [];
	for (const row of decisions) {
		const key = row.screenId ?? "";
		const existing = groups.get(key);
		if (existing) {
			existing.push(row);
		} else {
			groups.set(key, [row]);
			order.push(key);
		}
	}

	for (const key of order) {
		const group = groups.get(key);
		if (!group || group.length < 3) continue;
		const seen = new Set<string>();
		const unique: string[] = [];
		for (const row of group) {
			const norm = row.his.trim().toLowerCase();
			if (seen.has(norm)) continue;
			seen.add(norm);
			unique.push(row.his.trim());
		}
		const where = key || "the canvas";
		return {
			rule: `On ${where}: ${unique.join(" | ")}`,
			from: group.map((row) => row.id),
		};
	}
	return null;
}

function maybePropose(repoRoot: string, now: () => string): void {
	const proposed = proposeRule(pendingDecisions(repoRoot));
	if (!proposed) return;
	const record: RuleProposal = {
		id: newRecordId("p"),
		at: now(),
		rule: proposed.rule,
		from: proposed.from,
		status: "pending",
	};
	appendJsonl(proposalsPath(repoRoot), record);
}

/**
 * Append one resolved thread to the decision log. If enough related opinions
 * have piled up, write a pending rule proposal. Never writes a skill file.
 */
export function recordResolvedDecision(thread: Thread, hers: string | undefined, opts: RecordDecisionOpts = {}): void {
	const repoRoot = rootOf(opts.repoRoot);
	const now = opts.now ?? (() => new Date().toISOString());
	const decision: CanvasDecision = {
		id: newRecordId("d"),
		at: now(),
		noteId: thread.id,
		screenId: thread.screenId,
		his: thread.text,
		hers: hers !== undefined ? hers : lastSamanthaReply(thread),
	};
	appendJsonl(decisionsPath(repoRoot), decision);
	maybePropose(repoRoot, now);
}
