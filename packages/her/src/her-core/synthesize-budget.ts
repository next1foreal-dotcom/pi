import { stat } from "node:fs/promises";
import { join } from "node:path";
import { markdownEntries } from "./memory-utils.ts";
import { readText } from "./store.ts";

/** dsh compaction-basic default: trigger / pack against 80% of the model window. */
export const SYNTHESIZE_PACK_RATIO = 0.8;
/** Same chars/4 heuristic dsh uses; Her does not add a tokenizer. */
export const CHARS_PER_TOKEN = 4;
export const DEFAULT_SYNTHESIZE_WINDOW_TOKENS = 128_000;
export const DEFAULT_SYNTHESIZE_MAX_TOKENS = 8_192;

export type SemanticNoteRecord = {
	key: string;
	text: string;
	mtimeMs: number;
};

export type SynthesizeSkip = {
	key: string;
	chars: number;
	score: number;
	mtimeMs: number;
};

export type PackedSynthesizeNotes = {
	packed: string;
	selected: SemanticNoteRecord[];
	omitted: SynthesizeSkip[];
	usedChars: number;
};

export function synthesizeLimits(env: NodeJS.ProcessEnv = process.env): {
	windowTokens: number;
	maxTokens: number;
} {
	return {
		windowTokens: envPositiveInt(env, "HER_SYNTHESIZE_WINDOW_TOKENS", DEFAULT_SYNTHESIZE_WINDOW_TOKENS),
		maxTokens: envPositiveInt(env, "HER_SYNTHESIZE_MAX_TOKENS", DEFAULT_SYNTHESIZE_MAX_TOKENS),
	};
}

/** Semantic-note budget after reserving the rest of the synthesize prompt and the output cap. */
export function synthesizeNoteBudgetChars(opts: {
	reservedChars: number;
	windowTokens?: number;
	maxTokens?: number;
}): number {
	const windowTokens = opts.windowTokens ?? DEFAULT_SYNTHESIZE_WINDOW_TOKENS;
	const maxTokens = opts.maxTokens ?? DEFAULT_SYNTHESIZE_MAX_TOKENS;
	const availableTokens = Math.floor(windowTokens * SYNTHESIZE_PACK_RATIO) - maxTokens;
	const availableChars = Math.max(0, availableTokens) * CHARS_PER_TOKEN;
	return Math.max(0, availableChars - Math.max(0, opts.reservedChars));
}

export async function listSemanticNotes(dir: string): Promise<SemanticNoteRecord[]> {
	const entries = await markdownEntries(dir);
	const notes: SemanticNoteRecord[] = [];
	for (const entry of entries) {
		const path = join(dir, entry);
		let mtimeMs = 0;
		try {
			mtimeMs = (await stat(path)).mtimeMs;
		} catch {
			mtimeMs = 0;
		}
		notes.push({
			key: entry.replace(/\.md$/, ""),
			text: (await readText(path)) ?? "",
			mtimeMs,
		});
	}
	return notes;
}

/**
 * Pack notes by stem-overlap score, then recency, then key.
 * A note that does not fit is omitted whole (never truncated) and the next candidate is tried.
 */
export function packSynthesizeNotes(
	notes: readonly SemanticNoteRecord[],
	query: string,
	budgetChars: number,
): PackedSynthesizeNotes {
	const words = queryWords(query);
	const ranked = notes
		.map((note) => ({
			...note,
			score: stemScore(note.key, words),
			chars: Buffer.byteLength(note.text, "utf8"),
		}))
		.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

	const selected: SemanticNoteRecord[] = [];
	const omitted: SynthesizeSkip[] = [];
	let usedChars = 0;
	for (const note of ranked) {
		const extra = selected.length === 0 ? 0 : 2;
		if (budgetChars <= 0 || usedChars + extra + note.chars > budgetChars) {
			omitted.push({ key: note.key, chars: note.chars, score: note.score, mtimeMs: note.mtimeMs });
			continue;
		}
		selected.push({ key: note.key, text: note.text, mtimeMs: note.mtimeMs });
		usedChars += extra + note.chars;
	}
	return {
		packed: selected.map((note) => note.text).join("\n\n"),
		selected,
		omitted,
		usedChars,
	};
}

function queryWords(query: string): Set<string> {
	return new Set(
		query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => word.length >= 4),
	);
}

function stemScore(key: string, words: Set<string>): number {
	const parts = [
		...new Set(
			key
				.toLowerCase()
				.split("-")
				.filter((part) => part.length >= 4 && !/^\d+$/.test(part)),
		),
	];
	return parts.filter((part) => words.has(part)).length;
}

function envPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
	return Math.floor(value);
}
