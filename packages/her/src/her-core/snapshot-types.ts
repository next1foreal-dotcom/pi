export const DEFAULT_SNAPSHOT_PARENT = "E:\\Her-backup\\her-memory-snapshots";
export const HASH_CONCURRENCY = 8;
export const TASTE_MEDIA_REL = "taste-media";
export const STORE_LOCK_REL = ".her/lock";
export const SNAPSHOT_LOCK_REL = ".her/snapshot.lock";
export const HISTORY_REL = "audit/event-history.jsonl";
export const HISTORY_STATE_REL = "audit/event-history.state.json";

export class SnapshotError extends Error {}

export interface ExternalSource {
	name: string;
	source: string;
}

export interface ManifestFile {
	path: string;
	sha256: string;
	size: number;
}

export interface ManifestExternal {
	missing?: boolean;
	sha256?: string;
	size?: number;
	snapshotPath: string;
	source: string;
}

export interface SkippedReparse {
	kind: string;
	path: string;
}

export interface SnapshotManifest {
	excluded: string[];
	external: ManifestExternal[];
	files: ManifestFile[];
	herMemoryGitHead: string | null;
	skippedReparse: SkippedReparse[];
	totalBytes: number;
	ts: string;
}

export interface CreateSnapshotOptions {
	externalSources: ExternalSource[];
	sameVolumeOk: boolean;
	snapshotParent: string;
	sourceRoot: string;
}

export interface CreateSnapshotResult {
	fileCount: number;
	freeSpaceWarning: boolean;
	snapshotDir: string;
	totalBytes: number;
}

export interface VerifyDiff {
	kind: "missing" | "changed" | "extra";
	path: string;
}

export interface VerifySnapshotResult {
	diffs: VerifyDiff[];
	ok: boolean;
}

export interface RestoreSnapshotOptions {
	confirm: boolean;
	external: boolean;
	liveRoot: string;
	sameVolumeOk: boolean;
	snapshotDir: string;
	snapshotParent: string;
	targetRoot: string;
}

export const DEFAULT_EXTERNAL_SOURCES: ExternalSource[] = [
	{ name: "her-repo.env", source: "D:\\@Her\\Her-repo\\.env" },
	{ name: "samantha-ui.providers.json", source: "D:\\@Her\\Her-repo\\samantha-ui\\.her\\providers.json" },
	{ name: "samantha-ui.model-menu.json", source: "D:\\@Her\\Her-repo\\samantha-ui\\.her\\model-menu.json" },
	{ name: "pi-agent.settings.json", source: "C:\\Users\\Admin\\.pi\\agent\\settings.json" },
	{ name: "pi-agent.auth.json", source: "C:\\Users\\Admin\\.pi\\agent\\auth.json" },
];

export function isHistoryExempt(rel: string): boolean {
	return rel === HISTORY_REL || rel === HISTORY_STATE_REL;
}

export function isLockExempt(rel: string): boolean {
	return rel === STORE_LOCK_REL || rel === SNAPSHOT_LOCK_REL;
}

export function isWalkExcluded(rel: string): boolean {
	if (rel === TASTE_MEDIA_REL || rel.startsWith(`${TASTE_MEDIA_REL}/`)) return true;
	return isLockExempt(rel);
}
