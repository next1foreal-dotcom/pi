import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, readlink, rm, statfs, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { absFromRel, isEnoent, snapshotLockPath, toWinAbs } from "./snapshot-paths.ts";
import {
	HASH_CONCURRENCY,
	isWalkExcluded,
	type ManifestFile,
	type SkippedReparse,
	SnapshotError,
} from "./snapshot-types.ts";
import { isLockContention } from "./store-lock.ts";

export interface WalkResult {
	excluded: string[];
	files: string[];
	skippedReparse: SkippedReparse[];
}

export async function isReparsePoint(absPath: string): Promise<boolean> {
	let st: Awaited<ReturnType<typeof lstat>>;
	try {
		st = await lstat(toWinAbs(absPath));
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	if (st.isSymbolicLink()) return true;
	if (process.platform === "win32" && st.isDirectory()) {
		try {
			await readlink(toWinAbs(absPath));
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

export async function walkSource(root: string): Promise<WalkResult> {
	const files: string[] = [];
	const excluded: string[] = [];
	const skippedReparse: SkippedReparse[] = [];
	await walkDir(root, "", files, excluded, skippedReparse);
	return { excluded, files, skippedReparse };
}

async function walkDir(
	root: string,
	rel: string,
	files: string[],
	excluded: string[],
	skippedReparse: SkippedReparse[],
): Promise<void> {
	const abs = rel ? absFromRel(root, rel) : root;
	const entries = await readdir(toWinAbs(abs), { withFileTypes: true });
	for (const entry of entries) {
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		const childAbs = absFromRel(root, childRel);
		if (isWalkExcluded(childRel)) {
			excluded.push(childRel);
			continue;
		}
		if (await isReparsePoint(childAbs)) {
			skippedReparse.push({ kind: "reparse", path: childRel });
			continue;
		}
		const st = await lstat(toWinAbs(childAbs));
		if (st.isDirectory()) await walkDir(root, childRel, files, excluded, skippedReparse);
		else if (st.isFile()) files.push(childRel);
	}
}

export async function hashFile(absPath: string): Promise<{ sha256: string; size: number }> {
	const hash = createHash("sha256");
	const fh = await open(toWinAbs(absPath), "r");
	try {
		const st = await fh.stat();
		for await (const chunk of fh.createReadStream()) hash.update(chunk);
		return { sha256: hash.digest("hex"), size: st.size };
	} finally {
		await fh.close();
	}
}

export async function hashRelFiles(root: string, rels: string[]): Promise<ManifestFile[]> {
	return mapPool(rels, HASH_CONCURRENCY, async (path) => {
		const info = await hashFile(absFromRel(root, path));
		return { path, sha256: info.sha256, size: info.size };
	});
}

export async function copyRelFile(srcRoot: string, destRoot: string, rel: string): Promise<void> {
	const src = absFromRel(srcRoot, rel);
	const dest = absFromRel(destRoot, rel);
	await mkdir(toWinAbs(dirname(dest)), { recursive: true });
	await copyFile(toWinAbs(src), toWinAbs(dest));
}

export async function writeTextLong(path: string, text: string): Promise<void> {
	await mkdir(toWinAbs(dirname(path)), { recursive: true });
	await writeFile(toWinAbs(path), text, "utf8");
}

export async function withSnapshotLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = snapshotLockPath(root);
	await mkdir(toWinAbs(dirname(lockPath)), { recursive: true });
	try {
		await writeFile(toWinAbs(lockPath), `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if (isLockContention(error)) {
			throw new SnapshotError(`snapshot lock exists: ${lockPath}`);
		}
		throw error;
	}
	try {
		return await fn();
	} finally {
		await rm(toWinAbs(lockPath), { force: true });
	}
}

export async function freeBytes(path: string): Promise<number | undefined> {
	try {
		const fsStat = await statfs(toWinAbs(path));
		return Number(fsStat.bavail) * Number(fsStat.bsize);
	} catch {
		return undefined;
	}
}

export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const i = next;
			next += 1;
			if (i >= items.length) return;
			out[i] = await fn(items[i]);
		}
	}
	const n = items.length === 0 ? 0 : Math.max(1, Math.min(concurrency, items.length));
	await Promise.all(Array.from({ length: n }, () => worker()));
	return out;
}
