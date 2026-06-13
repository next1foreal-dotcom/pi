import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { frontmatter, parseFrontmatter, readText, redactSecrets, writeText } from "./store.ts";

const RETRACTION_MARKER = "her-memory-retraction";
const mutableSearchDirs = [
	"semantic",
	"world",
	"choice-model",
	"topics",
	"ideas",
	"goals",
	"tasks",
	"proposals",
	"samantha",
	"narrative",
];

export interface MemoryRetractionCandidate {
	mutable: boolean;
	path: string;
	reason: "target" | "mentions-target";
	retracted: boolean;
}

export interface MemoryRetractionPlan {
	candidates: MemoryRetractionCandidate[];
	rawAppendOnly: boolean;
	reason: string;
	recordPath: string;
	target: string;
	updated: string;
}

export interface PlanMemoryRetractionOptions {
	now?: string;
	path: string;
	reason: string;
}

export interface ApplyMemoryRetractionOptions extends PlanMemoryRetractionOptions {
	confirm?: boolean;
}

export interface MemoryRetractionResult extends MemoryRetractionPlan {
	applied: boolean;
	skipped: string[];
	updatedFiles: string[];
}

export async function planMemoryRetraction(
	root: string,
	opts: PlanMemoryRetractionOptions,
): Promise<MemoryRetractionPlan> {
	const updated = opts.now ?? new Date().toISOString();
	const target = safeRelativeRef(root, opts.path);
	if (target === "narrative/FACTS.md") throw new Error("narrative/FACTS.md can only be changed by Fei");
	if (!(await readText(resolve(root, target)))) throw new Error(`memory path not found: ${target}`);
	const reason = requireNonBlank(redactSecrets(opts.reason), "reason");
	const candidates = await findRetractionCandidates(root, target);
	return {
		target,
		reason,
		updated,
		rawAppendOnly: target.startsWith("episodic/raw/"),
		candidates,
		recordPath: retractionRecordPath(target, updated),
	};
}

export async function applyMemoryRetraction(
	root: string,
	opts: ApplyMemoryRetractionOptions,
): Promise<MemoryRetractionResult> {
	if (!opts.confirm) throw new Error("memory retraction requires confirm=true");
	const plan = await planMemoryRetraction(root, opts);
	const updatedFiles: string[] = [];
	const skipped: string[] = [];
	for (const candidate of plan.candidates) {
		if (!candidate.mutable) {
			skipped.push(candidate.path);
			continue;
		}
		if (candidate.retracted) {
			skipped.push(candidate.path);
			continue;
		}
		await markRetracted(root, candidate.path, plan);
		updatedFiles.push(candidate.path);
	}
	await writeRetractionRecord(root, plan, updatedFiles, skipped);
	return { ...plan, applied: true, updatedFiles, skipped };
}

async function findRetractionCandidates(root: string, target: string): Promise<MemoryRetractionCandidate[]> {
	const found = new Map<string, MemoryRetractionCandidate>();
	found.set(target, {
		path: target,
		reason: "target",
		mutable: isMutableMemoryPath(target),
		retracted: await fileIsRetracted(root, target),
	});
	for (const dir of mutableSearchDirs) {
		for (const file of await listMarkdownUnder(root, dir)) {
			if (file === target || file === "narrative/FACTS.md") continue;
			const text = (await readText(resolve(root, file))) ?? "";
			if (!mentionsTarget(text, target)) continue;
			found.set(file, {
				path: file,
				reason: "mentions-target",
				mutable: isMutableMemoryPath(file),
				retracted: await fileIsRetracted(root, file),
			});
		}
	}
	return [...found.values()].sort((a, b) => {
		if (a.path === target) return -1;
		if (b.path === target) return 1;
		return a.path.localeCompare(b.path);
	});
}

async function markRetracted(root: string, path: string, plan: MemoryRetractionPlan): Promise<void> {
	const absolute = resolve(root, path);
	const parsed = parseFrontmatter(await readText(absolute));
	const data = {
		...parsed.data,
		retracted: true,
		retracted_at: plan.updated,
		retracted_source: plan.target,
		retraction_reason: plan.reason,
	};
	const body = parsed.body.includes("## Retraction")
		? parsed.body
		: `${parsed.body.trimEnd()}\n\n## Retraction\n\nRetracted ${plan.updated}: ${plan.reason}\n`;
	await writeText(absolute, `${frontmatter(data)}${body}`);
}

async function writeRetractionRecord(
	root: string,
	plan: MemoryRetractionPlan,
	updatedFiles: string[],
	skipped: string[],
): Promise<void> {
	const path = resolve(root, plan.recordPath);
	const lines = [
		frontmatter({
			type: "her_memory_retraction",
			target: plan.target,
			updated: plan.updated,
			raw_append_only: plan.rawAppendOnly,
		}).trimEnd(),
		"",
		`# Memory Retraction: ${plan.target}`,
		"",
		`Reason: ${plan.reason}`,
		"",
		"## Updated",
		...(updatedFiles.length ? updatedFiles.map((file) => `- ${file}`) : ["- (none)"]),
		"",
		"## Skipped",
		...(skipped.length ? skipped.map((file) => `- ${file}`) : ["- (none)"]),
		"",
		`<!-- ${RETRACTION_MARKER}`,
		JSON.stringify({ plan, updatedFiles, skipped }, null, 2),
		"-->",
		"",
	];
	await writeText(path, lines.join("\n"));
}

async function fileIsRetracted(root: string, path: string): Promise<boolean> {
	const parsed = parseFrontmatter(await readText(resolve(root, path)));
	return parsed.data.retracted === true;
}

function mentionsTarget(text: string, target: string): boolean {
	const stem = basename(target, extname(target));
	const wiki = `[[${stem}]]`;
	return text.includes(target) || text.includes(wiki);
}

function isMutableMemoryPath(path: string): boolean {
	return !path.startsWith("episodic/raw/") && path !== "narrative/FACTS.md";
}

function retractionRecordPath(target: string, updated: string): string {
	const date = updated.slice(0, 10) || "retraction";
	const stem = basename(target, extname(target)).replace(/[^a-zA-Z0-9._-]+/g, "-");
	const fallback = createHash("sha256").update(target).digest("hex").slice(0, 8);
	return `retractions/${date}-${stem || fallback}.md`;
}

async function listMarkdownUnder(root: string, dir: string): Promise<string[]> {
	const absolute = resolve(root, dir);
	const entries = await readdir(absolute, { withFileTypes: true }).catch((error: unknown) => {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	});
	const files: string[] = [];
	for (const entry of entries) {
		const entryPath = join(absolute, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listMarkdownUnder(root, relativeFromRoot(root, entryPath))));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".md")) files.push(relativeFromRoot(root, entryPath));
	}
	return files.sort();
}

function safeRelativeRef(root: string, ref: string): string {
	const resolved = resolve(root, ref);
	const relativePath = relativeFromRoot(root, resolved);
	if (relativePath.startsWith("..") || relativePath === "") throw new Error(`memory ref escapes root: ${ref}`);
	return relativePath;
}

function relativeFromRoot(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function requireNonBlank(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${field} cannot be blank`);
	return trimmed;
}
