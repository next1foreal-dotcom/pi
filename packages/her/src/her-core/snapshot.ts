export {
	createSnapshot,
	resolveExternalSources,
	resolveSnapshotParent,
} from "./snapshot-create.ts";
export { toWinAbs } from "./snapshot-paths.ts";
export { restoreConfirm, restoreSnapshot } from "./snapshot-restore.ts";
export type {
	CreateSnapshotOptions,
	CreateSnapshotResult,
	ExternalSource,
	RestoreSnapshotOptions,
	SnapshotManifest,
	VerifyDiff,
	VerifySnapshotResult,
} from "./snapshot-types.ts";
export { DEFAULT_EXTERNAL_SOURCES, DEFAULT_SNAPSHOT_PARENT, SnapshotError } from "./snapshot-types.ts";
export { loadManifest, verifySnapshot } from "./snapshot-verify.ts";
