import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type ChapterChunk, splitChapters } from "./chapter-split.ts";
import {
	createStrategicReadingPrompt,
	DEEP_READER_ALLOWED_TOOLS,
	DEEP_READER_PROFILE_PATH,
	type StrategicReadingPromptInput,
} from "./prompts-reading.ts";

export type CompendiumMaterial = {
	id: string;
	sourceUrl: string;
	text: string;
};

export type CompendiumManifest = {
	slug: string;
	materials: readonly CompendiumMaterial[];
};

export type ReaderTask = {
	agentProfilePath: typeof DEEP_READER_PROFILE_PATH;
	tools: readonly string[];
	prompt: string;
	materialId: string;
	sourceUrl: string;
	chunk: ChapterChunk;
};

export type ReaderSpawner = (task: ReaderTask) => Promise<string>;

export type DeerParallel = <T>(tasks: readonly (() => Promise<T>)[]) => Promise<Array<T | null>>;

export type FanoutInput = {
	manifest: CompendiumManifest;
	question: string;
	herMemoryRoot: string;
	spawn: ReaderSpawner;
	deerParallel: DeerParallel;
	concurrency?: number;
};

export type FailedChunk = {
	materialId: string;
	chunkIndex: number;
	charRange: readonly [number, number];
	reason: string;
};

export type FanoutResult = {
	analysisDirectory: string;
	written: string[];
	failed: FailedChunk[];
};

type PendingChunk = { task: ReaderTask; outputPath: string };
type AttemptResult = { item: PendingChunk; analysis?: string; error?: string };

const DEFAULT_CONCURRENCY = 4;

export async function fanoutCompendium(input: FanoutInput): Promise<FanoutResult> {
	validateInput(input);
	const analysisDirectory = join(input.herMemoryRoot, ".her", "compendium", input.manifest.slug, "analysis");
	await mkdir(analysisDirectory, { recursive: true });
	const tasks = buildPendingChunks(input.manifest, input.question, analysisDirectory);
	const written: string[] = [];
	const failed: FailedChunk[] = [];
	for (const batch of partition(tasks, input.concurrency ?? DEFAULT_CONCURRENCY)) {
		const initial = await runBatch(batch, input.spawn, input.deerParallel);
		await persistSuccessful(initial, written);
		const retries = await runBatch(
			initial.filter(isFailed).map((result) => result.item),
			input.spawn,
			input.deerParallel,
		);
		await persistSuccessful(retries, written);
		failed.push(...retries.filter(isFailed).map(toFailedChunk));
	}
	await writeFile(join(analysisDirectory, "failed.json"), JSON.stringify(failed, null, 2), "utf8");
	return { analysisDirectory, written, failed };
}

export function buildReaderTask(material: CompendiumMaterial, chunk: ChapterChunk, question: string): ReaderTask {
	const promptInput: StrategicReadingPromptInput = {
		question,
		sourceUrl: material.sourceUrl,
		materialId: material.id,
		chunk,
	};
	return {
		agentProfilePath: DEEP_READER_PROFILE_PATH,
		tools: DEEP_READER_ALLOWED_TOOLS,
		prompt: createStrategicReadingPrompt(promptInput),
		materialId: material.id,
		sourceUrl: material.sourceUrl,
		chunk,
	};
}

function validateInput(input: FanoutInput): void {
	if (!input.question.trim()) throw new Error("question must not be blank");
	if (!input.herMemoryRoot.trim()) throw new Error("herMemoryRoot must not be blank");
	if (
		!Number.isSafeInteger(input.concurrency ?? DEFAULT_CONCURRENCY) ||
		(input.concurrency ?? DEFAULT_CONCURRENCY) < 1
	)
		throw new Error("concurrency must be a positive integer");
	validateSegment(input.manifest.slug, "manifest slug");
	for (const material of input.manifest.materials) validateMaterial(material);
}

function validateMaterial(material: CompendiumMaterial): void {
	validateSegment(material.id, "material id");
	if (!material.sourceUrl.trim()) throw new Error(`material ${material.id} sourceUrl must not be blank`);
	if (!material.text) throw new Error(`material ${material.id} text must not be blank`);
}

function validateSegment(value: string, label: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`${label} must be a safe filename segment`);
}

function buildPendingChunks(manifest: CompendiumManifest, question: string, analysisDirectory: string): PendingChunk[] {
	return manifest.materials.flatMap((material) =>
		splitChapters(material.text).map((chunk) => ({
			task: buildReaderTask(material, chunk, question),
			outputPath: join(analysisDirectory, `${material.id}-${chunk.index}.md`),
		})),
	);
}

async function runBatch(
	items: PendingChunk[],
	spawn: ReaderSpawner,
	deerParallel: DeerParallel,
): Promise<AttemptResult[]> {
	const results = await deerParallel(items.map((item) => () => spawnAnalysis(item, spawn)));
	return results.map((result, index) => result ?? { item: items[index], error: "parallel task failed" });
}

async function spawnAnalysis(item: PendingChunk, spawn: ReaderSpawner): Promise<AttemptResult> {
	try {
		const analysis = validateAnalysis(await spawn(item.task));
		return { item, analysis };
	} catch (error) {
		return { item, error: error instanceof Error ? error.message : String(error) };
	}
}

function validateAnalysis(analysis: string): string {
	if (!analysis.trim()) throw new Error("reader returned empty analysis");
	const frontMatter = analysis.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!frontMatter) throw new Error("reader analysis must start with YAML front matter");
	for (const field of ["source", "chunk", "lens-version"]) {
		if (!new RegExp(`^${field}:`, "m").test(frontMatter[1]))
			throw new Error(`reader analysis YAML is missing ${field}`);
	}
	return analysis;
}
function isFailed(result: AttemptResult): boolean {
	return result.analysis === undefined;
}

async function persistSuccessful(results: AttemptResult[], written: string[]): Promise<void> {
	for (const result of results) {
		if (result.analysis === undefined) continue;
		await writeFile(result.item.outputPath, result.analysis, "utf8");
		written.push(result.item.outputPath);
	}
}

function toFailedChunk(result: AttemptResult): FailedChunk {
	return {
		materialId: result.item.task.materialId,
		chunkIndex: result.item.task.chunk.index,
		charRange: result.item.task.chunk.charRange,
		reason: result.error ?? "reader failed without an error message",
	};
}

function partition<T>(items: readonly T[], size: number): T[][] {
	const batches: T[][] = [];
	for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
	return batches;
}
