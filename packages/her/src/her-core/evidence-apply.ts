import { join } from "node:path";
import { slug, today } from "./memory-utils.ts";
import { StorePaths } from "./paths.ts";
import { frontmatter, parseFrontmatter, readText, writeNewText, writeText } from "./store.ts";

// Dream proposals must not go through the CONTEXT writer on Memory: that path
// writes the whole file, YAML included, into CONTEXT.md. This module is the
// only consumer.

export type DreamProposalStatus = "pending" | "applied" | "rejected";

export interface DreamApplyResult {
	proposalId: string;
	status: DreamProposalStatus;
	written: boolean;
	skippedIdempotent: boolean;
	semanticPath?: string;
}

export interface DreamApplyOptions {
	dryRun?: boolean;
	now?: Date;
}

function normalizeDreamProposalId(raw: string): string {
	const stem = raw.trim().replace(/\.md$/i, "");
	if (!stem.startsWith("dream-")) {
		throw new Error(`not a dream proposal id: ${raw}`);
	}
	return stem;
}

function proposalPath(paths: StorePaths, proposalId: string): string {
	return join(paths.proposals, `${proposalId}.md`);
}

async function loadDreamProposal(
	paths: StorePaths,
	rawId: string,
): Promise<{ id: string; path: string; data: Record<string, unknown>; body: string }> {
	const id = normalizeDreamProposalId(rawId);
	const path = proposalPath(paths, id);
	const text = await readText(path);
	if (text === undefined) throw new Error(`no dream proposal: ${id}`);
	const parsed = parseFrontmatter(text);
	if (parsed.data.kind !== "dream-proposal") {
		throw new Error(`not a dream proposal: ${id}`);
	}
	return { id, path, data: parsed.data, body: parsed.body };
}

function currentStatus(data: Record<string, unknown>): DreamProposalStatus {
	const status = data.status;
	if (status === "applied" || status === "rejected" || status === "pending") return status;
	return "pending";
}

function semanticKey(data: Record<string, unknown>, proposalId: string): string {
	const sources = Array.isArray(data.sources) ? data.sources.filter((item) => typeof item === "string") : [];
	const seed = typeof sources[0] === "string" && sources[0].trim() ? sources[0] : proposalId;
	return `dream-${slug(seed)}`;
}

function rewriteProposal(data: Record<string, unknown>, body: string): string {
	return `${frontmatter(data)}${body.endsWith("\n") ? body : `${body}\n`}`;
}

export async function applyDreamProposal(
	root: string,
	rawId: string,
	opts: DreamApplyOptions = {},
): Promise<DreamApplyResult> {
	const paths = new StorePaths(root);
	const proposal = await loadDreamProposal(paths, rawId);
	const status = currentStatus(proposal.data);
	if (status === "applied") {
		return { proposalId: proposal.id, status, written: false, skippedIdempotent: true };
	}
	if (status === "rejected") {
		throw new Error(`dream proposal already rejected: ${proposal.id}`);
	}

	const key = semanticKey(proposal.data, proposal.id);
	const semanticPath = join(paths.semantic, `${key}.md`);
	if ((await readText(semanticPath)) !== undefined) {
		throw new Error(`semantic note already exists: ${key}`);
	}

	if (opts.dryRun) {
		return { proposalId: proposal.id, status: "pending", written: false, skippedIdempotent: false, semanticPath };
	}

	const now = opts.now ?? new Date();
	const sources = Array.isArray(proposal.data.sources)
		? proposal.data.sources.filter((item) => typeof item === "string")
		: [];
	const note = `${frontmatter({
		id: key,
		type: "note",
		tier: "summarizable",
		created: today(),
		sources,
		dream_proposal: proposal.id,
		signal: proposal.data.signal ?? "remember-request",
	})}${proposal.body.endsWith("\n") ? proposal.body : `${proposal.body}\n`}`;
	await writeNewText(semanticPath, note);

	proposal.data.status = "applied";
	proposal.data.applied_at = now.toISOString();
	proposal.data.applied_note = key;
	await writeText(proposal.path, rewriteProposal(proposal.data, proposal.body));

	return { proposalId: proposal.id, status: "applied", written: true, skippedIdempotent: false, semanticPath };
}

export async function rejectDreamProposal(
	root: string,
	rawId: string,
	opts: DreamApplyOptions = {},
): Promise<DreamApplyResult> {
	const paths = new StorePaths(root);
	const proposal = await loadDreamProposal(paths, rawId);
	const status = currentStatus(proposal.data);
	if (status === "rejected") {
		return { proposalId: proposal.id, status, written: false, skippedIdempotent: true };
	}
	if (status === "applied") {
		throw new Error(`dream proposal already applied: ${proposal.id}`);
	}

	if (opts.dryRun) {
		return { proposalId: proposal.id, status: "pending", written: false, skippedIdempotent: false };
	}

	const now = opts.now ?? new Date();
	proposal.data.status = "rejected";
	proposal.data.rejected_at = now.toISOString();
	await writeText(proposal.path, rewriteProposal(proposal.data, proposal.body));

	return { proposalId: proposal.id, status: "rejected", written: true, skippedIdempotent: false };
}
