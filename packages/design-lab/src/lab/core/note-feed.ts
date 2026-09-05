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

export type NoteThreadState = {
	replies: NoteReply[];
	resolved: boolean;
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

export function projectNoteFeed(text: string): Map<string, NoteThreadState> {
	const threads = new Map<string, NoteThreadState>();
	const ensure = (id: string): NoteThreadState => {
		let th = threads.get(id);
		if (!th) {
			th = { replies: [], resolved: false };
			threads.set(id, th);
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
		};
		if (typeof e.t !== "string" || !EVENT_TYPES.has(e.t)) continue;
		switch (e.t) {
			case "note":
				if (typeof e.id === "string") ensure(e.id);
				break;
			case "note.delete":
				if (typeof e.id === "string") threads.delete(e.id);
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
	return threads;
}
