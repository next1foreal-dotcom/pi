import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Memory } from "./memory.ts";
import { StorePaths } from "./paths.ts";
import { parseFrontmatter, readText } from "./store.ts";

export type PriorMode = "full" | "off" | "her-only";
export type PriorLayer = "L1" | "L2" | "L3" | "L4" | "L5" | "S";

export interface PriorBlock {
	layer: PriorLayer;
	source: string;
	text: string;
	tokens: number;
}

export interface PriorResult {
	text: string;
	priorId: string;
	blocks: PriorBlock[];
}

export interface AssemblePriorOptions {
	budget?: number;
	mode: PriorMode;
	storeRoot: string;
	task?: string;
}

export interface ResolvePriorModeOptions {
	defaultMode?: PriorMode;
	env?: Pick<NodeJS.ProcessEnv, "HER_PRIOR">;
	requestedMode?: PriorMode;
	sessionMode?: PriorMode;
}

export interface PriorAuditEntry {
	action: string;
	blocks: Array<Pick<PriorBlock, "layer" | "source" | "tokens">>;
	mode: PriorMode;
	priorId: string;
	ts: string;
}

export interface RecordPriorAuditOptions {
	action: string;
	mode?: PriorMode;
	prior: PriorResult;
	ts?: string;
}

export function resolvePriorMode(opts: ResolvePriorModeOptions = {}): PriorMode {
	if (opts.env?.HER_PRIOR?.trim().toLowerCase() === "off") return "off";
	return opts.requestedMode ?? opts.sessionMode ?? opts.defaultMode ?? "full";
}

export function priorModeForAction(writeTargets: string[], opts: ResolvePriorModeOptions = {}): PriorMode {
	const mode = resolvePriorMode(opts);
	if (mode === "off") return "off";
	return writeTargets.some(isSamanthaTarget) && mode === "full" ? "her-only" : mode;
}

export async function recordPriorAudit(storeRoot: string, opts: RecordPriorAuditOptions): Promise<PriorAuditEntry> {
	const ts = opts.ts ?? new Date().toISOString();
	const entry: PriorAuditEntry = {
		action: opts.action,
		blocks: opts.prior.blocks.map((block) => ({ layer: block.layer, source: block.source, tokens: block.tokens })),
		mode: opts.mode ?? inferPriorMode(opts.prior),
		priorId: opts.prior.priorId,
		ts,
	};
	const auditDir = join(storeRoot, "audit");
	const auditFile = join(auditDir, `${ts.slice(0, 10)}.jsonl`);
	try {
		await mkdir(auditDir, { recursive: true });
		await appendFile(auditFile, `${JSON.stringify(entry)}\n`, "utf8");
	} catch (error) {
		throw new Error(
			`prior audit append failed for ${auditFile}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return entry;
}

interface SourceBlock {
	layer: PriorLayer;
	source: string;
	text: string;
}

const DEFAULT_TOTAL_BUDGET = 3300;
const LAYER_BUDGETS: Partial<Record<PriorLayer, number>> = { L3: 900, L4: 400, L5: 700 };
const TRIM_ORDER: PriorLayer[] = ["L5", "L4", "L3"];

export async function assemblePrior(opts: AssemblePriorOptions): Promise<PriorResult> {
	if (opts.mode === "off") return { text: "", priorId: "off", blocks: [] };
	const paths = new StorePaths(opts.storeRoot);
	const sourceBlocks = opts.mode === "her-only" ? await readSBlocks(paths) : await readFullBlocks(paths, opts.task);
	const blocks = applyBudget(sourceBlocks, opts.budget ?? DEFAULT_TOTAL_BUDGET);
	return {
		blocks,
		priorId: priorId(sourceBlocks, opts),
		text: renderPriorText(blocks),
	};
}

export function estimatePriorTokens(text: string): number {
	const trimmed = text.trim();
	// ponytail: chars/4 is the spec-approved cheap estimate; swap in a tokenizer only if budget drift becomes measurable.
	return trimmed ? Math.ceil(trimmed.length / 4) : 0;
}

function isSamanthaTarget(path: string): boolean {
	const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
	return normalized === "samantha" || normalized.startsWith("samantha/") || normalized.includes("/samantha/");
}

function inferPriorMode(prior: PriorResult): PriorMode {
	if (prior.priorId === "off") return "off";
	return prior.blocks.every((block) => block.layer === "S") ? "her-only" : "full";
}
async function readFullBlocks(paths: StorePaths, task?: string): Promise<SourceBlock[]> {
	return [
		...(await readFileBlock(paths.factsFile, "L1", "narrative/FACTS.md")),
		...(await readFileBlock(paths.contextFile, "L2", "narrative/CONTEXT.md")),
		...(await readMarkdownDirBlocks(paths.choiceModelDir, "L3", "choice-model")),
		...(await readMarkdownDirBlocks(paths.topics, "L4", "topics")),
		...(await readMarkdownDirBlocks(join(paths.goals, "active"), "L4", "goals/active")),
		...(await readRecallBlocks(paths.root, task)),
		...(await readSBlocks(paths)),
	];
}

async function readFileBlock(path: string, layer: PriorLayer, source: string): Promise<SourceBlock[]> {
	const text = ((await readText(path)) ?? "").trim();
	return text ? [{ layer, source, text }] : [];
}

async function readMarkdownDirBlocks(dir: string, layer: PriorLayer, sourceDir: string): Promise<SourceBlock[]> {
	const entries = await markdownEntries(dir);
	const blocks: SourceBlock[] = [];
	for (const entry of entries) {
		const text = ((await readText(join(dir, entry))) ?? "").trim();
		if (text) blocks.push({ layer, source: `${sourceDir}/${entry}`, text });
	}
	return blocks;
}

async function readRecallBlocks(storeRoot: string, task?: string): Promise<SourceBlock[]> {
	if (!task?.trim()) return [];
	const hits = await new Memory(storeRoot).recall(task, { k: 5, recordAccess: false });
	return hits.map((hit) => ({
		layer: "L5" as const,
		source: hit.id,
		text: `[[${hit.id}]]\n${hit.text.trim()}`,
	}));
}

async function readSBlocks(paths: StorePaths): Promise<SourceBlock[]> {
	const entries = await markdownEntries(paths.samanthaTaste);
	const blocks: SourceBlock[] = [];
	for (const entry of entries) {
		const text = (await readText(join(paths.samanthaTaste, entry))) ?? "";
		const parsed = parseFrontmatter(text);
		if (parsed.data.prior !== true) continue;
		const prefix =
			parsed.data.differs_from_fei_rule === true
				? "Attribution: Samantha taste; Fei-rule difference retained.\n\n"
				: "Attribution: Samantha taste.\n\n";
		blocks.push({ layer: "S", source: `samantha/taste/${entry}`, text: `${prefix}${parsed.body.trim()}`.trim() });
	}
	return blocks.length > 0 ? blocks : [{ layer: "S", source: "samantha/taste/*.md", text: "" }];
}

async function markdownEntries(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((entry) => entry.endsWith(".md")).sort((a, b) => a.localeCompare(b));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

function applyBudget(blocks: SourceBlock[], totalBudget: number): PriorBlock[] {
	let capped = blocks.flatMap((block) => trimBlock(block, LAYER_BUDGETS[block.layer] ?? Infinity));
	let over = totalTokens(capped) - Math.max(0, Math.floor(totalBudget));
	for (const layer of TRIM_ORDER) {
		if (over <= 0) break;
		const layerTokens = totalTokens(capped.filter((block) => block.layer === layer));
		const target = Math.max(0, layerTokens - over);
		const trimmedLayer = trimBlocks(
			capped.filter((block) => block.layer === layer),
			target,
		);
		over -= layerTokens - totalTokens(trimmedLayer);
		capped = replaceLayer(capped, layer, trimmedLayer);
	}
	return capped;
}

function trimBlocks(blocks: PriorBlock[], budget: number): PriorBlock[] {
	let remaining = budget;
	return blocks.flatMap((block) => {
		const trimmed = trimText(block.text, remaining);
		const tokens = estimatePriorTokens(trimmed);
		remaining -= tokens;
		if (!trimmed && block.layer !== "S") return [];
		return [{ ...block, text: trimmed, tokens }];
	});
}

function trimBlock(block: SourceBlock, budget: number): PriorBlock[] {
	const text = trimText(block.text, budget);
	if (!text && block.layer !== "S") return [];
	return [{ ...block, text, tokens: estimatePriorTokens(text) }];
}

function trimText(text: string, budget: number): string {
	const trimmed = text.trim();
	if (!trimmed || budget <= 0) return "";
	if (estimatePriorTokens(trimmed) <= budget) return trimmed;
	return trimmed.slice(0, Math.max(0, Math.floor(budget) * 4)).trimEnd();
}

function replaceLayer(blocks: PriorBlock[], layer: PriorLayer, replacement: PriorBlock[]): PriorBlock[] {
	let inserted = false;
	const out: PriorBlock[] = [];
	for (const block of blocks) {
		if (block.layer !== layer) {
			out.push(block);
			continue;
		}
		if (!inserted) out.push(...replacement);
		inserted = true;
	}
	return out;
}

function totalTokens(blocks: PriorBlock[]): number {
	return blocks.reduce((sum, block) => sum + block.tokens, 0);
}

function renderPriorText(blocks: PriorBlock[]): string {
	return blocks
		.map((block) => `<!-- prior:${block.layer} ${block.source} -->${block.text ? `\n${block.text}` : ""}`)
		.join("\n\n")
		.trimEnd();
}

function priorId(blocks: SourceBlock[], opts: AssemblePriorOptions): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				budget: opts.budget ?? DEFAULT_TOTAL_BUDGET,
				mode: opts.mode,
				sources: blocks.map((block) => ({ layer: block.layer, source: block.source, hash: hashText(block.text) })),
				task: hashText(opts.task ?? ""),
			}),
		)
		.digest("hex")
		.slice(0, 12);
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
