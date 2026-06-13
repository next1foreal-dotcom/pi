import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { StorePaths } from "./paths.ts";
import { frontmatter, parseFrontmatter, readText, redactSecrets, writeText } from "./store.ts";

const PROPOSAL_MARKER = "her-scan-proposal";

export const herProposalStatuses = ["open", "accepted", "deferred", "rejected"] as const;
export const herProposalFeedbackVerdicts = ["do", "later", "wrong"] as const;

export type HerProposalStatus = (typeof herProposalStatuses)[number];
export type HerProposalFeedbackVerdict = (typeof herProposalFeedbackVerdicts)[number];
export type HerProposalMode = "normal" | "conservative";

export interface HerProposalFeedback {
	note?: string;
	ts: string;
	verdict: HerProposalFeedbackVerdict;
}

export interface HerProposalRecord {
	created: string;
	evidence: string[];
	feedback: HerProposalFeedback[];
	id: string;
	observation: string;
	path: string;
	source: string;
	status: HerProposalStatus;
	suggestion: string;
	title: string;
	updated: string;
}

export interface RecordHerProposalOptions {
	evidence: string[];
	id?: string;
	now?: string;
	observation: string;
	source?: string;
	suggestion: string;
	title: string;
}

export interface RecordHerProposalFeedbackOptions {
	note?: string;
	now?: string;
	verdict: HerProposalFeedbackVerdict;
}

export interface HerProposalStats {
	accepted: number;
	adoptionRate: number;
	deferred: number;
	open: number;
	rejected: number;
	rejectionStreak: number;
	suggestedMode: HerProposalMode;
	total: number;
}

export async function recordHerProposal(root: string, opts: RecordHerProposalOptions): Promise<HerProposalRecord> {
	const now = opts.now ?? new Date().toISOString();
	const paths = new StorePaths(root);
	await ensureProposalDirs(paths);
	const title = requireNonBlank(redactSecrets(opts.title), "title");
	const id = opts.id ? safeProposalId(opts.id) : makeProposalId(now, title);
	const path = proposalPath(paths, id);
	if (await readText(path)) throw new Error(`Her proposal already exists: ${id}`);
	const proposal: HerProposalRecord = {
		id,
		title,
		observation: requireNonBlank(redactSecrets(opts.observation), "observation"),
		suggestion: requireNonBlank(redactSecrets(opts.suggestion), "suggestion"),
		evidence: opts.evidence.map((item) => requireNonBlank(redactSecrets(item), "evidence")),
		source: redactSecrets(opts.source ?? "her-scan"),
		status: "open",
		feedback: [],
		created: now,
		updated: now,
		path: relativeProposalPath(id),
	};
	await writeProposal(paths, proposal);
	return proposal;
}

export async function recordHerProposalFeedback(
	root: string,
	id: string,
	opts: RecordHerProposalFeedbackOptions,
): Promise<HerProposalRecord> {
	const paths = new StorePaths(root);
	await ensureProposalDirs(paths);
	const proposal = await readProposal(paths, safeProposalId(id));
	const now = opts.now ?? new Date().toISOString();
	const feedback: HerProposalFeedback = {
		verdict: opts.verdict,
		ts: now,
		...(opts.note ? { note: redactSecrets(opts.note.trim()) } : {}),
	};
	proposal.feedback = [...proposal.feedback, feedback];
	proposal.status = statusFromFeedback(opts.verdict);
	proposal.updated = now;
	await writeProposal(paths, proposal);
	return proposal;
}

export async function listHerProposals(root: string, status?: HerProposalStatus): Promise<HerProposalRecord[]> {
	const paths = new StorePaths(root);
	await ensureProposalDirs(paths);
	const entries = (await readdir(paths.scanProposals)).filter((entry) => entry.endsWith(".md")).sort();
	const proposals: HerProposalRecord[] = [];
	for (const entry of entries) proposals.push(await readProposalFile(join(paths.scanProposals, entry)));
	return proposals
		.filter((proposal) => !status || proposal.status === status)
		.sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function summarizeHerProposalStats(root: string): Promise<HerProposalStats> {
	const proposals = await listHerProposals(root);
	const accepted = proposals.filter((proposal) => proposal.status === "accepted").length;
	const deferred = proposals.filter((proposal) => proposal.status === "deferred").length;
	const rejected = proposals.filter((proposal) => proposal.status === "rejected").length;
	const open = proposals.filter((proposal) => proposal.status === "open").length;
	const decided = accepted + deferred + rejected;
	const rejectionStreak = proposalRejectionStreak(proposals);
	return {
		total: proposals.length,
		open,
		accepted,
		deferred,
		rejected,
		adoptionRate: decided === 0 ? 0 : accepted / decided,
		rejectionStreak,
		suggestedMode: rejectionStreak >= 3 ? "conservative" : "normal",
	};
}

async function ensureProposalDirs(paths: StorePaths): Promise<void> {
	await mkdir(paths.scanProposals, { recursive: true });
}

async function readProposal(paths: StorePaths, id: string): Promise<HerProposalRecord> {
	const text = await readText(proposalPath(paths, id));
	if (!text) throw new Error(`Her proposal not found: ${id}`);
	return { ...parseProposal(text, id), path: relativeProposalPath(id) };
}

async function readProposalFile(path: string): Promise<HerProposalRecord> {
	const id = basename(path, ".md");
	return { ...parseProposal((await readText(path)) ?? "", id), path: relativeProposalPath(id) };
}

function parseProposal(text: string, fallbackId: string): HerProposalRecord {
	const marker = new RegExp(`<!-- ${PROPOSAL_MARKER}\\n([\\s\\S]*?)\\n-->`, "m").exec(text);
	if (marker) {
		const parsed = JSON.parse(marker[1] ?? "{}") as HerProposalRecord;
		return { ...parsed, id: parsed.id ?? fallbackId, path: relativeProposalPath(parsed.id ?? fallbackId) };
	}
	const fm = parseFrontmatter(text).data;
	return {
		id: typeof fm.id === "string" ? fm.id : fallbackId,
		title: typeof fm.title === "string" ? fm.title : fallbackId,
		observation: "",
		suggestion: "",
		evidence: [],
		source: typeof fm.source === "string" ? fm.source : "her-scan",
		status: parseProposalStatus(fm.status),
		feedback: [],
		created: typeof fm.created === "string" ? fm.created : "",
		updated: typeof fm.updated === "string" ? fm.updated : "",
		path: relativeProposalPath(fallbackId),
	};
}

async function writeProposal(paths: StorePaths, proposal: HerProposalRecord): Promise<void> {
	await writeText(proposalPath(paths, proposal.id), renderProposal(proposal));
}

function renderProposal(proposal: HerProposalRecord): string {
	const body = [
		`# Proposal: ${proposal.title}`,
		"",
		"## Scan Proposal",
		`I noticed: ${proposal.observation}`,
		`I suggest: ${proposal.suggestion}`,
		"",
		"## Evidence",
		...proposal.evidence.map((item) => `- ${item}`),
		"",
		"## Feedback",
		proposal.feedback.length === 0
			? "(none yet)"
			: proposal.feedback
					.map((item) => `- ${item.ts} ${item.verdict}${item.note ? `: ${item.note}` : ""}`)
					.join("\n"),
		"",
		`<!-- ${PROPOSAL_MARKER}`,
		JSON.stringify(proposal, null, 2),
		"-->",
		"",
	].join("\n");
	return `${frontmatter({
		id: proposal.id,
		type: "her_scan_proposal",
		status: proposal.status,
		title: proposal.title,
		source: proposal.source,
		created: proposal.created,
		updated: proposal.updated,
	})}${body}`;
}

function proposalRejectionStreak(proposals: HerProposalRecord[]): number {
	const feedback = proposals.flatMap((proposal) => proposal.feedback).sort((a, b) => b.ts.localeCompare(a.ts));
	let streak = 0;
	for (const item of feedback) {
		if (item.verdict !== "wrong") break;
		streak++;
	}
	return streak;
}

function statusFromFeedback(verdict: HerProposalFeedbackVerdict): HerProposalStatus {
	if (verdict === "do") return "accepted";
	if (verdict === "later") return "deferred";
	return "rejected";
}

function proposalPath(paths: StorePaths, id: string): string {
	return join(paths.scanProposals, `${id}.md`);
}

function relativeProposalPath(id: string): string {
	return `proposals/scan/${id}.md`;
}

function makeProposalId(now: string, title: string): string {
	const date = now.slice(0, 10) || "proposal";
	const hash = createHash("sha1").update(`${now}:${title}`).digest("hex").slice(0, 8);
	return safeProposalId(`${date}-${slug(title)}-${hash}`);
}

function safeProposalId(id: string): string {
	const safe = id.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(safe)) throw new Error(`invalid Her proposal id: ${id}`);
	return safe;
}

function parseProposalStatus(value: unknown): HerProposalStatus {
	return value === "accepted" || value === "deferred" || value === "rejected" ? value : "open";
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "proposal"
	);
}

function requireNonBlank(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`Her proposal ${label} cannot be blank`);
	return trimmed;
}
