/**
 * Minimal client-side projection of the canvas feed.
 *
 * The canonical parser lives in packages/her; this copy exists because the
 * lab's browser bundle cannot import that package. Bad lines are skipped:
 * both writers append, so a crash can leave a torn record.
 */

export type NoteReply = {
	id: string;
	author: string;
	text: string;
};

export type NoteSource = {
	file: string;
	line: number;
	col: number;
	component: string | null;
};

/** Relative to a screen's current layout. Page x/y are derived, not stored truth. */
export type NoteAnchor = {
	screenId: string;
	/** Normalized from the screen's left edge. Not clamped; may sit slightly outside. */
	rx: number;
	/** Normalized from the screen's top edge. Not clamped; may sit slightly outside. */
	ry: number;
};

export type NoteThreadState = {
	replies: NoteReply[];
	resolved: boolean;
	x: number;
	y: number;
	text: string;
	screenId: string | null;
	source?: NoteSource;
	anchor?: NoteAnchor;
	/** True once a `note` event has been seen — replies alone do not count. */
	hasBody: boolean;
};

export type NoteFeedProjection = {
	live: Map<string, NoteThreadState>;
	deleted: Set<string>;
};

const EVENT_TYPES = new Set([
	"note",
	"note.move",
	"note.edit",
	"note.delete",
	"reply",
	"resolve",
	"reopen",
]);

/** `n_` / `r_` + 12 hex, same shape her runtime stamps. */
export function newFeedId(
	prefix: "n" | "r",
	random: () => number = Math.random,
): string {
	let hex = "";
	while (hex.length < 12) hex += Math.floor(random() * 16).toString(16);
	return `${prefix}_${hex.slice(0, 12)}`;
}

export function isNoteFid(value: unknown): value is string {
	return typeof value === "string" && /^n_[0-9a-f]{12}$/.test(value);
}

function isSource(value: unknown): value is NoteSource {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const s = value as {
		file?: unknown;
		line?: unknown;
		col?: unknown;
		component?: unknown;
	};
	return (
		typeof s.file === "string" &&
		typeof s.line === "number" &&
		typeof s.col === "number" &&
		(s.component === null || typeof s.component === "string")
	);
}

export function isAnchor(value: unknown): value is NoteAnchor {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const a = value as { screenId?: unknown; rx?: unknown; ry?: unknown };
	return (
		typeof a.screenId === "string" &&
		typeof a.rx === "number" &&
		Number.isFinite(a.rx) &&
		typeof a.ry === "number" &&
		Number.isFinite(a.ry)
	);
}

/** A stored source location, checked field by field. */
export function isSourceRef(value: unknown): value is {
	file: string;
	line: number;
	col: number;
	component: string | null;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const r = value as {
		file?: unknown;
		line?: unknown;
		col?: unknown;
		component?: unknown;
	};
	return (
		typeof r.file === "string" &&
		r.file !== "" &&
		typeof r.line === "number" &&
		Number.isFinite(r.line) &&
		typeof r.col === "number" &&
		Number.isFinite(r.col) &&
		(r.component === null || typeof r.component === "string")
	);
}

/**
 * A stored region: a rect in the screen's OWN pixels, measured from the top of
 * its scrolled content -- the same numbers `design_element_at` is aimed with.
 *
 * It was fractions of the screen's box for about an hour, which is wrong the
 * moment a screen scrolls: the box then marks a place on the artboard rather
 * than a place in the page, so scrolling slid it onto whatever happened to be
 * there. Measured: the heading moved and the box did not.
 *
 * The size is what has to be real. A region with a NaN width paints an
 * invisible box that still claims the note is about something.
 */
export function isRegion(value: unknown): value is {
	screenId: string;
	x: number;
	y: number;
	w: number;
	h: number;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const r = value as {
		screenId?: unknown;
		x?: unknown;
		y?: unknown;
		w?: unknown;
		h?: unknown;
	};
	const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
	return (
		typeof r.screenId === "string" &&
		r.screenId !== "" &&
		num(r.x) &&
		num(r.y) &&
		num(r.w) &&
		(r.w as number) > 0 &&
		num(r.h) &&
		(r.h as number) > 0
	);
}

function blankThread(): NoteThreadState {
	return {
		replies: [],
		resolved: false,
		x: 0,
		y: 0,
		text: "",
		screenId: null,
		hasBody: false,
	};
}

export function projectNoteCanvas(text: string): NoteFeedProjection {
	const live = new Map<string, NoteThreadState>();
	const deleted = new Set<string>();
	const ensure = (id: string): NoteThreadState => {
		let th = live.get(id);
		if (!th) {
			th = blankThread();
			live.set(id, th);
		}
		return th;
	};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const e = parsed as {
			t?: unknown;
			id?: unknown;
			noteId?: unknown;
			author?: unknown;
			text?: unknown;
			x?: unknown;
			y?: unknown;
			screenId?: unknown;
			source?: unknown;
			anchor?: unknown;
		};
		if (typeof e.t !== "string" || !EVENT_TYPES.has(e.t)) continue;
		switch (e.t) {
			case "note": {
				if (typeof e.id !== "string") break;
				deleted.delete(e.id);
				const th = ensure(e.id);
				th.hasBody = true;
				th.x = typeof e.x === "number" && Number.isFinite(e.x) ? e.x : 0;
				th.y = typeof e.y === "number" && Number.isFinite(e.y) ? e.y : 0;
				th.text = typeof e.text === "string" ? e.text : "";
				th.screenId = typeof e.screenId === "string" ? e.screenId : null;
				if (isSource(e.source)) th.source = e.source;
				th.anchor = isAnchor(e.anchor) ? { ...e.anchor } : undefined;
				break;
			}
			case "note.move": {
				if (typeof e.id !== "string") break;
				const th = live.get(e.id);
				if (!th) break;
				if (typeof e.x === "number" && Number.isFinite(e.x)) th.x = e.x;
				if (typeof e.y === "number" && Number.isFinite(e.y)) th.y = e.y;
				if (e.screenId === null || typeof e.screenId === "string") {
					th.screenId = e.screenId;
				}
				if (isSource(e.source)) th.source = e.source;
				th.anchor = isAnchor(e.anchor) ? { ...e.anchor } : undefined;
				break;
			}
			case "note.edit": {
				if (typeof e.id !== "string") break;
				const th = live.get(e.id);
				if (!th) break;
				if (typeof e.text === "string") th.text = e.text;
				break;
			}
			case "note.delete":
				if (typeof e.id === "string") {
					live.delete(e.id);
					deleted.add(e.id);
				}
				break;
			case "reply": {
				if (typeof e.noteId !== "string" || typeof e.id !== "string") break;
				ensure(e.noteId).replies.push({
					id: e.id,
					author: typeof e.author === "string" ? e.author : "",
					text: typeof e.text === "string" ? e.text : "",
				});
				break;
			}
			case "resolve":
				if (typeof e.noteId === "string") ensure(e.noteId).resolved = true;
				break;
			case "reopen":
				if (typeof e.noteId === "string") ensure(e.noteId).resolved = false;
				break;
			default:
				break;
		}
	}
	return { live, deleted };
}

export function projectNoteFeed(text: string): Map<string, NoteThreadState> {
	return projectNoteCanvas(text).live;
}
