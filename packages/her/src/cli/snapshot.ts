import { resolve } from "node:path";
import {
	createSnapshot,
	DEFAULT_EXTERNAL_SOURCES,
	DEFAULT_SNAPSHOT_PARENT,
	resolveExternalSources,
	resolveSnapshotParent,
	restoreConfirm,
	restoreSnapshot,
	verifySnapshot,
} from "../her-core/snapshot.ts";
import { writeLine } from "./render.ts";
import type { CliIo } from "./types.ts";
import { errorMessage, UsageError } from "./utils.ts";

export async function runSnapshotCreateCommand(
	args: string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
	io: CliIo,
): Promise<number> {
	try {
		const sameVolumeOk = parseCreateArgs(args);
		const result = await createSnapshot({
			externalSources: resolveExternalSources(env, DEFAULT_EXTERNAL_SOURCES),
			sameVolumeOk,
			snapshotParent: resolve(cwd, resolveSnapshotParent(env, DEFAULT_SNAPSHOT_PARENT)),
			sourceRoot: memoryDir(env, cwd),
		});
		writeLine(io.stdout, `snapshot: ${result.snapshotDir}`);
		writeLine(io.stdout, `files: ${result.fileCount}`);
		writeLine(io.stdout, `bytes: ${result.totalBytes}`);
		if (result.freeSpaceWarning) {
			writeLine(io.stderr, "warning: free space on destination volume is less than 3x snapshot size");
		}
		return 0;
	} catch (error) {
		return fail(io, error);
	}
}

export async function runSnapshotVerifyCommand(
	args: string[],
	_env: NodeJS.ProcessEnv,
	cwd: string,
	io: CliIo,
): Promise<number> {
	try {
		const snapshotDir = resolve(cwd, parseOnePath(args, "snapshot-verify"));
		const result = await verifySnapshot(snapshotDir);
		if (result.ok) {
			writeLine(io.stdout, "snapshot-verify: ok");
			return 0;
		}
		for (const diff of result.diffs) writeLine(io.stderr, `${diff.kind}: ${diff.path}`);
		return 1;
	} catch (error) {
		return fail(io, error);
	}
}

export async function runSnapshotRestoreCommand(
	args: string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
	io: CliIo,
): Promise<number> {
	try {
		const parsed = parseRestoreArgs(args);
		const snapshotParent = resolve(cwd, resolveSnapshotParent(env, DEFAULT_SNAPSHOT_PARENT));
		await restoreSnapshot({
			confirm: restoreConfirm(env),
			external: parsed.external,
			liveRoot: memoryDir(env, cwd),
			sameVolumeOk: parsed.sameVolumeOk,
			snapshotDir: resolve(cwd, parsed.snapshotDir),
			snapshotParent,
			targetRoot: resolve(cwd, parsed.targetRoot),
		});
		writeLine(io.stdout, `restored: ${resolve(cwd, parsed.targetRoot)}`);
		return 0;
	} catch (error) {
		return fail(io, error);
	}
}

function parseCreateArgs(args: string[]): boolean {
	let sameVolumeOk = false;
	for (const arg of args) {
		if (arg === "--same-volume-ok") {
			sameVolumeOk = true;
			continue;
		}
		throw new UsageError(`unknown snapshot-create option: ${arg}`);
	}
	return sameVolumeOk;
}

function parseOnePath(args: string[], command: string): string {
	if (args.length !== 1 || args[0].startsWith("--")) throw new UsageError(`${command} requires <snapshot>`);
	return args[0];
}

function parseRestoreArgs(args: string[]): {
	external: boolean;
	sameVolumeOk: boolean;
	snapshotDir: string;
	targetRoot: string;
} {
	let external = false;
	let sameVolumeOk = false;
	const positional: string[] = [];
	for (const arg of args) {
		if (arg === "--external") {
			external = true;
			continue;
		}
		if (arg === "--same-volume-ok") {
			sameVolumeOk = true;
			continue;
		}
		if (arg.startsWith("--")) throw new UsageError(`unknown snapshot-restore option: ${arg}`);
		positional.push(arg);
	}
	if (positional.length !== 2) throw new UsageError("snapshot-restore requires <snapshot> <target>");
	return { external, sameVolumeOk, snapshotDir: positional[0], targetRoot: positional[1] };
}

function memoryDir(env: NodeJS.ProcessEnv, cwd: string): string {
	return resolve(env.HER_MEMORY_DIR ?? resolve(cwd, "..", "her-memory"));
}

function fail(io: CliIo, error: unknown): number {
	writeLine(io.stderr, errorMessage(error));
	return error instanceof UsageError ? 2 : 1;
}
