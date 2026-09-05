/**
 * The design canvas feedback feed.
 *
 * Fei points at something on the canvas; she reads it here, answers, and marks
 * it done. Before this existed she had eyes and no ears: `design_lab_still`
 * photographs the canvas, so a sticky note reached her as a coloured rectangle
 * she could see but not read, could not answer, and could not tell apart from
 * one she had already handled.
 *
 * Reference UX: tracepaper (MIT, caffeinum/tracepaper @74d2756) — read for the
 * mechanism, not vendored. Two of its hard-won rules are kept:
 *
 *  1. A cursor is a POSITION, never the id of a record. An id gets re-resolved
 *     through that record's live state, so resolving or editing the record a
 *     cursor names drags the boundary past everything written in between and
 *     loses it permanently.
 *  2. An empty page echoes the incoming cursor back. Returning "nothing" as a
 *     null cursor sends the reader back to the start of the feed.
 *
 * Where tracepaper needs `BEGIN IMMEDIATE` transactions so two processes cannot
 * hand out the same sequence number, this log needs none: it is append-only and
 * a record's LINE POSITION is its sequence. Nobody writes a number, so nobody
 * can collide on one, and `O_APPEND` makes each line atomic. Deletes are events
 * rather than erasures, so a cursor outlives the note it happens to name — and
 * that also keeps the invariant this repo already holds for episodic records:
 * everything happened, nothing is edited in place.
 */

/** Who said it. The transport stamps this; a writer never claims it. */
export type Author = "fei" | "samantha";

export type CanvasEvent =
	| {
			t: "note";
			id: string;
			at: string;
			author: Author;
			/** The screen this note sits on, if any — what makes it actionable. */
			screenId: string | null;
			x: number;
			y: number;
			text: string;
			source?: { file: string; line: number; col: number; component: string | null };
	  }
	| {
			t: "note.move";
			id: string;
			at: string;
			author: Author;
			screenId: string | null;
			x: number;
			y: number;
			source?: { file: string; line: number; col: number; component: string | null };
	  }
	| { t: "note.edit"; id: string; at: string; author: Author; text: string }
	| { t: "note.delete"; id: string; at: string; author: Author }
	| { t: "reply"; id: string; noteId: string; at: string; author: Author; text: string }
	| { t: "resolve"; noteId: string; at: string; author: Author; note?: string }
	| { t: "reopen"; noteId: string; at: string; author: Author };

export interface Reply {
	id: string;
	at: string;
	author: Author;
	text: string;
}

export interface Thread {
	id: string;
	at: string;
	author: Author;
	screenId: string | null;
	x: number;
	y: number;
	text: string;
	replies: Reply[];
	/**
	 * Who spoke last on this thread — the test for "is this waiting on her".
	 *
	 * Only speech counts: opening the note, editing its words, replying, or
	 * reopening it. Dragging a note across the canvas is not saying anything,
	 * so a move must not make a thread she has already answered start asking
	 * for her attention again.
	 */
	lastSpoke: Author;
	resolved: boolean;
	resolvedBy?: Author;
	resolvedNote?: string;
}

/** Read from the very beginning. */
export const CURSOR_START = "cur_0";

const CURSOR_RE = /^cur_(\d+)$/;

export function cursorOf(position: number): string {
	return `cur_${position}`;
}

/**
 * A cursor we cannot read means "start from the beginning" rather than an
 * error: a caller that lost its cursor should re-read the feed, not stall. A
 * cursor past the end is not an error either — there is simply nothing after it.
 */
export function positionOf(cursor: string | undefined | null): number {
	const m = CURSOR_RE.exec(cursor ?? "");
	if (!m) return 0;
	const n = Number.parseInt(m[1] as string, 10);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function serializeEvent(event: CanvasEvent): string {
	// JSON.stringify escapes newlines, so one event is always exactly one line.
	return `${JSON.stringify(event)}\n`;
}

const EVENT_TYPES = new Set(["note", "note.move", "note.edit", "note.delete", "reply", "resolve", "reopen"]);

function isEvent(value: unknown): value is CanvasEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const t = (value as { t?: unknown }).t;
	return typeof t === "string" && EVENT_TYPES.has(t);
}

/**
 * Both writers append to this file, so a crash mid-write can leave a partial
 * line. Losing that one record is acceptable; letting it take the whole feed
 * down with it is not.
 */
export function parseFeed(text: string): CanvasEvent[] {
	const out: CanvasEvent[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isEvent(parsed)) out.push(parsed);
		} catch {
			// a torn line — skip it, keep the feed
		}
	}
	return out;
}

export interface FeedPage {
	events: CanvasEvent[];
	cursor: string;
}

/**
 * Everything written after `cursor`, plus where to resume.
 *
 * The position counts PARSEABLE records, not raw lines, so a torn line cannot
 * shift the boundary and hide the record after it.
 */
export function readSince(text: string, cursor: string | undefined | null): FeedPage {
	const events = parseFeed(text);
	const from = Math.min(positionOf(cursor), events.length);
	return { events: events.slice(from), cursor: cursorOf(events.length) };
}

/** The canvas as it stands now: live threads, in the order they were opened. */
export function projectThreads(events: CanvasEvent[]): Thread[] {
	const threads = new Map<string, Thread>();
	for (const e of events) {
		switch (e.t) {
			case "note":
				threads.set(e.id, {
					id: e.id,
					at: e.at,
					author: e.author,
					screenId: e.screenId,
					x: e.x,
					y: e.y,
					text: e.text,
					replies: [],
					lastSpoke: e.author,
					resolved: false,
				});
				break;
			case "note.move": {
				const th = threads.get(e.id);
				if (th) {
					th.screenId = e.screenId;
					th.x = e.x;
					th.y = e.y;
				}
				break;
			}
			case "note.edit": {
				const th = threads.get(e.id);
				if (th) {
					th.text = e.text;
					th.lastSpoke = e.author;
				}
				break;
			}
			case "note.delete":
				// The event stays in the log; the thread leaves the canvas.
				threads.delete(e.id);
				break;
			case "reply": {
				const th = threads.get(e.noteId);
				if (th) {
					th.replies.push({ id: e.id, at: e.at, author: e.author, text: e.text });
					th.lastSpoke = e.author;
				}
				break;
			}
			case "resolve": {
				const th = threads.get(e.noteId);
				if (th) {
					th.resolved = true;
					th.resolvedBy = e.author;
					if (e.note !== undefined) th.resolvedNote = e.note;
				}
				break;
			}
			case "reopen": {
				const th = threads.get(e.noteId);
				if (th) {
					th.resolved = false;
					th.resolvedBy = undefined;
					th.resolvedNote = undefined;
					th.lastSpoke = e.author;
				}
				break;
			}
		}
	}
	return [...threads.values()];
}

/** `n_` + 12 hex, like the ids tracepaper hands out — short enough to say aloud. */
export function newId(prefix: "n" | "r", random: () => number = Math.random): string {
	let hex = "";
	while (hex.length < 12) hex += Math.floor(random() * 16).toString(16);
	return `${prefix}_${hex.slice(0, 12)}`;
}
