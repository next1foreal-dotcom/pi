import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { markdownEntries } from "./memory-utils.ts";
import { StorePaths } from "./paths.ts";
import { frontmatter, parseFrontmatter, readText, writeNewText } from "./store.ts";

// Dream proposals must not be consumed by Memory.approve(): that path dumps the
// whole file, YAML included, into CONTEXT.md. v1 only writes pending files.

export type DreamSignalKind = "remember-request" | "explicit-correction";

export interface DreamEvidence {
	kind: DreamSignalKind;
	snippet: string;
}

export interface DreamCandidate {
	episodeId: string;
	signal: DreamSignalKind;
	score: number;
	confidence: number;
	evidence: DreamEvidence[];
}

export interface DreamScanWriteSummary {
	scanned: number;
	matched: number;
	written: number;
	skippedIdempotent: number;
	writtenPaths: string[];
	candidates: DreamCandidate[];
}

export interface ScanEpisodesOptions {
	limit?: number;
}

export interface WriteDreamProposalsOptions {
	dryRun?: boolean;
	now?: Date;
}

export interface RunDreamScanOptions extends ScanEpisodesOptions, WriteDreamProposalsOptions {}

const SNIPPET_MAX = 200;
const EVIDENCE_CAP = 12;
const SCORE_REMEMBER = 30;
const SCORE_CORRECTION = 25;

const HEADING_PROPOSAL = "\u63d0\u6848";
const HEADING_EVIDENCE = "\u8bc1\u636e";
const EVIDENCE_DOT = "\u00b7";

// Chinese tokens as escapes so this file stays ASCII-only.
const REMEMBER_PATTERNS: RegExp[] = [
	/\u8bb0\u4f4f/g,
	/\u522b\u5fd8\u4e86/g,
	/\u4ee5\u540e\u90fd/g,
	/\bfrom now on\b/gi,
	/\bremember\b/gi,
	/\balways\b/gi,
];

const CORRECTION_PATTERNS: RegExp[] = [
	/\u4e0d\u5bf9/g,
	/\u4e0d\u662f\u8fd9\u4e2a\u610f\u601d/g,
	/\u4f60\u5e94\u8be5/g,
	/\bactually\b/gi,
	/\bwrong\b/gi,
	/\bnot what I meant\b/gi,
];

export function extractUserBlocks(body: string): string[] {
	const blocks: string[] = [];
	const queryRe = /<user_query>([\s\S]*?)<\/user_query>/gi;
	for (const match of body.matchAll(queryRe)) {
		const text = match[1]?.trim();
		if (text) blocks.push(text);
	}

	const lines = body.split(/\r?\n/);
	let current: string[] | null = null;
	const flush = (): void => {
		if (!current) return;
		const text = current.join("\n").trim();
		if (text) blocks.push(text);
		current = null;
	};
	for (const line of lines) {
		if (/^user\s*:/i.test(line)) {
			flush();
			current = [line.replace(/^user\s*:\s*/i, "")];
			continue;
		}
		if (/^assistant\s*:/i.test(line)) {
			flush();
			continue;
		}
		if (current) current.push(line);
	}
	flush();
	return blocks;
}

export function normalizeSnippet(text: string): string {
	return text.trim().replace(/\s+/g, " ").slice(0, SNIPPET_MAX);
}

function snippetAround(text: string, index: number, length: number): string {
	const lineStart = text.lastIndexOf("\n", index - 1) + 1;
	const lineEndIdx = text.indexOf("\n", index + length);
	const lineEnd = lineEndIdx < 0 ? text.length : lineEndIdx;
	const line = text.slice(lineStart, lineEnd);
	if (line.length <= SNIPPET_MAX) return normalizeSnippet(line);
	const pad = Math.floor((SNIPPET_MAX - length) / 2);
	const start = Math.max(0, index - pad);
	return normalizeSnippet(text.slice(start, start + SNIPPET_MAX));
}

function collectMatches(userText: string, kind: DreamSignalKind, patterns: RegExp[]): DreamEvidence[] {
	const found: DreamEvidence[] = [];
	const seen = new Set<string>();
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		for (const match of userText.matchAll(pattern)) {
			const index = match.index ?? 0;
			const snippet = snippetAround(userText, index, match[0].length);
			if (!snippet || seen.has(snippet)) continue;
			seen.add(snippet);
			found.push({ kind, snippet });
			if (found.length >= EVIDENCE_CAP) return found;
		}
	}
	return found;
}

export function detectSignals(userText: string): DreamEvidence[] {
	return [
		...collectMatches(userText, "remember-request", REMEMBER_PATTERNS),
		...collectMatches(userText, "explicit-correction", CORRECTION_PATTERNS),
	];
}

function pickSignal(evidence: DreamEvidence[]): DreamSignalKind {
	const remember = evidence.filter((item) => item.kind === "remember-request").length;
	const correction = evidence.filter((item) => item.kind === "explicit-correction").length;
	const rememberScore = remember * SCORE_REMEMBER;
	const correctionScore = correction * SCORE_CORRECTION;
	if (correctionScore > rememberScore) return "explicit-correction";
	return "remember-request";
}

function scoreEvidence(evidence: DreamEvidence[]): number {
	let score = 0;
	for (const item of evidence) {
		score += item.kind === "remember-request" ? SCORE_REMEMBER : SCORE_CORRECTION;
	}
	return score;
}

function episodeIdFrom(data: Record<string, unknown>, filename: string): string {
	if (typeof data.id === "string" && data.id.trim()) return data.id.trim();
	return filename.replace(/\.md$/, "");
}

export async function scanEpisodes(rawDir: string, opts: ScanEpisodesOptions = {}): Promise<DreamCandidate[]> {
	const names = await markdownEntries(rawDir);
	const newestFirst = [...names].reverse();
	const selected = opts.limit === undefined ? newestFirst : newestFirst.slice(0, opts.limit);
	const candidates: DreamCandidate[] = [];
	for (const name of selected) {
		const text = await readText(join(rawDir, name));
		if (text === undefined) continue;
		const parsed = parseFrontmatter(text);
		const blocks = extractUserBlocks(parsed.body);
		if (blocks.length === 0) continue;
		const evidence: DreamEvidence[] = [];
		const seen = new Set<string>();
		for (const block of blocks) {
			for (const item of detectSignals(block)) {
				const key = `${item.kind}\0${item.snippet}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const kindCount = evidence.filter((entry) => entry.kind === item.kind).length;
				if (kindCount >= EVIDENCE_CAP) continue;
				evidence.push(item);
			}
		}
		if (evidence.length === 0) continue;
		const score = scoreEvidence(evidence);
		candidates.push({
			episodeId: episodeIdFrom(parsed.data, name),
			signal: pickSignal(evidence),
			score,
			confidence: Math.min(100, score),
			evidence,
		});
	}
	return candidates;
}

function slugFromEpisodeId(episodeId: string): string {
	return (
		episodeId
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "episode"
	);
}

function formatScanDate(now: Date): string {
	const year = String(now.getFullYear()).padStart(4, "0");
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}${month}${day}`;
}

function buildProposalBody(candidate: DreamCandidate): string {
	const statement =
		candidate.signal === "remember-request"
			? "User asked the agent to remember something."
			: "User corrected the agent.";
	const lines = candidate.evidence.map((item) => `- ${candidate.episodeId} ${EVIDENCE_DOT} ${item.snippet}`);
	return [`## ${HEADING_PROPOSAL}`, statement, "", `## ${HEADING_EVIDENCE}`, ...lines, ""].join("\n");
}

async function existingDreamEpisodeIds(proposalsDir: string): Promise<Set<string>> {
	const ids = new Set<string>();
	let names: string[];
	try {
		names = await readdir(proposalsDir);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ids;
		throw error;
	}
	for (const name of names) {
		if (!name.startsWith("dream-") || !name.endsWith(".md")) continue;
		const parsed = parseFrontmatter(await readText(join(proposalsDir, name)));
		const sources = parsed.data.sources;
		if (!Array.isArray(sources)) continue;
		for (const source of sources) {
			if (typeof source === "string" && source.trim()) ids.add(source.trim());
		}
	}
	return ids;
}

async function allocateDreamPath(proposalsDir: string, dateStamp: string, slug: string): Promise<string> {
	const first = join(proposalsDir, `dream-${dateStamp}-${slug}.md`);
	if ((await readText(first)) === undefined) return first;
	for (let suffix = 2; suffix < 1000; suffix++) {
		const path = join(proposalsDir, `dream-${dateStamp}-${slug}-${suffix}.md`);
		if ((await readText(path)) === undefined) return path;
	}
	throw new Error(`could not allocate dream proposal filename for ${slug}`);
}

export async function writeDreamProposals(
	candidates: DreamCandidate[],
	proposalsDir: string,
	opts: WriteDreamProposalsOptions = {},
): Promise<Pick<DreamScanWriteSummary, "written" | "skippedIdempotent" | "writtenPaths">> {
	const now = opts.now ?? new Date();
	const dateStamp = formatScanDate(now);
	const existingIds = await existingDreamEpisodeIds(proposalsDir);
	let written = 0;
	let skippedIdempotent = 0;
	const writtenPaths: string[] = [];
	for (const candidate of candidates) {
		if (existingIds.has(candidate.episodeId)) {
			skippedIdempotent += 1;
			continue;
		}
		if (opts.dryRun) {
			continue;
		}
		const path = await allocateDreamPath(proposalsDir, dateStamp, slugFromEpisodeId(candidate.episodeId));
		const text = `${frontmatter({
			kind: "dream-proposal",
			signal: candidate.signal,
			status: "pending",
			confidence: candidate.confidence,
			risk: "low",
			sources: [candidate.episodeId],
			created: now.toISOString(),
		})}${buildProposalBody(candidate)}`;
		await writeNewText(path, text);
		existingIds.add(candidate.episodeId);
		written += 1;
		writtenPaths.push(path);
	}
	return { written, skippedIdempotent, writtenPaths };
}

export async function countRawEpisodes(rawDir: string, limit?: number): Promise<number> {
	const names = await markdownEntries(rawDir);
	if (limit === undefined) return names.length;
	return Math.min(limit, names.length);
}

export async function runDreamScan(root: string, opts: RunDreamScanOptions = {}): Promise<DreamScanWriteSummary> {
	const paths = new StorePaths(root);
	const scanned = await countRawEpisodes(paths.raw, opts.limit);
	const candidates = await scanEpisodes(paths.raw, { limit: opts.limit });
	const write = await writeDreamProposals(candidates, paths.proposals, {
		dryRun: opts.dryRun,
		now: opts.now,
	});
	return {
		scanned,
		matched: candidates.length,
		written: opts.dryRun ? 0 : write.written,
		skippedIdempotent: write.skippedIdempotent,
		writtenPaths: write.writtenPaths,
		candidates,
	};
}
