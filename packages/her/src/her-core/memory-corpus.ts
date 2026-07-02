import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { HerConfig } from "./config.ts";
import type { StorePaths } from "./paths.ts";
import type { CorpusDoc } from "./retrieval.ts";
import { readJson, readText, writeJson } from "./store.ts";

export async function buildCorpus(paths: StorePaths): Promise<CorpusDoc[]> {
	const docs: CorpusDoc[] = [];
	await addDirDocs(docs, paths.semantic, "semantic");
	await addDirDocs(docs, paths.world, "world");
	await addDirDocs(docs, paths.topics, "topic");
	await addDirDocs(docs, paths.ideas, "idea");
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
	return docs;
}

async function addDirDocs(docs: CorpusDoc[], dir: string, kind: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries.sort()) {
		if (entry.endsWith(".md")) await addFileDoc(docs, join(dir, entry), kind);
	}
}

async function addFileDoc(docs: CorpusDoc[], path: string, kind: string): Promise<void> {
	const text = await readText(path);
	if (!text?.trim()) return;
	docs.push({ id: `${kind}/${basename(path, ".md")}`, kind, path, text });
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
