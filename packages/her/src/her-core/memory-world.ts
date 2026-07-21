import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JudgmentFields, WorldNoteData, WorldNoteSnapshot } from "./memory-types.ts";
import { appendJudgment, genId, normalizeMemoryStatusReason, slug, stripSection, worldBody } from "./memory-utils.ts";
import type { StorePaths } from "./paths.ts";
import { defaultWorldPrivacy, validateMemoryProvenance } from "./privacy.ts";
import { frontmatter, parseFrontmatter, readJson, readText, writeJson, writeText } from "./store.ts";

export async function writeWorldNote(paths: StorePaths, data: WorldNoteData): Promise<string> {
	const memoryStatusReason = normalizeMemoryStatusReason(data.memoryStatus, data.memoryStatusReason);
	const seen = await readJson<Record<string, string>>(paths.seenFile, {});
	const existing = seen[data.contentHash];
	if (existing) {
		if (data.sourceType === "taste-card") return updateTasteCardOnRepeatIntake(paths, existing, data);
		return existing;
	}

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
	const fm: Record<string, unknown> = {
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
	// palate T1: these keys only ever appear when a taste-card intake sets them, so pre-existing
	// intake-source/intake-url/intake-path/bootstrap-feed callers keep byte-identical frontmatter.
	if (data.boards !== undefined) fm.boards = data.boards;
	if (data.fei !== undefined) fm.fei = data.fei;
	if (data.snapshot !== undefined) fm.snapshot = data.snapshot;
	await writeText(path, `${frontmatter(fm)}${worldBody(data, memoryStatusReason)}`);
	seen[data.contentHash] = id;
	await writeJson(paths.seenFile, seen);
	return id;
}

/**
 * palate T1: a repeat taste-card intake (same contentHash) does not create a duplicate card.
 * Instead it merges the incoming boards (union) and appends a new fei half-sentence (never
 * overwriting the existing one) onto the card that is already on disk.
 */
async function updateTasteCardOnRepeatIntake(paths: StorePaths, noteId: string, data: WorldNoteData): Promise<string> {
	const path = await findWorldNote(paths, noteId);
	const text = await readText(path);
	const parsed = parseFrontmatter(text);

	const existingBoards = Array.isArray(parsed.data.boards) ? (parsed.data.boards as string[]) : [];
	const mergedBoards = Array.from(new Set([...existingBoards, ...(data.boards ?? [])]));
	if (mergedBoards.length > 0) parsed.data.boards = mergedBoards;

	const existingFei = typeof parsed.data.fei === "string" ? parsed.data.fei : "";
	const incomingFei = data.fei?.trim() ?? "";
	if (incomingFei && incomingFei !== existingFei) {
		parsed.data.fei = existingFei ? `${existingFei}\n${incomingFei}` : incomingFei;
	}

	// palate T2fix: a repeat intake (e.g. rerunning the same URL after a capture bug is fixed) may
	// carry media/a screenshot the on-disk card never got. Backfill only what's currently
	// empty/missing on disk; never overwrite a value the card already has.
	if (data.snapshot) {
		const existingSnapshot = parsed.data.snapshot as WorldNoteSnapshot | undefined;
		if (!existingSnapshot) {
			parsed.data.snapshot = data.snapshot;
		} else {
			const media = existingSnapshot.media.length > 0 ? existingSnapshot.media : data.snapshot.media;
			const screenshot = existingSnapshot.screenshot ?? data.snapshot.screenshot;
			if (media !== existingSnapshot.media || screenshot !== existingSnapshot.screenshot) {
				parsed.data.snapshot = { ...existingSnapshot, media, screenshot };
			}
		}
	}

	await writeText(path, `${frontmatter(parsed.data)}${parsed.body}`);
	return noteId;
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

export async function findWorldNote(paths: StorePaths, noteId: string): Promise<string> {
	const entries = await readdir(paths.world);
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const path = join(paths.world, entry);
		const parsed = parseFrontmatter(await readText(path));
		if (parsed.data.id === noteId || basename(entry, ".md") === noteId) return path;
	}
	throw new Error(`world note not found: ${noteId}`);
}

export type TasteBoardApplyOutcome = "applied" | "skipped" | "rejected" | "not-found";

export interface TasteBoardApplyResult {
	outcome: TasteBoardApplyOutcome;
	reason?: string;
}

/**
 * palate P2-2: give a taste card a new board tag through the CLI (AC-4's "经 Fei 同意才建" write path).
 * Reuses the same boards-union semantics as `updateTasteCardOnRepeatIntake` rather than a second
 * update path. Non-taste-card notes are rejected; already-tagged cards are skipped without a write
 * so their file bytes (and mtime) are untouched.
 */
export async function applyTasteBoard(
	paths: StorePaths,
	cardId: string,
	board: string,
): Promise<TasteBoardApplyResult> {
	let path: string;
	try {
		path = await findWorldNote(paths, cardId);
	} catch {
		return { outcome: "not-found", reason: `world note not found: ${cardId}` };
	}
	const parsed = parseFrontmatter(await readText(path));
	if (parsed.data.source_type !== "taste-card") {
		return { outcome: "rejected", reason: `not a taste card: ${cardId}` };
	}
	const boards = Array.isArray(parsed.data.boards) ? (parsed.data.boards as string[]) : [];
	if (boards.includes(board)) {
		return { outcome: "skipped", reason: "already tagged" };
	}
	parsed.data.boards = [...boards, board];
	await writeText(path, `${frontmatter(parsed.data)}${parsed.body}`);
	return { outcome: "applied" };
}
