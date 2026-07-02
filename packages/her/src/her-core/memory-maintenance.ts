import { unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	DecaySweepOptions,
	DecaySweepResult,
	MemorySyncResult,
	MemorySyncStatus,
	RestoreArchivedSemanticOptions,
	RestoreArchivedSemanticResult,
} from "./memory-types.ts";
import { git, markdownEntries, parseDate, readLastSyncedAt, slug, today } from "./memory-utils.ts";
import type { StorePaths } from "./paths.ts";
import { frontmatter, parseFrontmatter, readJson, readText, writeNewText, writeText } from "./store.ts";

export async function decaySweep(paths: StorePaths, opts: DecaySweepOptions = {}): Promise<DecaySweepResult> {
	const olderThanDays = opts.olderThanDays ?? 180;
	const accessBoostDays = opts.accessBoostDays ?? 30;
	const maxAccessBoostDays = opts.maxAccessBoostDays ?? 120;
	const recentAccessGraceDays = opts.recentAccessGraceDays ?? 30;
	const nowText = opts.now ?? today();
	const nowTime = parseDate(nowText) ?? Date.now();
	const state = await readJson<{ access?: Record<string, { count?: unknown; lastAt?: unknown }> }>(
		paths.stateFile,
		{},
	);
	const archivedKeys: string[] = [];
	let kept = 0;

	for (const entry of await markdownEntries(paths.semantic)) {
		const sourcePath = join(paths.semantic, entry);
		const parsed = parseFrontmatter(await readText(sourcePath));
		const tier = String(parsed.data.tier ?? "");
		if (tier !== "decay") {
			kept++;
			continue;
		}
		const noteTime = parseDate(String(parsed.data.updated ?? parsed.data.created ?? ""));
		const ageDays = noteTime === undefined ? undefined : Math.floor((nowTime - noteTime) / 86400000);
		if (ageDays === undefined || ageDays <= olderThanDays) {
			kept++;
			continue;
		}

		const key = basename(entry, ".md");
		const noteId = `semantic/${key}`;
		const access = state.access?.[noteId];
		const accessCount = Math.max(0, Math.floor(Number(access?.count) || 0));
		const lastAccessedAt = typeof access?.lastAt === "string" ? access.lastAt : undefined;
		const lastAccessedTime = parseDate(lastAccessedAt);
		const daysSinceAccess =
			lastAccessedTime === undefined ? undefined : Math.floor((nowTime - lastAccessedTime) / 86400000);
		if (daysSinceAccess !== undefined && recentAccessGraceDays > 0 && daysSinceAccess <= recentAccessGraceDays) {
			kept++;
			continue;
		}
		const accessBoost = Math.min(accessCount * accessBoostDays, maxAccessBoostDays);
		const effectiveAgeDays = Math.max(0, ageDays - accessBoost);
		if (effectiveAgeDays <= olderThanDays) {
			kept++;
			continue;
		}

		parsed.data.pre_archive_tier = tier;
		parsed.data.tier = "archive";
		parsed.data.archived_at = nowText.slice(0, 10);
		parsed.data.access_count = accessCount;
		if (lastAccessedAt) parsed.data.last_accessed_at = lastAccessedAt;
		parsed.data.decay_effective_age_days = effectiveAgeDays;
		parsed.data.archive_reason = `decay-tier semantic note effective age ${effectiveAgeDays} days older than ${olderThanDays} days`;
		await writeText(join(paths.archiveSemantic, entry), `${frontmatter(parsed.data)}${parsed.body}`);
		await unlink(sourcePath);
		archivedKeys.push(key);
	}

	return { archived: archivedKeys.length, kept, archivedKeys };
}

export async function restoreArchivedSemantic(
	paths: StorePaths,
	key: string,
	opts: RestoreArchivedSemanticOptions = {},
): Promise<RestoreArchivedSemanticResult> {
	const safeKey = slug(key);
	const archivePath = join(paths.archiveSemantic, `${safeKey}.md`);
	const text = await readText(archivePath);
	if (text === undefined) throw new Error(`archived semantic note not found: ${safeKey}`);
	const parsed = parseFrontmatter(text);
	const restoredTier = typeof parsed.data.pre_archive_tier === "string" ? parsed.data.pre_archive_tier : "decay";
	parsed.data.tier = restoredTier;
	parsed.data.restored_at = (opts.now ?? today()).slice(0, 10);
	delete parsed.data.pre_archive_tier;
	delete parsed.data.archived_at;
	delete parsed.data.archive_reason;
	await writeNewText(join(paths.semantic, `${safeKey}.md`), `${frontmatter(parsed.data)}${parsed.body}`);
	await unlink(archivePath);
	return { key: safeKey, restored: true };
}

export async function syncMemory(paths: StorePaths, message: string): Promise<MemorySyncResult> {
	await git(paths.root, "add", "-A");
	const staged = await git(paths.root, "diff", "--cached", "--name-only");
	if (!staged.stdout.trim()) return { status: "clean" };

	await git(paths.root, "commit", "-m", message);
	const commit = (await git(paths.root, "rev-parse", "--short", "HEAD")).stdout.trim();
	await git(paths.root, "push");
	return { status: "pushed", commit };
}

export async function syncStatus(paths: StorePaths): Promise<MemorySyncStatus> {
	try {
		const dirty = (await git(paths.root, "status", "--porcelain")).stdout
			.split(/\r?\n/)
			.filter((line) => line.trim()).length;
		const branch = (await git(paths.root, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim() || undefined;
		const ahead = await git(paths.root, "rev-list", "--count", "@{upstream}..HEAD")
			.then((result) => Number(result.stdout.trim()) || 0)
			.catch(() => 0);
		const lastSynced = await readLastSyncedAt(paths.root);
		const pending = dirty + ahead;
		return {
			status: pending > 0 ? "unsynced" : "synced",
			dirtyFiles: dirty,
			aheadCommits: ahead,
			pending,
			branch,
			...(lastSynced.value ? { lastSyncedAt: lastSynced.value } : {}),
			...(lastSynced.error ? { lastSyncedAtError: lastSynced.error } : {}),
		};
	} catch (error) {
		return {
			status: "unknown",
			dirtyFiles: 0,
			aheadCommits: 0,
			pending: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
