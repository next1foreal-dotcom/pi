import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git as defaultGit, errorMessage } from "./memory-utils.ts";
import { isSelfmodAllowedPath, isUnsafeSelfmodTarget } from "./selfmod-paths.ts";
import { SELFMOD_PATCH_MAX_BYTES } from "./selfmod-types.ts";
import type { SelfmodGit } from "./selfmod-worktree.ts";

export function patchByteLength(patch: string): number {
	return Buffer.byteLength(patch, "utf8");
}

export function pathsInUnifiedDiff(patch: string): string[] {
	const found = new Set<string>();
	for (const line of patch.split(/\r?\n/)) {
		const gitLine = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
		if (gitLine) {
			found.add(gitLine[1]);
			found.add(gitLine[2]);
			continue;
		}
		const oldLine = /^--- (?:a\/)?(.+?)(?:\t|$)/.exec(line);
		if (oldLine && oldLine[1] !== "/dev/null") found.add(oldLine[1]);
		const newLine = /^\+\+\+ (?:b\/)?(.+?)(?:\t|$)/.exec(line);
		if (newLine && newLine[1] !== "/dev/null") found.add(newLine[1]);
	}
	return [...found];
}

export function invalidPatchPaths(paths: string[]): string[] {
	return paths.filter((path) => isUnsafeSelfmodTarget(path) || !isSelfmodAllowedPath(path));
}

export function applyErrorMessage(error: unknown): string {
	if (error && typeof error === "object" && "stderr" in error) {
		const stderr = String((error as { stderr: unknown }).stderr).trim();
		if (stderr) return stderr;
	}
	return errorMessage(error);
}

export async function applySelfmodPatch(opts: {
	git?: SelfmodGit;
	id: string;
	patch: string;
	worktreePath: string;
}): Promise<void> {
	if (patchByteLength(opts.patch) > SELFMOD_PATCH_MAX_BYTES) {
		throw new Error(`patch exceeds ${SELFMOD_PATCH_MAX_BYTES} bytes`);
	}
	const bad = invalidPatchPaths(pathsInUnifiedDiff(opts.patch));
	if (bad.length > 0) throw new Error(`patch paths outside allowlist: ${bad.join(", ")}`);
	const git = opts.git ?? defaultGit;
	const dir = await mkdtemp(join(tmpdir(), "her-selfmod-patch-"));
	const file = join(dir, "change.patch");
	try {
		await writeFile(file, opts.patch.endsWith("\n") ? opts.patch : `${opts.patch}\n`, "utf8");
		await git(opts.worktreePath, "apply", "--check", file);
		await git(opts.worktreePath, "apply", file);
		await git(opts.worktreePath, "add", "-A");
		await git(opts.worktreePath, "commit", "-q", "-m", `selfmod apply ${opts.id}`);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
}
