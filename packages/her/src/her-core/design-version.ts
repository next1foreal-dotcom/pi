import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A design's versions, which are its commits.
 *
 * The ledger (`design-project.ts`) has always recorded WHAT changed in a round
 * and never WHICH VERSION that round produced — `IterationRecord` was a
 * sentence and a timestamp. So "put yesterday's back" had no answer inside the
 * lab: the answer was for someone to go and read git by hand.
 *
 * ── a version is a commit, and nothing new is stored ─────────────────────
 * The screens are real files in this repo, so their history already exists and
 * is already complete. Copying them into a parallel snapshot store would make
 * a second source of truth for the same bytes, which the repo's first
 * architecture invariant forbids in as many words: derived stores are
 * rebuildable indexes, never the truth. What was missing was not storage. It
 * was a pointer, and a way to walk back along it.
 *
 * ── what belongs to a design ─────────────────────────────────────────────
 * Two directories: the screen's source under the lab, and the project's own
 * notes. Deliberately NOT the manifest. The manifest is the record OF the
 * history — restoring it would erase the entry that says a restore happened,
 * which is the one line you most want afterwards.
 *
 * ── restoring is a working-tree write and nothing more ───────────────────
 * `git checkout <commit> -- <paths>` puts old bytes in the working tree. No
 * history is rewritten, no commit is made, nothing is pushed; git itself can
 * undo every part of it. It still asks before it does it, and it still shows
 * the file list first, because "I meant the other version" is a thing people
 * say.
 *
 * This does not contradict the stance `design-versions/index.ts` takes. That
 * one refuses to restore and tells you to run `git switch --detach <oid>`
 * yourself, and it is right to: switching MOVES HEAD, which changes the whole
 * repo out from under every other session working in it. Checking out one path
 * moves nothing. Different operation, different answer — worth saying, because
 * from the outside both are spelled "go back to that version".
 *
 * ── this is the second half of a thing that already half existed ─────────
 * G-434 built named checkpoints: `design_version_name` hangs a human name on a
 * commit at refs/notes/her-design, and `design_version_list` shows recent ones
 * across the whole repo. What it could not do was answer "which versions does
 * THIS design have" or put one back. Those two gaps are what this fills, and
 * the names are read back in below rather than invented again — one system
 * with two halves, not two systems.
 */

/** Long enough for a cold `git log` on a big repo, short enough to fail loud. */
const GIT_TIMEOUT_MS = 20_000;
/** Versions returned when the caller does not say. A design does not have many. */
export const DEFAULT_VERSION_LIMIT = 20;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Record and field separators, written as escapes on purpose.
 *
 * A commit subject can hold anything a person types, so the format needs
 * delimiters that cannot appear inside one. ASCII 0x1e and 0x1f exist for
 * exactly this and git emits them for `%x1e` / `%x1f`.
 *
 * They are escapes here rather than the characters themselves because a raw
 * control byte in a source file survives every check and is invisible in every
 * diff. The first draft of this file had the characters inline and picked up a
 * NUL on the way to disk; nothing caught it but a byte scan, and `grep` had
 * already started calling the file binary.
 */
const RECORD_SEP = "\u001e";
const FIELD_SEP = "\u001f";

/** Runs git and hands back stdout. Injected so tests do not need a repo. */
export type GitRun = (cwd: string, args: readonly string[]) => Promise<string>;

export const defaultGitRun: GitRun = async (cwd, args) => {
	const { stdout } = await execFileAsync("git", [...args], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 8 * 1024 * 1024,
	});
	return stdout;
};

export interface DesignVersion {
	/** Full 40-character sha. The thing to hand back to `restoreDesign`. */
	commit: string;
	/** First line of the commit message. */
	subject: string;
	/** Author date, ISO 8601. */
	at: string;
	/** Files under this design that the commit touched. */
	files: string[];
	/**
	 * The display name someone gave this commit with `design_version_name`,
	 * from refs/notes/her-design. Null for the many that have none — naming is
	 * how a person marks the handful worth coming back to.
	 */
	name: string | null;
}

export interface RestorePlan {
	commit: string;
	/** Repo-relative paths that would change. Empty means already identical. */
	files: string[];
	/** False until the caller says so; nothing is written while it is false. */
	applied: boolean;
}

export function validateDesignSlug(slug: string): void {
	if (!SLUG_RE.test(slug)) {
		throw new Error(`Invalid design slug "${slug}" — lowercase letters, digits and hyphens only`);
	}
}

/**
 * The paths that ARE the design, repo-relative and in git's own separator.
 *
 * The manifest is not here, on purpose; see the note at the top of the file.
 * Both paths are offered even when one does not exist — git is content to be
 * asked about a path with no history, and answering "no versions yet" is
 * better than refusing a design that exists but was never committed.
 */
export function designPaths(slug: string): string[] {
	validateDesignSlug(slug);
	return [`packages/design-lab/src/screens/${slug}`, `design/projects/${slug}`];
}

/** Where G-434 keeps the display names. Same ref that tool writes. */
export const NOTES_REF = "refs/notes/her-design";

/** Where `design_lab_still` photographs this design, if it has been. */
export function stillPath(slug: string): string {
	validateDesignSlug(slug);
	return `design/stills/${slug}-top.png`;
}

/**
 * Split out from `listVersions` so the shape of git's answer can be tested
 * without a repo, which is the half that actually breaks.
 */
export function parseVersionLog(stdout: string): DesignVersion[] {
	const out: DesignVersion[] = [];
	for (const chunk of stdout.split(RECORD_SEP)) {
		if (!chunk.trim()) continue;
		const newline = chunk.indexOf("\n");
		const head = newline === -1 ? chunk : chunk.slice(0, newline);
		const rest = newline === -1 ? "" : chunk.slice(newline + 1);
		const [commit, at, subject] = head.split(FIELD_SEP);
		if (!commit || !at) continue;
		out.push({
			commit,
			at,
			subject: subject ?? "",
			name: null,
			files: rest
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		});
	}
	return out;
}

/**
 * The design's commits, newest first.
 *
 * `--follow` is not used: it only works for a single path, and a design is two
 * directories. A rename inside one of them therefore starts a new history,
 * which is the honest answer — the old bytes are still reachable by the old
 * path, and pretending otherwise would offer a restore that puts files back
 * under names that no longer exist.
 */
export async function listVersions(
	slug: string,
	repoRoot: string,
	opts: { limit?: number; run?: GitRun } = {},
): Promise<DesignVersion[]> {
	const run = opts.run ?? defaultGitRun;
	const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_VERSION_LIMIT, 200));
	const stdout = await run(repoRoot, [
		"log",
		`--max-count=${limit}`,
		"--format=%x1e%H%x1f%aI%x1f%s",
		"--name-only",
		"--",
		...designPaths(slug),
	]);
	const versions = parseVersionLog(stdout);
	return attachNames(versions, await readNames(repoRoot, versions, run));
}

/**
 * The display names for a set of commits, in one call.
 *
 * `git log --notes` prints the note body inline, so one pass over the same
 * commits gets every name; asking per commit would be a round trip each. A
 * repo with no notes ref at all answers with an error on some git versions and
 * an empty body on others, so both are read as "no names" — a design whose
 * versions are all unnamed is the normal case, not a fault.
 */
async function readNames(repoRoot: string, versions: DesignVersion[], run: GitRun): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	if (versions.length === 0) return names;
	try {
		const stdout = await run(repoRoot, [
			"log",
			"--no-walk",
			`--notes=${NOTES_REF}`,
			"--format=%x1e%H%x1f%N",
			...versions.map((v) => v.commit),
		]);
		for (const chunk of stdout.split(RECORD_SEP)) {
			if (!chunk.trim()) continue;
			const [commit, body] = chunk.split(FIELD_SEP);
			const name = (body ?? "").trim();
			if (commit && name) names.set(commit.trim(), name);
		}
	} catch {
		// No notes ref, or a git too old for --no-walk with a list. Unnamed is
		// a perfectly good answer and not worth failing the whole listing over.
	}
	return names;
}

function attachNames(versions: DesignVersion[], names: Map<string, string>): DesignVersion[] {
	return versions.map((v) => ({ ...v, name: names.get(v.commit) ?? null }));
}

/**
 * Edits under this design that no version holds yet.
 *
 * Worth saying out loud before a restore: uncommitted work under these paths is
 * what a checkout overwrites, and it is the only part of this that git cannot
 * give back.
 */
export async function uncommittedFiles(slug: string, repoRoot: string, opts: { run?: GitRun } = {}): Promise<string[]> {
	const run = opts.run ?? defaultGitRun;
	const stdout = await run(repoRoot, ["status", "--porcelain", "--", ...designPaths(slug)]);
	return stdout
		.split("\n")
		.map((line) => line.slice(3).trim())
		.filter(Boolean);
}

/**
 * Put a version's bytes back into the working tree.
 *
 * Two steps, always in this order, and the first happens even when the caller
 * asked for the second: work out what would change, and only then change it.
 * `apply: false` stops after the first — that is the default, and it is what
 * makes "which version was it again?" a cheap question.
 *
 * Nothing is committed. The restore lands as ordinary working-tree edits, to be
 * looked at, kept or thrown away like any others.
 */
export async function restoreDesign(
	slug: string,
	commit: string,
	repoRoot: string,
	opts: { apply?: boolean; run?: GitRun } = {},
): Promise<RestorePlan> {
	const run = opts.run ?? defaultGitRun;
	const paths = designPaths(slug);
	if (!/^[0-9a-fA-F]{7,40}$/.test(commit)) {
		throw new Error(`Invalid commit "${commit}" — expected a git sha`);
	}
	const diff = await run(repoRoot, ["diff", "--name-only", commit, "--", ...paths]);
	const files = diff
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (!opts.apply || files.length === 0) {
		return { commit, files, applied: false };
	}
	await run(repoRoot, ["checkout", commit, "--", ...paths]);
	return { commit, files, applied: true };
}
