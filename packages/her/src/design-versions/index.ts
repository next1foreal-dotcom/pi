/**
 * G-434 — named design checkpoints. Display names hang on
 * refs/notes/her-design; the commit object is never rewritten.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const NOTES_REF = "refs/notes/her-design";
export const MAX_NAME_LENGTH = 80;
const GIT_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RESTORE_COMMAND = "git switch --detach";

export interface Checkpoint {
	oid: string;
	at: string;
	subject: string;
	name: string | null;
}

export interface CheckpointOptions {
	repoRoot?: string;
	limit?: number;
	gitBin?: string;
}

export interface NameCheckpointResult {
	ok: boolean;
	error?: string;
	truncated?: boolean;
	name?: string;
	oid?: string;
}

export interface ShowCheckpointResult {
	ok: boolean;
	error?: string;
	checkpoint?: Checkpoint;
}

export interface DesignCheckpointToolDeps {
	repoRoot?: string;
	gitBin?: string;
}

type GitResult = {
	status: number;
	stdout: string;
	stderr: string;
};

function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_COMMON_DIR",
		"GIT_NOTES_REF",
	]) {
		delete env[key];
	}
	return env;
}

function repoOf(opts: CheckpointOptions = {}): string {
	return resolve(opts.repoRoot ?? process.cwd());
}

function runGit(args: string[], opts: CheckpointOptions = {}): GitResult {
	const argv = [
		"-C",
		repoOf(opts),
		"-c",
		"commit.gpgsign=false",
		"-c",
		"core.quotepath=false",
		"-c",
		"i18n.logOutputEncoding=utf-8",
		...args,
	];
	const spawned = spawnSync(opts.gitBin ?? "git", argv, {
		cwd: repoOf(opts),
		encoding: "utf8",
		env: gitEnv(),
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (spawned.error) {
		const err = spawned.error as NodeJS.ErrnoException & { killed?: boolean };
		const timedOut = err.code === "ETIMEDOUT" || err.killed === true;
		return {
			status: 1,
			stdout: spawned.stdout ?? "",
			stderr: timedOut ? `git timed out after ${GIT_TIMEOUT_MS}ms` : err.message,
		};
	}
	return {
		status: spawned.status ?? 1,
		stdout: spawned.stdout ?? "",
		stderr: spawned.stderr ?? "",
	};
}

function gitError(result: GitResult, fallback: string): string {
	const text = `${result.stderr}\n${result.stdout}`.trim();
	return text.length > 0 ? text : fallback;
}

function insideWorkTree(opts: CheckpointOptions = {}): boolean {
	const result = runGit(["rev-parse", "--is-inside-work-tree"], opts);
	return result.status === 0 && result.stdout.trim() === "true";
}

function takeLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
	return Math.min(Math.floor(limit), MAX_LIMIT);
}

function noteName(raw: string): string | null {
	const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
	return text.length === 0 ? null : text;
}

function parseLog(stdout: string): Checkpoint[] {
	const rows: Checkpoint[] = [];
	for (const record of stdout.split("\x1e")) {
		const trimmed = record.replace(/^\r?\n/, "");
		if (trimmed.length === 0) continue;
		const parts = trimmed.split("\0");
		const oid = parts[0]?.trim() ?? "";
		if (!oid) continue;
		rows.push({
			oid,
			at: parts[1]?.trim() ?? "",
			subject: parts[2] ?? "",
			name: noteName(parts[3] ?? ""),
		});
	}
	return rows;
}

function namedFirst(rows: Checkpoint[]): Checkpoint[] {
	return [...rows.filter((row) => row.name !== null), ...rows.filter((row) => row.name === null)];
}

function logFormatArgs(oid: string | undefined, limit: number): string[] {
	const args = ["log", `--notes=${NOTES_REF}`, "--pretty=format:%H%x00%cI%x00%s%x00%N%x1e"];
	if (oid) {
		args.push("-1", oid);
	} else {
		args.push("-n", String(limit));
	}
	return args;
}

function readCheckpoints(opts: CheckpointOptions = {}): { ok: boolean; checkpoints: Checkpoint[]; error?: string } {
	try {
		if (!insideWorkTree(opts)) {
			return { ok: false, checkpoints: [], error: "not a git repository" };
		}
		const result = runGit(logFormatArgs(undefined, takeLimit(opts.limit)), opts);
		if (result.status !== 0) {
			const message = gitError(result, "git log failed");
			if (/does not have any commits|bad revision|unknown revision/i.test(message)) {
				return { ok: true, checkpoints: [] };
			}
			return { ok: false, checkpoints: [], error: message };
		}
		return { ok: true, checkpoints: namedFirst(parseLog(result.stdout)) };
	} catch (error) {
		return {
			ok: false,
			checkpoints: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function prepareName(name: string): { ok: true; name: string; truncated: boolean } | { ok: false; error: string } {
	if (name.includes("\0")) return { ok: false, error: "name contains a NUL byte" };
	if (name.length === 0) return { ok: false, error: "name is empty" };
	if (name.length <= MAX_NAME_LENGTH) return { ok: true, name, truncated: false };
	return { ok: true, name: name.slice(0, MAX_NAME_LENGTH), truncated: true };
}

/**
 * Store the display name via `git notes add -f -F <file>`. The name is written
 * to a temp file so quotes, newlines, and non-ASCII never go through a shell
 * or Windows command-line quoting.
 */
function addNote(oid: string, name: string, opts: CheckpointOptions): GitResult {
	const dir = mkdtempSync(join(tmpdir(), "her-design-note-"));
	const file = join(dir, "name");
	try {
		writeFileSync(file, name.endsWith("\n") ? name : `${name}\n`, "utf8");
		return runGit(["notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", file, oid], opts);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function listCheckpoints(opts: CheckpointOptions = {}): Checkpoint[] {
	return readCheckpoints(opts).checkpoints;
}

export function nameCheckpoint(oid: string, name: string, opts: CheckpointOptions = {}): NameCheckpointResult {
	try {
		const prepared = prepareName(name);
		if (!prepared.ok) return { ok: false, error: prepared.error };
		if (!insideWorkTree(opts)) return { ok: false, error: "not a git repository" };
		const target = oid.trim() || "HEAD";
		const parsed = runGit(["rev-parse", "--verify", `${target}^{commit}`], opts);
		if (parsed.status !== 0) {
			return { ok: false, error: gitError(parsed, `cannot resolve ${target}`) };
		}
		const fullOid = parsed.stdout.trim();
		const added = addNote(fullOid, prepared.name, opts);
		if (added.status !== 0) {
			return { ok: false, error: gitError(added, "git notes add failed") };
		}
		return { ok: true, truncated: prepared.truncated, name: prepared.name, oid: fullOid };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function showCheckpoint(oid: string, opts: CheckpointOptions = {}): ShowCheckpointResult {
	try {
		if (!insideWorkTree(opts)) return { ok: false, error: "not a git repository" };
		const target = oid.trim() || "HEAD";
		const result = runGit(logFormatArgs(target, 1), opts);
		if (result.status !== 0) {
			return { ok: false, error: gitError(result, `cannot show ${target}`) };
		}
		const [checkpoint] = parseLog(result.stdout);
		if (!checkpoint) return { ok: false, error: `cannot show ${target}` };
		return { ok: true, checkpoint };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function textResult(text: string, details: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function markLine(row: Checkpoint): string {
	const mark = row.name ? "*" : " ";
	const label = row.name ?? "(unnamed)";
	return `${mark} ${label}\n  ${row.oid.slice(0, 8)}  ${row.at}  ${row.subject}`;
}

function renderList(rows: Checkpoint[]): string {
	if (rows.length === 0) return "No design checkpoints.";
	return `Design checkpoints (${rows.length}; named first):\n${rows.map(markLine).join("\n")}`;
}

function renderShow(row: Checkpoint): string {
	const name = row.name ?? "(unnamed)";
	return [
		row.oid,
		`subject: ${row.subject}`,
		`name: ${name}`,
		`date: ${row.at}`,
		"",
		`This tool is read-only. It does not restore or change the working tree.`,
		`To restore this commit in your own terminal: ${RESTORE_COMMAND} ${row.oid}`,
	].join("\n");
}

export function registerDesignVersionTools(pi: ExtensionAPI, deps: DesignCheckpointToolDeps = {}): void {
	const opts = (): CheckpointOptions => ({
		...(deps.repoRoot ? { repoRoot: deps.repoRoot } : {}),
		...(deps.gitBin ? { gitBin: deps.gitBin } : {}),
	});

	pi.registerTool({
		name: "design_version_name",
		label: "Design Checkpoint Name",
		description:
			"Give a display name to a design checkpoint commit (default HEAD). Names are for humans: " +
			"write what it looks like, e.g. 'three columns + generous whitespace', not 'v2' or 'improved'. " +
			`Stored on ${NOTES_REF} with git notes add -f; the commit hash does not change. ` +
			"This does not restore or check out anything.",
		parameters: Type.Object({
			name: Type.String({
				description: "Human display name. Say what it looks like. Max 80 characters; longer names are truncated.",
			}),
			oid: Type.Optional(Type.String({ description: "Commit to name. Defaults to HEAD." })),
		}),
		async execute(_toolCallId, params) {
			const result = nameCheckpoint(params.oid ?? "HEAD", params.name, opts());
			if (!result.ok) {
				return textResult(result.error ?? "failed to name checkpoint", { ok: false, error: result.error });
			}
			const shown = result.name ?? params.name;
			const text = result.truncated
				? `Named ${result.oid?.slice(0, 8) ?? "commit"} as "${shown}" (truncated to ${MAX_NAME_LENGTH} characters).`
				: `Named ${result.oid?.slice(0, 8) ?? "commit"} as "${shown}".`;
			return textResult(text, { ...result, ok: true });
		},
	});

	pi.registerTool({
		name: "design_version_list",
		label: "Design Checkpoint List",
		description:
			"List recent design checkpoints. Named ones are listed first and marked with *. " +
			`Names live on ${NOTES_REF}. Read-only — does not restore, checkout, or change the working tree. ` +
			`To restore a commit, run this yourself in a terminal: ${RESTORE_COMMAND} <oid>`,
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_LIMIT,
					description: "How many recent commits to list. Default 20.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const loaded = readCheckpoints({ ...opts(), limit: params.limit });
			if (!loaded.ok) {
				return textResult(loaded.error ?? "failed to list checkpoints", { ok: false, error: loaded.error });
			}
			return textResult(renderList(loaded.checkpoints), { ok: true, checkpoints: loaded.checkpoints });
		},
	});

	pi.registerTool({
		name: "design_version_show",
		label: "Design Checkpoint Show",
		description:
			"Show one design checkpoint: subject, display name, and date. " +
			"Read-only — this tool does not restore, checkout, or change the working tree. " +
			`To restore that exact commit, run this yourself in a terminal: ${RESTORE_COMMAND} <oid>`,
		parameters: Type.Object({
			oid: Type.String({ description: "Commit to show." }),
		}),
		async execute(_toolCallId, params) {
			const result = showCheckpoint(params.oid, opts());
			if (!result.ok || !result.checkpoint) {
				return textResult(result.error ?? "failed to show checkpoint", { ok: false, error: result.error });
			}
			return textResult(renderShow(result.checkpoint), { ok: true, checkpoint: result.checkpoint });
		},
	});
}
