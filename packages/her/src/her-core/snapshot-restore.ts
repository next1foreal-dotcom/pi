import { copyFile, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eventHistoryPath, eventHistoryStatePath } from "./event-history.ts";
import { createSnapshot } from "./snapshot-create.ts";
import { isReparsePoint } from "./snapshot-fs.ts";
import { mergeAndRecordRestore } from "./snapshot-history.ts";
import { absFromRel, isLiveTarget, pathExists, toWinAbs } from "./snapshot-paths.ts";
import type { RestoreSnapshotOptions, SnapshotManifest } from "./snapshot-types.ts";
import { isHistoryExempt, isLockExempt, SnapshotError } from "./snapshot-types.ts";
import { loadManifest } from "./snapshot-verify.ts";

export async function restoreSnapshot(opts: RestoreSnapshotOptions): Promise<void> {
	const manifest = await loadManifest(opts.snapshotDir);
	const live = await isLiveTarget(opts.targetRoot, opts.liveRoot);
	if ((live || opts.external) && !opts.confirm) {
		throw new SnapshotError("restore to live her-memory or --external requires FEI_RESTORE_CONFIRM=1");
	}
	if (!(await looksLikeHerMemory(opts.targetRoot))) {
		throw new SnapshotError("restore target must be empty/new or contain a .her/ marker");
	}
	if (live) {
		await createSnapshot({
			externalSources: [],
			sameVolumeOk: opts.sameVolumeOk,
			snapshotParent: opts.snapshotParent,
			sourceRoot: opts.targetRoot,
		});
	}
	await asideHistory(opts.targetRoot);
	const treeDir = join(opts.snapshotDir, "tree");
	await mkdir(toWinAbs(opts.targetRoot), { recursive: true });
	await copyTree(treeDir, opts.targetRoot, manifest);
	await deleteExtras(opts.targetRoot, "", new Set(manifest.files.map((file) => file.path)));
	await mergeAndRecordRestore({
		snapshotTs: manifest.ts,
		snapshotTree: treeDir,
		targetRoot: opts.targetRoot,
	});
	if (opts.external) await restoreExternals(opts.snapshotDir, manifest);
}

export async function looksLikeHerMemory(target: string): Promise<boolean> {
	if (!(await pathExists(target))) return true;
	const st = await lstat(toWinAbs(target));
	if (!st.isDirectory()) return false;
	const entries = await readdir(toWinAbs(target));
	if (entries.length === 0) return true;
	return entries.includes(".her");
}

async function copyTree(treeDir: string, target: string, manifest: SnapshotManifest): Promise<void> {
	for (const file of manifest.files) {
		if (isLockExempt(file.path)) continue;
		const dest = absFromRel(target, file.path);
		if (isHistoryExempt(file.path) && (await pathExists(dest))) continue;
		const src = absFromRel(treeDir, file.path);
		await mkdir(toWinAbs(dirname(dest)), { recursive: true });
		await copyFile(toWinAbs(src), toWinAbs(dest));
	}
}

async function deleteExtras(root: string, rel: string, keep: Set<string>): Promise<void> {
	const abs = rel ? absFromRel(root, rel) : root;
	if (rel && (isLockExempt(rel) || isHistoryExempt(rel))) return;
	if (await isReparsePoint(abs)) {
		if (rel && !keep.has(rel)) await rm(toWinAbs(abs), { force: true });
		return;
	}
	const st = await lstat(toWinAbs(abs));
	if (st.isFile()) {
		if (rel && !keep.has(rel)) await rm(toWinAbs(abs), { force: true });
		return;
	}
	if (!st.isDirectory()) return;
	const entries = await readdir(toWinAbs(abs), { withFileTypes: true });
	for (const entry of entries) {
		const child = rel ? `${rel}/${entry.name}` : entry.name;
		await deleteExtras(root, child, keep);
	}
	if (!rel) return;
	const left = await readdir(toWinAbs(abs));
	if (left.length === 0) await rm(toWinAbs(abs), { force: true, recursive: true });
}

async function asideHistory(target: string): Promise<void> {
	const src = eventHistoryPath(target);
	if (!(await pathExists(src))) return;
	const dir = await mkdtemp(join(tmpdir(), "her-restore-aside-"));
	await mkdir(toWinAbs(join(dir, "audit")), { recursive: true });
	await copyFile(toWinAbs(src), toWinAbs(join(dir, "audit", "event-history.jsonl")));
	const state = eventHistoryStatePath(target);
	if (await pathExists(state)) {
		await copyFile(toWinAbs(state), toWinAbs(join(dir, "audit", "event-history.state.json")));
	}
}

async function restoreExternals(snapshotDir: string, manifest: SnapshotManifest): Promise<void> {
	for (const row of manifest.external) {
		if (row.missing) continue;
		const src = join(snapshotDir, ...row.snapshotPath.split("/"));
		await mkdir(toWinAbs(dirname(row.source)), { recursive: true });
		await copyFile(toWinAbs(src), toWinAbs(row.source));
	}
}

export function restoreConfirm(env: NodeJS.ProcessEnv): boolean {
	return env.FEI_RESTORE_CONFIRM === "1";
}
