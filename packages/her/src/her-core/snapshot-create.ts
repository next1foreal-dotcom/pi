import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	copyRelFile,
	freeBytes,
	hashFile,
	hashRelFiles,
	walkSource,
	withSnapshotLock,
	writeTextLong,
} from "./snapshot-fs.ts";
import { isEnoent, pathExists, safeExternalName, sameVolume, toWinAbs, utcStamp } from "./snapshot-paths.ts";
import {
	type CreateSnapshotOptions,
	type CreateSnapshotResult,
	type ExternalSource,
	type ManifestExternal,
	SnapshotError,
	type SnapshotManifest,
} from "./snapshot-types.ts";

export async function createSnapshot(opts: CreateSnapshotOptions): Promise<CreateSnapshotResult> {
	const sourceRoot = opts.sourceRoot;
	if (!(await pathExists(sourceRoot))) throw new SnapshotError(`source does not exist: ${sourceRoot}`);
	if (!opts.sameVolumeOk && (await sameVolume(sourceRoot, opts.snapshotParent))) {
		throw new SnapshotError(
			"snapshot destination is on the same volume as the source; pass --same-volume-ok to override",
		);
	}
	return withSnapshotLock(sourceRoot, () => createUnderLock(opts));
}

async function createUnderLock(opts: CreateSnapshotOptions): Promise<CreateSnapshotResult> {
	const ts = utcStamp();
	const snapshotDir = join(opts.snapshotParent, ts);
	if (await pathExists(snapshotDir)) throw new SnapshotError(`snapshot already exists: ${snapshotDir}`);
	await mkdir(toWinAbs(snapshotDir), { recursive: true });
	const treeDir = join(snapshotDir, "tree");
	await mkdir(toWinAbs(treeDir), { recursive: true });
	const walked = await walkSource(opts.sourceRoot);
	for (const rel of walked.files) await copyRelFile(opts.sourceRoot, treeDir, rel);
	const files = await hashRelFiles(treeDir, walked.files);
	const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	const external = await copyExternals(join(snapshotDir, "external"), opts.externalSources);
	const manifest: SnapshotManifest = {
		excluded: walked.excluded,
		external,
		files,
		herMemoryGitHead: await readGitHead(opts.sourceRoot),
		skippedReparse: walked.skippedReparse,
		totalBytes,
		ts,
	};
	await writeTextLong(join(snapshotDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	const free = await freeBytes(snapshotDir);
	return {
		fileCount: files.length,
		freeSpaceWarning: free !== undefined && free < 3 * totalBytes,
		snapshotDir,
		totalBytes,
	};
}

async function copyExternals(destDir: string, sources: ExternalSource[]): Promise<ManifestExternal[]> {
	const rows: ManifestExternal[] = [];
	for (const item of sources) {
		const name = safeExternalName(item.name);
		const snapshotPath = `external/${name}`;
		const dest = join(destDir, name);
		try {
			const info = await hashFile(item.source);
			await mkdir(toWinAbs(dirname(dest)), { recursive: true });
			await copyFile(toWinAbs(item.source), toWinAbs(dest));
			rows.push({ sha256: info.sha256, size: info.size, snapshotPath, source: item.source });
		} catch (error) {
			if (isEnoent(error)) {
				rows.push({ missing: true, snapshotPath, source: item.source });
				continue;
			}
			throw error;
		}
	}
	return rows;
}

async function readGitHead(root: string): Promise<string | null> {
	const gitDir = join(root, ".git");
	try {
		const raw = (await readFile(toWinAbs(join(gitDir, "HEAD")), "utf8")).trim();
		if (!raw.startsWith("ref:")) return raw || null;
		const ref = raw.slice(4).trim();
		try {
			return (await readFile(toWinAbs(join(gitDir, ref)), "utf8")).trim() || null;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return readPackedRef(gitDir, ref);
		}
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function readPackedRef(gitDir: string, ref: string): Promise<string | null> {
	try {
		const text = await readFile(toWinAbs(join(gitDir, "packed-refs")), "utf8");
		for (const line of text.split("\n")) {
			if (!line || line.startsWith("#") || line.startsWith("^")) continue;
			const space = line.indexOf(" ");
			if (space <= 0) continue;
			const name = line.slice(space + 1).trim();
			if (name === ref) return line.slice(0, space).trim();
		}
		return null;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

export function resolveExternalSources(env: NodeJS.ProcessEnv, fallback: ExternalSource[]): ExternalSource[] {
	const raw = env.HER_SNAPSHOT_EXTERNAL;
	if (raw === undefined) return fallback;
	if (raw.trim() === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new SnapshotError("HER_SNAPSHOT_EXTERNAL must be valid JSON");
	}
	if (!Array.isArray(parsed)) throw new SnapshotError("HER_SNAPSHOT_EXTERNAL must be a JSON array");
	return parsed.map(parseExternalSource);
}

function parseExternalSource(value: unknown): ExternalSource {
	if (!value || typeof value !== "object") throw new SnapshotError("HER_SNAPSHOT_EXTERNAL entries must be objects");
	const rec = value as Record<string, unknown>;
	if (typeof rec.source !== "string" || typeof rec.name !== "string") {
		throw new SnapshotError("HER_SNAPSHOT_EXTERNAL entries need string source and name");
	}
	return { name: rec.name, source: rec.source };
}

export function resolveSnapshotParent(env: NodeJS.ProcessEnv, fallback: string): string {
	const raw = env.HER_SNAPSHOT_DIR?.trim();
	return raw && raw.length > 0 ? raw : fallback;
}
