import { join, relative } from "node:path";
import { buildCorpus } from "./memory-corpus.ts";
import { StorePaths } from "./paths.ts";
import type { CorpusDoc } from "./retrieval.ts";
import { parseFrontmatter, readText, writeText } from "./store.ts";

const WIKILINK_PATTERN = /\[\[([^\]\r\n]+)\]\]/g;
const ORPHAN_CANDIDATE_KINDS = new Set(["semantic", "world", "topic", "idea"]);

export interface MemoryLintBrokenLink {
	file: string;
	raw: string;
	target: string;
}

export interface MemoryLintOrphan {
	file: string;
	id: string;
}

export interface MemoryLintSupersessionIssue {
	file: string;
	reason: string;
	supersededBy?: string;
}

export interface MemoryLintReport {
	brokenLinks: MemoryLintBrokenLink[];
	counts: {
		brokenLinks: number;
		documents: number;
		orphans: number;
		supersessionIssues: number;
	};
	orphans: MemoryLintOrphan[];
	reportPath: string;
	status: "pass" | "fail";
	supersessionIssues: MemoryLintSupersessionIssue[];
}

interface IndexedDoc extends CorpusDoc {
	memoryPath: string;
	pathTarget: string;
	stem: string;
}

interface CorpusIndex {
	byPathTarget: Map<string, IndexedDoc>;
	byStem: Map<string, IndexedDoc[]>;
	docs: IndexedDoc[];
}

interface ExtractedWikilink {
	raw: string;
	target: string;
}

export async function runMemoryLint(root: string): Promise<MemoryLintReport> {
	const paths = new StorePaths(root);
	const index = buildIndex(paths.root, await buildCorpus(paths));
	const brokenLinks = await findBrokenLinks(paths, index);
	const orphans = findOrphans(index);
	const supersessionIssues = await findSupersessionIssues(paths, index.docs);
	const status = brokenLinks.length === 0 && orphans.length === 0 && supersessionIssues.length === 0 ? "pass" : "fail";
	const report: MemoryLintReport = {
		brokenLinks,
		counts: {
			brokenLinks: brokenLinks.length,
			documents: index.docs.length,
			orphans: orphans.length,
			supersessionIssues: supersessionIssues.length,
		},
		orphans,
		reportPath: "evals/lint.md",
		status,
		supersessionIssues,
	};
	await writeText(join(paths.evals, "lint.md"), renderMemoryLintReport(report));
	return report;
}

export function renderMemoryLintReport(report: MemoryLintReport): string {
	return [
		"# Her Memory Lint",
		"",
		`Status: ${report.status}`,
		`Documents scanned: ${report.counts.documents}`,
		`Broken wikilinks: ${report.counts.brokenLinks}`,
		`Orphan notes: ${report.counts.orphans}`,
		`Supersession issues: ${report.counts.supersessionIssues}`,
		"",
		"## Broken Wikilinks",
		formatBrokenLinks(report.brokenLinks),
		"",
		"## Orphan Notes",
		formatOrphans(report.orphans),
		"",
		"## Supersession Issues",
		formatSupersessionIssues(report.supersessionIssues),
		"",
	].join("\n");
}

function buildIndex(root: string, docs: CorpusDoc[]): CorpusIndex {
	const indexed = docs
		.map((doc) => {
			const memoryPath = toMemoryPath(root, doc.path);
			return {
				...doc,
				memoryPath,
				pathTarget: memoryPath.replace(/\.md$/i, ""),
				stem: memoryPath.replace(/\.md$/i, "").split("/").at(-1) ?? "",
			};
		})
		.sort(compareDocs);
	const byPathTarget = new Map<string, IndexedDoc>();
	const byStem = new Map<string, IndexedDoc[]>();
	for (const doc of indexed) {
		byPathTarget.set(doc.pathTarget, doc);
		const bucket = byStem.get(doc.stem) ?? [];
		bucket.push(doc);
		byStem.set(doc.stem, bucket);
	}
	for (const bucket of byStem.values()) bucket.sort(compareDocs);
	return { byPathTarget, byStem, docs: indexed };
}

async function findBrokenLinks(paths: StorePaths, index: CorpusIndex): Promise<MemoryLintBrokenLink[]> {
	const seen = new Set<string>();
	const broken: MemoryLintBrokenLink[] = [];
	for (const doc of index.docs) {
		for (const link of extractWikilinks(doc.text)) {
			const resolution = await resolveWikilink(paths, index, link.target);
			if (resolution.exists) continue;
			const key = `${doc.memoryPath}\0${link.target}\0${link.raw}`;
			if (seen.has(key)) continue;
			seen.add(key);
			broken.push({ file: doc.memoryPath, raw: link.raw, target: link.target });
		}
	}
	return broken.sort(
		(a, b) => compareString(a.target, b.target) || compareString(a.file, b.file) || compareString(a.raw, b.raw),
	);
}

function findOrphans(index: CorpusIndex): MemoryLintOrphan[] {
	const inbound = new Map(index.docs.map((doc) => [doc.id, 0]));
	for (const source of index.docs) {
		for (const link of extractWikilinks(source.text)) {
			for (const target of resolveCorpusTargets(index, link.target)) {
				if (target.id === source.id) continue;
				inbound.set(target.id, (inbound.get(target.id) ?? 0) + 1);
			}
		}
	}
	return index.docs
		.filter((doc) => ORPHAN_CANDIDATE_KINDS.has(doc.kind) && (inbound.get(doc.id) ?? 0) === 0)
		.map((doc) => ({ file: doc.memoryPath, id: doc.id }))
		.sort((a, b) => compareString(a.id, b.id) || compareString(a.file, b.file));
}

async function findSupersessionIssues(paths: StorePaths, docs: IndexedDoc[]): Promise<MemoryLintSupersessionIssue[]> {
	const issues: MemoryLintSupersessionIssue[] = [];
	for (const doc of docs) {
		if (!doc.pathTarget.startsWith("semantic/")) continue;
		const data = parseFrontmatter(doc.text).data;
		if (data.status !== "superseded") continue;
		const supersededBy = typeof data.superseded_by === "string" ? data.superseded_by.trim() : "";
		if (!supersededBy) {
			issues.push({ file: doc.memoryPath, reason: "missing superseded_by" });
			continue;
		}
		const target = `semantic/${supersededBy}`;
		if (!isSafeMemoryTarget(target) || (await readText(join(paths.semantic, `${supersededBy}.md`))) === undefined) {
			issues.push({
				file: doc.memoryPath,
				reason: `missing target semantic/${supersededBy}.md`,
				supersededBy,
			});
		}
	}
	return issues.sort((a, b) => compareString(a.file, b.file) || compareString(a.reason, b.reason));
}

async function resolveWikilink(
	paths: StorePaths,
	index: CorpusIndex,
	target: string,
): Promise<{ exists: boolean; targets: IndexedDoc[] }> {
	if (target.includes("/")) {
		if (!isSafeMemoryTarget(target)) return { exists: false, targets: [] };
		const targets = resolveCorpusTargets(index, target);
		const exists = (await readText(join(paths.root, `${target}.md`))) !== undefined;
		return { exists, targets };
	}
	const targets = resolveCorpusTargets(index, target);
	return { exists: targets.length > 0, targets };
}

function resolveCorpusTargets(index: CorpusIndex, target: string): IndexedDoc[] {
	if (!target) return [];
	if (target.includes("/")) {
		const doc = index.byPathTarget.get(target);
		return doc ? [doc] : [];
	}
	return index.byStem.get(target) ?? [];
}

function extractWikilinks(text: string): ExtractedWikilink[] {
	const links: ExtractedWikilink[] = [];
	for (const match of text.matchAll(WIKILINK_PATTERN)) {
		const raw = match[1]?.trim() ?? "";
		const target = normalizeWikilinkTarget(raw);
		if (target) links.push({ raw: `[[${raw}]]`, target });
	}
	return links;
}

function normalizeWikilinkTarget(raw: string): string {
	return raw.split("|")[0].split("#")[0].trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
}

function isSafeMemoryTarget(target: string): boolean {
	return target.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function formatBrokenLinks(links: MemoryLintBrokenLink[]): string {
	if (links.length === 0) return "(none)";
	return links.map((link) => `- ${link.file}: ${link.raw} -> ${link.target}`).join("\n");
}

function formatOrphans(orphans: MemoryLintOrphan[]): string {
	if (orphans.length === 0) return "(none)";
	return orphans.map((orphan) => `- ${orphan.id} (${orphan.file})`).join("\n");
}

function formatSupersessionIssues(issues: MemoryLintSupersessionIssue[]): string {
	if (issues.length === 0) return "(none)";
	return issues
		.map((issue) => {
			const target = issue.supersededBy ? `; superseded_by: ${issue.supersededBy}` : "";
			return `- ${issue.file}: ${issue.reason}${target}`;
		})
		.join("\n");
}

function toMemoryPath(root: string, path: string): string {
	return relative(root, path).replace(/\\/g, "/");
}

function compareDocs(a: IndexedDoc, b: IndexedDoc): number {
	return compareString(a.memoryPath, b.memoryPath) || compareString(a.id, b.id);
}

function compareString(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
