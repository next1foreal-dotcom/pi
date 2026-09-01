/**
 * G-403 — shadow-git checkpoints. Every git call uses --git-dir/--work-tree
 * against a store under memoryRoot; the real repo .git is never the target.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type GitRunResult = {
	stdout: string;
	stderr: string;
	status: number;
};

export type GitRunner = (argv: string[]) => GitRunResult;

export type CheckpointMeta = {
	sessionId?: string;
	label?: string;
	/** G-403.1 — stage only these paths (hot path); empty = whole tree. */
	paths?: string[];
};

export type CaptureResult = {
	id: string;
	at: string;
	changedFiles: string[];
	created: boolean;
};

export type CheckpointInfo = {
	id: string;
	at: string;
	sessionId?: string;
	label?: string;
	changedCount: number;
};

export type RestoreSkip = {
	path: string;
	reason: string;
};

export type RestoreReport = {
	restored: string[];
	skipped: RestoreSkip[];
	preRewindCheckpointId: string;
};

export type RestoreCheckpointOptions = {
	runner?: GitRunner;
};

const EXCLUDE_LINES = [
	"node_modules/",
	".next/",
	"dist/",
	"build/",
	".venv/",
	"target/",
	".turbo/",
	"coverage/",
	"*.log",
] as const;

export function defaultGitRunner(argv: string[]): GitRunResult {
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_OBJECT_DIRECTORY;
	delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
	const spawned = spawnSync("git", argv, {
		encoding: "utf8",
		env,
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
		windowsHide: true,
	});
	if (spawned.error) {
		return {
			status: 1,
			stdout: spawned.stdout ?? "",
			stderr: spawned.error.message,
		};
	}
	return {
		status: spawned.status ?? 1,
		stdout: spawned.stdout ?? "",
		stderr: spawned.stderr ?? "",
	};
}

export function ensureStore(memoryRoot: string, repoRoot: string, runner: GitRunner = defaultGitRunner): string {
	const gitDir = storeDir(memoryRoot, repoRoot);
	const workTree = resolve(repoRoot);
	mkdirSync(dirname(gitDir), { recursive: true });
	if (!existsSync(join(gitDir, "HEAD"))) {
		runGit(runner, gitDir, workTree, ["init"]);
	}
	runGit(runner, gitDir, workTree, ["config", "user.name", "her-checkpoint"]);
	runGit(runner, gitDir, workTree, ["config", "user.email", "her-checkpoint@local"]);
	runGit(runner, gitDir, workTree, ["config", "commit.gpgsign", "false"]);
	runGit(runner, gitDir, workTree, ["config", "core.autocrlf", "false"]);
	runGit(runner, gitDir, workTree, ["config", "core.quotepath", "false"]);
	mkdirSync(join(gitDir, "info"), { recursive: true });
	writeFileSync(join(gitDir, "info", "exclude"), `${EXCLUDE_LINES.join("\n")}\n`);
	return gitDir;
}

export function captureCheckpoint(
	memoryRoot: string,
	repoRoot: string,
	meta: CheckpointMeta = {},
	runner: GitRunner = defaultGitRunner,
): CaptureResult {
	const gitDir = ensureStore(memoryRoot, repoRoot, runner);
	const workTree = resolve(repoRoot);
	const at = new Date().toISOString();
	// G-403.1 — stage only what this checkpoint is about. `add -A` walks the whole
	// tree, which measured **7m20s** on the samantha monorepo (live, 2026-09-01) and
	// therefore blew the 60s budget on EVERY mutating turn: the snapshot never
	// landed and each turn paid a minute for nothing. Scoped paths make the hot
	// path O(files she is about to touch). `meta.paths` empty/absent still means
	// whole-tree, which is what an explicit "snapshot everything" caller wants —
	// it is just never the per-turn caller any more.
	const scoped = (meta.paths ?? []).filter((p) => p.trim().length > 0);
	runGit(runner, gitDir, workTree, scoped.length > 0 ? ["add", "--", ...scoped] : ["add", "-A"]);
	const dirty = runGit(runner, gitDir, workTree, ["diff", "--cached", "--quiet"], [0, 1]);
	if (dirty.status === 0) {
		return { id: headId(runner, gitDir, workTree), at, changedFiles: [], created: false };
	}
	const changedFiles = nulNames(runGit(runner, gitDir, workTree, ["diff", "--cached", "--name-only", "-z"]).stdout);
	runGit(runner, gitDir, workTree, ["commit", "-m", commitMessage(meta, at)]);
	return { id: headId(runner, gitDir, workTree), at, changedFiles, created: true };
}

export function listCheckpoints(
	memoryRoot: string,
	repoRoot: string,
	limit = 50,
	runner: GitRunner = defaultGitRunner,
): CheckpointInfo[] {
	const gitDir = storeDir(memoryRoot, repoRoot);
	const workTree = resolve(repoRoot);
	if (!existsSync(join(gitDir, "HEAD"))) return [];
	const take = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
	const log = runGit(runner, gitDir, workTree, ["log", "-n", String(take), "--format=%H"], [0, 128]);
	if (log.status !== 0) return [];
	const ids = log.stdout.split(/\r?\n/).filter((id) => id.length > 0);
	return ids.map((id) => {
		const pretty = runGit(runner, gitDir, workTree, ["log", "-1", "--format=%cI%x00%B", id]);
		const splitAt = pretty.stdout.indexOf("\0");
		const committerDate = (splitAt === -1 ? pretty.stdout : pretty.stdout.slice(0, splitAt)).trim();
		const body = splitAt === -1 ? "" : pretty.stdout.slice(splitAt + 1);
		const meta = parseMeta(body);
		const names = nulNames(
			runGit(runner, gitDir, workTree, ["diff-tree", "--no-commit-id", "--name-only", "--root", "-r", "-z", id])
				.stdout,
		);
		const row: CheckpointInfo = {
			id,
			at: meta.at ?? committerDate,
			changedCount: names.length,
		};
		if (meta.sessionId) row.sessionId = meta.sessionId;
		if (meta.label) row.label = meta.label;
		return row;
	});
}

export function restoreCheckpoint(
	memoryRoot: string,
	repoRoot: string,
	id: string,
	opts?: RestoreCheckpointOptions,
): RestoreReport {
	const runner = opts?.runner ?? defaultGitRunner;
	const gitDir = ensureStore(memoryRoot, repoRoot, runner);
	const workTree = resolve(repoRoot);
	const targetId = id.trim();
	if (!targetId) throw new Error("git restore aborted: missing checkpoint id");

	const selfie = captureCheckpoint(memoryRoot, repoRoot, { label: "pre-rewind" }, runner);
	if (!selfie.id) {
		throw new Error("git restore aborted: pre-rewind checkpoint has no HEAD");
	}

	const diff = runGit(runner, gitDir, workTree, ["diff", "--name-only", "-z", targetId, selfie.id]);
	const restored: string[] = [];
	const skipped: RestoreSkip[] = [];

	for (const path of nulNames(diff.stdout)) {
		const inTarget = runGit(runner, gitDir, workTree, ["cat-file", "-e", `${targetId}:${path}`], [0, 128]);
		if (inTarget.status !== 0) {
			skipped.push({ path, reason: "not present in checkpoint" });
			continue;
		}
		const vsSelfie = runGit(runner, gitDir, workTree, ["diff", "--quiet", selfie.id, "--", path], [0, 1]);
		if (vsSelfie.status !== 0) {
			skipped.push({ path, reason: "changed after pre-rewind snapshot" });
			continue;
		}
		runGit(runner, gitDir, workTree, ["checkout", targetId, "--", path]);
		restored.push(path);
	}

	return { restored, skipped, preRewindCheckpointId: selfie.id };
}

export function pruneCheckpoints(
	memoryRoot: string,
	repoRoot: string,
	keep = 50,
	runner: GitRunner = defaultGitRunner,
): void {
	const gitDir = ensureStore(memoryRoot, repoRoot, runner);
	const workTree = resolve(repoRoot);
	const keepCount = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 50;
	const all = listCheckpoints(memoryRoot, repoRoot, 1_000_000, runner);
	if (all.length <= keepCount) return;
	const oldestKept = all[keepCount - 1];
	if (!oldestKept) return;
	writeFileSync(join(gitDir, "shallow"), `${oldestKept.id}\n`);
	runGit(runner, gitDir, workTree, ["reflog", "expire", "--expire=now", "--all"]);
	runGit(runner, gitDir, workTree, ["gc", "--prune=now"]);
}

function storeDir(memoryRoot: string, repoRoot: string): string {
	return join(resolve(memoryRoot), ".her", "checkpoints", `${repoKey(repoRoot)}.git`);
}

function repoKey(repoRoot: string): string {
	const resolved = resolve(repoRoot).replace(/^([A-Za-z]):/, (_, letter: string) => `${letter.toLowerCase()}:`);
	return resolved.replace(/[^A-Za-z0-9._-]/g, "-");
}

function runGit(
	runner: GitRunner,
	gitDir: string,
	workTree: string,
	args: string[],
	allowStatuses: number[] = [0],
): GitRunResult {
	const argv = [`--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args];
	const result = runner(argv);
	if (!allowStatuses.includes(result.status)) {
		throw new Error(`git ${argv.join(" ")} failed (exit ${result.status}): ${result.stderr}`);
	}
	return result;
}

function headId(runner: GitRunner, gitDir: string, workTree: string): string {
	const parsed = runGit(runner, gitDir, workTree, ["rev-parse", "--verify", "HEAD"], [0, 128]);
	if (parsed.status !== 0) return "";
	return parsed.stdout.trim();
}

function commitMessage(meta: CheckpointMeta, at: string): string {
	const payload: Record<string, string> = { at };
	if (meta.sessionId) payload.sessionId = meta.sessionId;
	if (meta.label) payload.label = meta.label;
	return JSON.stringify(payload);
}

function parseMeta(body: string): { at?: string; sessionId?: string; label?: string } {
	try {
		const parsed: unknown = JSON.parse(body.trim());
		if (parsed === null || typeof parsed !== "object") return {};
		const rec = parsed as Record<string, unknown>;
		return {
			...(typeof rec.at === "string" ? { at: rec.at } : {}),
			...(typeof rec.sessionId === "string" ? { sessionId: rec.sessionId } : {}),
			...(typeof rec.label === "string" ? { label: rec.label } : {}),
		};
	} catch {
		return {};
	}
}

function nulNames(stdout: string): string[] {
	return stdout.split("\0").filter((name) => name.length > 0 && name !== "\n" && name !== "\r\n");
}
