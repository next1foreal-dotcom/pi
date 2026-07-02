import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JudgmentFields, WorldNoteData } from "./memory-types.ts";
import { appendJudgment, genId, normalizeMemoryStatusReason, slug, stripSection, worldBody } from "./memory-utils.ts";
import type { StorePaths } from "./paths.ts";
import { defaultWorldPrivacy, validateMemoryProvenance } from "./privacy.ts";
import { frontmatter, parseFrontmatter, readJson, readText, writeJson, writeText } from "./store.ts";

export async function writeWorldNote(paths: StorePaths, data: WorldNoteData): Promise<string> {
	const memoryStatusReason = normalizeMemoryStatusReason(data.memoryStatus, data.memoryStatusReason);
	const seen = await readJson<Record<string, string>>(paths.seenFile, {});
	const existing = seen[data.contentHash];
	if (existing) return existing;

	let noteSlug = slug(data.title);
	let path = join(paths.world, `${noteSlug}.md`);
	const existingText = await readText(path);
	if (existingText) {
		const parsed = parseFrontmatter(existingText);
		if (parsed.data.content_hash !== data.contentHash) {
			noteSlug = `${noteSlug}-${data.contentHash.slice(0, 6)}`;
			path = join(paths.world, `${noteSlug}.md`);
		}
	}

	const id = genId(data.contentHash, noteSlug);
	const fm = {
		id,
		title: data.title,
		source_url: data.sourceUrl,
		source_type: data.sourceType,
		captured_at: new Date().toISOString(),
		content_hash: data.contentHash,
		status: "captured",
		memory_status: data.memoryStatus,
		memory_status_reason: memoryStatusReason,
		privacy: defaultWorldPrivacy(data.sourceUrl, data.privacy),
		provenance: data.provenance ? validateMemoryProvenance(data.provenance) : "world-ingested",
		claim_count: data.claims?.length ?? 0,
		supported_claims: data.claims?.filter((claim) => claim.verdict === "supported").length ?? 0,
		insufficient_claims: data.claims?.filter((claim) => claim.verdict === "insufficient_evidence").length ?? 0,
		response_version: 1,
	};
	await writeText(path, `${frontmatter(fm)}${worldBody(data, memoryStatusReason)}`);
	seen[data.contentHash] = id;
	await writeJson(paths.seenFile, seen);
	return id;
}

export async function recordJudgment(paths: StorePaths, noteId: string, fields: JudgmentFields): Promise<void> {
	const path = await findWorldNote(paths, noteId);
	const text = await readText(path);
	const parsed = parseFrontmatter(text);
	const body = appendJudgment(parsed.body, fields);
	await writeText(path, `${frontmatter(parsed.data)}${body}`);
}

export async function setMemoryStatus(
	paths: StorePaths,
	noteId: string,
	status: "active" | "archive_only" | "needs_deep_read",
	reason: string,
): Promise<void> {
	const path = await findWorldNote(paths, noteId);
	const text = await readText(path);
	const parsed = parseFrontmatter(text);
	parsed.data.memory_status = status;
	parsed.data.memory_status_reason = reason;
	const body = `${stripSection(parsed.body, "Memory Status")}\n## Memory Status\n\n- status: ${status}\n- reason: ${reason}\n`;
	await writeText(path, `${frontmatter(parsed.data)}${body}`);
}

async function findWorldNote(paths: StorePaths, noteId: string): Promise<string> {
	const entries = await readdir(paths.world);
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const path = join(paths.world, entry);
		const parsed = parseFrontmatter(await readText(path));
		if (parsed.data.id === noteId || basename(entry, ".md") === noteId) return path;
	}
	throw new Error(`world note not found: ${noteId}`);
}
