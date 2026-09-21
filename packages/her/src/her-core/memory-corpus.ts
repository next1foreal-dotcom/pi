import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { HerConfig } from "./config.ts";
import type { StorePaths } from "./paths.ts";
import type { CorpusDoc } from "./retrieval.ts";
import { parseFrontmatter, readJson, readText, writeJson } from "./store.ts";

export async function buildCorpus(paths: StorePaths): Promise<CorpusDoc[]> {
	const docs: CorpusDoc[] = [];
	await addDirDocs(docs, paths.semantic, "semantic", "active");
	await addDirDocs(docs, paths.world, "world", "active");
	await addDirDocs(docs, paths.topics, "topic", "active");
	await addDirDocs(docs, paths.ideas, "idea", "active");
	await addFileDoc(docs, paths.contextFile, "narrative");
	await addFileDoc(docs, paths.becoming, "becoming");
	await addDirDocs(docs, paths.recognitions, "recognition");
	return docs;
}

export async function recordAccess(paths: StorePaths, noteIds: string[]): Promise<void> {
	const uniqueIds = [...new Set(noteIds)].filter(Boolean);
	if (uniqueIds.length === 0) return;
	const state = await readJson<{ access?: Record<string, { count?: number; lastAt?: string }> }>(paths.stateFile, {});
	const at = new Date().toISOString();
	const access = { ...(state.access ?? {}) };
	for (const id of uniqueIds) {
		const current = access[id];
		access[id] = {
			count: Math.max(0, Math.floor(Number(current?.count) || 0)) + 1,
			lastAt: at,
		};
	}
	await writeJson(paths.stateFile, { ...state, access });
}

export async function buildArchiveCorpus(paths: StorePaths): Promise<CorpusDoc[]> {
	const docs: CorpusDoc[] = [];
	await addDirDocs(docs, paths.archiveSemantic, "archive/semantic");
	await addDirDocs(docs, paths.semantic, "history/semantic", "inactive");
	await addDirDocs(docs, paths.world, "history/world", "inactive");
	await addDirDocs(docs, paths.topics, "history/topic", "inactive");
	await addDirDocs(docs, paths.ideas, "history/idea", "inactive");
	return docs;
}

type CorpusVisibility = "active" | "inactive";
async function addDirDocs(docs: CorpusDoc[], dir: string, kind: string, visibility?: CorpusVisibility): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries.sort()) {
		if (entry.endsWith(".md")) await addFileDoc(docs, join(dir, entry), kind, visibility);
	}
}

async function addFileDoc(docs: CorpusDoc[], path: string, kind: string, visibility?: CorpusVisibility): Promise<void> {
	const text = await readText(path);
	if (!text?.trim()) return;
	if (visibility && memoryVisibility(text) !== visibility) return;
	docs.push({ id: `${kind}/${basename(path, ".md")}`, kind, path, text });
}

function memoryVisibility(text: string, now = Date.now()): CorpusVisibility {
	const data = parseFrontmatter(text).data;
	if (data.status === "superseded" || data.memory_status === "archive_only") return "inactive";
	const expiry = data.valid_until ?? data.expires_at;
	if (typeof expiry === "string") {
		const at = Date.parse(expiry);
		if (Number.isFinite(at) && at <= now) return "inactive";
	}
	return "active";
}
export async function staleBanner(paths: StorePaths, config: HerConfig): Promise<string> {
	const state = await readJson<{ last_synthesize?: string }>(paths.stateFile, {});
	if (!state.last_synthesize) return "";
	const last = new Date(state.last_synthesize.slice(0, 10));
	if (Number.isNaN(last.getTime())) return "";
	const days = Math.floor((Date.now() - last.getTime()) / 86400000);
	return days > config.cadence.synthesizeStaleAfterDays
		? `> Weekly review skipped ${days} days - narrative may be stale.\n\n`
		: "";
}
