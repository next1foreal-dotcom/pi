import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
import type { Thread } from "./feed.ts";

/** Where a decision was overheard. Absent on rows written before the split. */
export type DecisionSource = "canvas" | "conversation";

export interface CanvasDecision {
	id: string;
	at: string;
	/**
	 * The note it came off, or null when he said it in conversation.
	 *
	 * Until 2026-09-10 the only way into this ledger was resolving a canvas
	 * note, so everything he said in an ordinary conversation — which is most of
	 * what he says — left no trace. doop names the reason in its own tool:
	 * "you are the only one who hears your own conversation". The canvas can
	 * capture what happens on the canvas; the rest only she can report.
	 */
	noteId: string | null;
	screenId: string | null;
	his: string;
	hers: string;
	source?: DecisionSource;
}

export type ProposalStatus = "pending" | "accepted" | "declined";

/** One pair from the record: what he objected to, and what she did about it. */
export interface DecisionPair {
	his: string;
	hers: string;
}

export interface RuleProposal {
	id: string;
	at: string;
	screenId: string | null;
	/**
	 * The raw material, not a rule.
	 *
	 * An earlier version joined his complaints with " | " and called the result
	 * a taste rule. It was a transcript wearing a rule's name, and it looked
	 * finished — tests green, ledger written, the reminder firing — while
	 * producing nothing anyone could act on. A pure function cannot generalise
	 * taste out of natural language, and the answer is not to call a model:
	 * she is the model, and she is the one reading this. Naming the pattern is
	 * her job, in front of him, where he can say yes or no to it.
	 */
	items: DecisionPair[];
	from: string[];
	status: ProposalStatus;
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
		// null is a conversation row, and a reader that only accepted strings
		// dropped every one of them on the way back in — the tool would have
		// answered "recorded" while the ledger stayed empty.
		(row.noteId === null || typeof row.noteId === "string") &&
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

function isRuleProposal(value: unknown): value is RuleProposal {
	if (!isProposal(value)) return false;
	const row = value as Record<string, unknown>;
	// `items` is what makes a proposal readable. A row without it is either
	// corrupt or written by the version that put a joined string in `rule`, and
	// either way there is nothing to show her — skip it here, explicitly,
	// rather than letting it throw its way into the caller's catch and take a
	// whole reminder down silently.
	const items = row.items;
	return (
		typeof row.id === "string" &&
		typeof row.at === "string" &&
		Array.isArray(items) &&
		items.length > 0 &&
		items.every(
			(item) =>
				!!item &&
				typeof item === "object" &&
				typeof (item as { his?: unknown }).his === "string" &&
				typeof (item as { hers?: unknown }).hers === "string",
		) &&
		(row.status === "pending" || row.status === "accepted" || row.status === "declined")
	);
}

/**
 * Latest state of each proposal, oldest-first by first appearance.
 * A later line with the same id is a status change, not a rewrite.
 */
export function proposalStates(repoRoot?: string): RuleProposal[] {
	const root = rootOf(repoRoot);
	try {
		const latest = new Map<string, RuleProposal>();
		const order: string[] = [];
		for (const row of readJsonl(proposalsPath(root), isRuleProposal)) {
			if (!latest.has(row.id)) order.push(row.id);
			latest.set(row.id, row);
		}
		return order.flatMap((id) => {
			const row = latest.get(id);
			return row ? [row] : [];
		});
	} catch {
		return [];
	}
}

function appendProposalStatus(id: string, status: "accepted" | "declined", repoRoot?: string): void {
	const root = rootOf(repoRoot);
	const current = proposalStates(root).find((row) => row.id === id);
	if (!current) return;
	appendJsonl(proposalsPath(root), {
		...current,
		status,
		at: new Date().toISOString(),
	});
}

/** Append a status-change line. Does not rewrite the original pending row. */
export function acceptProposal(id: string, repoRoot?: string): void {
	appendProposalStatus(id, "accepted", repoRoot);
}

/** Append a status-change line. Does not rewrite the original pending row. */
export function declineProposal(id: string, repoRoot?: string): void {
	appendProposalStatus(id, "declined", repoRoot);
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
export function proposeRule(
	decisions: CanvasDecision[],
): { screenId: string | null; items: DecisionPair[]; from: string[] } | null {
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
		const items: DecisionPair[] = [];
		for (const row of group) {
			const norm = row.his.trim().toLowerCase();
			if (seen.has(norm)) continue;
			seen.add(norm);
			items.push({ his: row.his.trim(), hers: row.hers.trim() });
		}
		return {
			screenId: key || null,
			items,
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
		screenId: proposed.screenId,
		items: proposed.items,
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
		source: "canvas",
	};
	appendJsonl(decisionsPath(repoRoot), decision);
	maybePropose(repoRoot, now);
}

/**
 * A taste he stated in conversation, and what she did about it.
 *
 * The pair is the same shape the canvas path writes, so both feed one ledger
 * and one proposal loop — a rule that only ever formed out of canvas notes was
 * being asked to generalise from the smaller half of the evidence.
 *
 * `screenId` is optional because a conversation is often about the work rather
 * than about one screen ("stop using italic serif" is not about a screen). A
 * decision with no screen groups with the other screenless ones, which is the
 * right neighbourhood for a preference that spans the whole canvas.
 */
export function recordConversationDecision(
	his: string,
	hers: string,
	screenId: string | null = null,
	opts: RecordDecisionOpts = {},
): CanvasDecision {
	const repoRoot = rootOf(opts.repoRoot);
	const now = opts.now ?? (() => new Date().toISOString());
	const decision: CanvasDecision = {
		id: newRecordId("d"),
		at: now(),
		noteId: null,
		screenId,
		his,
		hers,
		source: "conversation",
	};
	appendJsonl(decisionsPath(repoRoot), decision);
	maybePropose(repoRoot, now);
	return decision;
}
