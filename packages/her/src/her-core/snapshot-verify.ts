import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashFile, walkSource } from "./snapshot-fs.ts";
import { absFromRel, isEnoent, toWinAbs } from "./snapshot-paths.ts";
import type { SnapshotManifest, VerifyDiff, VerifySnapshotResult } from "./snapshot-types.ts";
import { SnapshotError } from "./snapshot-types.ts";

export async function loadManifest(snapshotDir: string): Promise<SnapshotManifest> {
	try {
		const text = await readFile(toWinAbs(join(snapshotDir, "manifest.json")), "utf8");
		return parseManifest(JSON.parse(text.replace(/^\uFEFF/, "")));
	} catch (error) {
		if (isEnoent(error)) throw new SnapshotError(`manifest.json missing in ${snapshotDir}`);
		throw error;
	}
}

export async function verifySnapshot(snapshotDir: string): Promise<VerifySnapshotResult> {
	const manifest = await loadManifest(snapshotDir);
	const treeDir = join(snapshotDir, "tree");
	const walked = await walkSource(treeDir);
	const present = new Set(walked.files);
	const expected = new Set(manifest.files.map((file) => file.path));
	const diffs: VerifyDiff[] = [];
	for (const file of manifest.files) {
		if (!present.has(file.path)) {
			diffs.push({ kind: "missing", path: file.path });
			continue;
		}
		const info = await hashFile(absFromRel(treeDir, file.path));
		if (info.sha256 !== file.sha256 || info.size !== file.size) {
			diffs.push({ kind: "changed", path: file.path });
		}
	}
	for (const rel of walked.files) {
		if (!expected.has(rel)) diffs.push({ kind: "extra", path: rel });
	}
	return { diffs, ok: diffs.length === 0 };
}

function parseManifest(value: unknown): SnapshotManifest {
	if (!value || typeof value !== "object") throw new SnapshotError("manifest.json is not an object");
	const rec = value as Record<string, unknown>;
	if (!Array.isArray(rec.files) || !Array.isArray(rec.external) || !Array.isArray(rec.excluded)) {
		throw new SnapshotError("manifest.json missing arrays");
	}
	if (typeof rec.ts !== "string") throw new SnapshotError("manifest.json missing ts");
	if (typeof rec.totalBytes !== "number") throw new SnapshotError("manifest.json missing totalBytes");
	if (!Array.isArray(rec.skippedReparse)) throw new SnapshotError("manifest.json missing skippedReparse");
	const head = rec.herMemoryGitHead;
	if (head !== null && typeof head !== "string") throw new SnapshotError("manifest.json bad herMemoryGitHead");
	return {
		excluded: rec.excluded as string[],
		external: rec.external as SnapshotManifest["external"],
		files: rec.files as SnapshotManifest["files"],
		herMemoryGitHead: head,
		skippedReparse: rec.skippedReparse as SnapshotManifest["skippedReparse"],
		totalBytes: rec.totalBytes,
		ts: rec.ts,
	};
}
