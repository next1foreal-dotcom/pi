import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
import {
	type CanvasEvent,
	CURSOR_START,
	cursorOf,
	isSpeakingEvent,
	parseFeed,
	projectThreads,
	readSince,
	serializeEvent,
	type Thread,
} from "./feed.ts";

const HEAD_CACHE_MS = 2000;
const HEAD_GIT_TIMEOUT_MS = 5_000;

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

function readSamanthaHead(): string | undefined {
	try {
		const spawned = spawnSync("git", ["-C", SAMANTHA_REPO_ROOT, "rev-parse", "HEAD"], {
			encoding: "utf8",
			env: gitEnv(),
			timeout: HEAD_GIT_TIMEOUT_MS,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (spawned.error || spawned.status !== 0) return undefined;
		const oid = (spawned.stdout ?? "").trim();
		return oid.length > 0 ? oid : undefined;
	} catch {
		return undefined;
	}
}

let readHeadOid: () => string | undefined = readSamanthaHead;
let nowMs: () => number = Date.now;
let cachedHead: { oid: string | undefined; at: number } | null = null;

/**
 * Test seam: swap the HEAD reader / clock and drop the 2s cache.
 * Production always reads `git rev-parse HEAD` in the samantha repo.
 */
export function resetHeadCacheForTest(opts?: { read?: () => string | undefined; now?: () => number }): void {
	cachedHead = null;
	readHeadOid = opts?.read ?? readSamanthaHead;
	nowMs = opts?.now ?? Date.now;
}

function currentHeadOid(): string | undefined {
	const at = nowMs();
	if (cachedHead && at - cachedHead.at < HEAD_CACHE_MS) return cachedHead.oid;
	let oid: string | undefined;
	try {
		oid = readHeadOid();
	} catch {
		oid = undefined;
	}
	if (typeof oid === "string") {
		const trimmed = oid.trim();
		oid = trimmed.length > 0 ? trimmed : undefined;
	} else {
		oid = undefined;
	}
	cachedHead = { oid, at };
	return oid;
}

/**
 * Drop any client-supplied `oid`, then stamp speaking events with HEAD.
 * A missing git is silence, not a failed write.
 */
export function stampOidOnEvent(event: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = { ...event };
	delete next.oid;
	if (typeof next.t === "string" && isSpeakingEvent(next.t)) {
		const oid = currentHeadOid();
		if (oid) next.oid = oid;
	}
	return next;
}

/** Everything the design canvas has ever been told, one event per line. */
export function feedPath(repoRoot: string = SAMANTHA_REPO_ROOT): string {
	return join(repoRoot, "design", "canvas", "feed.jsonl");
}

/** Where she left off reading. Not in the feed: it is hers, not a fact about the canvas. */
export function cursorPath(repoRoot: string = SAMANTHA_REPO_ROOT): string {
	return join(repoRoot, "design", "canvas", "read-cursor.json");
}

export function readFeedText(repoRoot?: string): string {
	const file = feedPath(repoRoot);
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/**
 * One line, one `O_APPEND` write. That is the whole concurrency story: the
 * browser and her runtime both append here, and neither picks a sequence
 * number, so neither can pick the same one.
 */
export function appendEvent(event: CanvasEvent, repoRoot?: string): void {
	const file = feedPath(repoRoot);
	mkdirSync(dirname(file), { recursive: true });
	const stamped = stampOidOnEvent(event as unknown as Record<string, unknown>) as CanvasEvent;
	appendFileSync(file, serializeEvent(stamped), "utf8");
}

export function readCursor(repoRoot?: string): string {
	const file = cursorPath(repoRoot);
	if (!existsSync(file)) return CURSOR_START;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { cursor?: unknown };
		return typeof raw.cursor === "string" ? raw.cursor : CURSOR_START;
	} catch {
		return CURSOR_START;
	}
}

export function writeCursor(cursor: string, repoRoot?: string): void {
	const file = cursorPath(repoRoot);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ cursor }, null, 2)}\n`, "utf8");
}

export interface CanvasReading {
	/** Written since she last looked. */
	fresh: Thread[];
	/**
	 * Every unresolved thread, whatever the cursor says.
	 *
	 * This is the backstop that makes advancing the cursor on read safe: if a
	 * page is ever lost — a crash, a cursor file wiped, two reads racing — the
	 * feedback is still sitting right here. Without it, "what's new" would be
	 * the only view and a dropped page would mean a note Fei wrote that she
	 * never sees and he assumes she read.
	 */
	open: Thread[];
	cursor: string;
	/** Threads touched by the fresh events, so she can see what changed. */
	freshIds: string[];
}

/**
 * What the canvas has to say. `since` defaults to where she left off; the
 * stored cursor advances so the next call shows only what arrived after.
 */
export function readCanvas(
	opts: { since?: string; screenId?: string; repoRoot?: string; advance?: boolean } = {},
): CanvasReading {
	const text = readFeedText(opts.repoRoot);
	const since = opts.since ?? readCursor(opts.repoRoot);
	const page = readSince(text, since);
	const all = projectThreads(parseFeed(text));

	// "New" means new TO HER, which is about who wrote it — not about the
	// cursor having moved. Her own reply and resolve append events too, and
	// counting those announced her own words back to her as fresh feedback and
	// kept nagging about a thread she had just closed.
	const touched = new Set<string>();
	for (const e of page.events) {
		if (e.author === "samantha") continue;
		touched.add("noteId" in e ? e.noteId : e.id);
	}

	const onScreen = (t: Thread) => !opts.screenId || t.screenId === opts.screenId;
	const fresh = all.filter((t) => touched.has(t.id)).filter(onScreen);
	const open = all.filter((t) => !t.resolved).filter(onScreen);

	if (opts.advance !== false) writeCursor(page.cursor, opts.repoRoot);

	return { fresh, open, cursor: page.cursor, freshIds: [...touched] };
}

/** The canvas as it stands, ignoring cursors entirely. */
export function allThreads(repoRoot?: string): Thread[] {
	return projectThreads(parseFeed(readFeedText(repoRoot)));
}

export { cursorOf, CURSOR_START };
