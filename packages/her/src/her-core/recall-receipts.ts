import type { Note } from "./retrieval.ts";
import { parseFrontmatter, redactSecrets } from "./store.ts";

export const UNKNOWN_PROVENANCE = "unknown";

export interface RecallReceipt {
	id: string;
	slug: string;
	kind: string;
	path: string;
	score: number;
	excerpt: string;
	authored_by: string;
	harness: string;
	tier: string;
	updated: string;
}

function scalar(data: Record<string, unknown>, ...keys: string[]): string {
	for (const key of keys) {
		const value = data[key];
		if (value === undefined || value === null || value === "") continue;
		if (typeof value === "boolean" || Array.isArray(value) || typeof value === "object") continue;
		const text = String(value).trim();
		if (text) return text;
	}
	return UNKNOWN_PROVENANCE;
}

function harnessOf(data: Record<string, unknown>): string {
	const direct = scalar(data, "harness");
	if (direct !== UNKNOWN_PROVENANCE) return direct;
	const source = data.source;
	if (typeof source === "string" && source.trim()) return source.trim();
	return UNKNOWN_PROVENANCE;
}

function slugOf(data: Record<string, unknown>, path: string, id: string): string {
	const fromFm = scalar(data, "key", "id");
	if (fromFm !== UNKNOWN_PROVENANCE) return fromFm;
	const leaf = path.split(/[/\\]/).pop() ?? id;
	return leaf.replace(/\.md$/i, "") || id;
}

function excerptOf(body: string, rawText: string): string {
	const src = redactSecrets((body || rawText).trim());
	return src.replace(/\s+/g, " ").slice(0, 240);
}

/** Derived recall receipt — missing provenance fields are literally \"unknown\". */
export function buildRecallReceipt(note: Note): RecallReceipt {
	const { data, body } = parseFrontmatter(note.text);
	return {
		id: note.id,
		slug: slugOf(data, note.path, note.id),
		kind: note.kind,
		path: note.path,
		score: note.score,
		excerpt: excerptOf(body, note.text),
		authored_by: scalar(data, "authored_by", "author"),
		harness: harnessOf(data),
		tier: scalar(data, "tier"),
		updated: scalar(data, "updated", "created", "timestamp"),
	};
}

export function buildRecallReceipts(notes: Note[]): RecallReceipt[] {
	return notes.map(buildRecallReceipt);
}
