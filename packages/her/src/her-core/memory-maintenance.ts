import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { appendEventBestEffort } from "./event-history.ts";
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

function countRevs(result: { stdout: string }): number {
	return Number.parseInt(result.stdout.trim(), 10) || 0;
}

// Dual-machine safe sync for the shared her-memory repo. Mirrors the hourly
// tools/sync-her-memory.ps1 philosophy: fetch first, fast-forward only, fail
// loud on divergence — never merge-commit, never rebase, never force. A push
// rejected by a concurrent remote advance also throws, so the caller retreats
// and retries on the next round instead of racing for the lock.
export async function syncMemory(paths: StorePaths, message: string): Promise<MemorySyncResult> {
	const runId = randomUUID();
	await appendEventBestEffort("organ.sync.start", "sync", { runId }, paths.root);
	try {
		const result = await syncMemoryOnce(paths, message);
		await appendEventBestEffort("organ.sync.end", "sync", { runId, ok: true, status: result.status }, paths.root);
		const flushed = await commitAndPushEventHistory(paths, message);
		return flushed ?? result;
	} catch (error) {
		const head = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
		await appendEventBestEffort("organ.sync.end", "sync", { runId, ok: false, error: head }, paths.root);
		throw error;
	}
}

async function commitAndPushEventHistory(paths: StorePaths, message: string): Promise<MemorySyncResult | undefined> {
	const names = ["audit/event-history.jsonl", "audit/event-history.state.json"];
	const existing: string[] = [];
	for (const name of names) {
		if ((await readText(join(paths.root, name))) !== undefined) existing.push(name);
	}
	if (existing.length === 0) return undefined;
	await git(paths.root, "add", "--", ...existing);
	if (!(await git(paths.root, "diff", "--cached", "--name-only")).stdout.trim()) return undefined;
	await git(paths.root, "commit", "-m", message);
	const branch = (await git(paths.root, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
	await git(paths.root, "push", "origin", branch);
	const commit = (await git(paths.root, "rev-parse", "--short", "HEAD")).stdout.trim();
	return { status: "pushed", commit };
}

async function syncMemoryOnce(paths: StorePaths, message: string): Promise<MemorySyncResult> {
	const branch = (await git(paths.root, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
	if (!branch || branch === "HEAD") {
		throw new Error(`her-memory sync refused: detached HEAD (branch resolved to "${branch}")`);
	}
	const upstream = `origin/${branch}`;

	// Learn the remote state before touching history; never push blind.
	await git(paths.root, "fetch", "origin", branch);
	let ahead = countRevs(await git(paths.root, "rev-list", "--count", `${upstream}..HEAD`));
	const behind = countRevs(await git(paths.root, "rev-list", "--count", `HEAD..${upstream}`));

	// Both sides advanced: fail loud, leave history untouched.
	if (behind > 0 && ahead > 0) {
		throw new Error(
			`her-memory sync refused: ${branch} diverged from ${upstream} (${ahead} ahead, ${behind} behind). ` +
				"Resolve by hand; automation never merges diverged history or force-pushes.",
		);
	}

	// Remote moved ahead only: fast-forward down before committing local growth
	// on top, so a routine capture never manufactures a divergence.
	if (behind > 0) {
		await git(paths.root, "merge", "--ff-only", upstream);
	}

	// Stage all memory content but never per-machine runtime state under .her/;
	// it must not travel across machines even when a file there is not yet
	// gitignored (see her-memory .her/ ignore rules).
	await git(paths.root, "add", "-A", "--", ".", ":(exclude).her", ":(exclude)audit/event-history.lock");
	if ((await git(paths.root, "diff", "--cached", "--name-only")).stdout.trim()) {
		await git(paths.root, "commit", "-m", message);
		ahead += 1;
	}

	// Publish any unpushed commits. A rejected push (remote advanced mid-window)
	// throws, so we retreat and retry next round rather than force.
	if (ahead > 0) {
		await git(paths.root, "push", "origin", branch);
		const commit = (await git(paths.root, "rev-parse", "--short", "HEAD")).stdout.trim();
		return { status: "pushed", commit };
	}
	if (behind > 0) return { status: "fast-forwarded", behind };
	return { status: "clean" };
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
