import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
import {
	type CanvasEvent,
	CURSOR_START,
	cursorOf,
	parseFeed,
	projectThreads,
	readSince,
	serializeEvent,
	type Thread,
} from "./feed.ts";

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
	appendFileSync(file, serializeEvent(event), "utf8");
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
