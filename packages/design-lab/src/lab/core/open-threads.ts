import type { NoteReply, NoteThreadState } from "./note-feed";

export type ThreadRow = {
	id: string;
	screenId: string | null;
	text: string;
	hasReply: boolean;
	resolved: boolean;
};

export function unresolvedCount(
	threads: Iterable<NoteThreadState>,
): number {
	let n = 0;
	for (const t of threads) {
		if (t.hasBody && !t.resolved) n++;
	}
	return n;
}

function hasSamanthaReply(replies: readonly NoteReply[]): boolean {
	return replies.some((r) => r.author === "samantha");
}

export function threadRows(
	live: Map<string, NoteThreadState>,
	includeResolved = false,
): ThreadRow[] {
	const rows: ThreadRow[] = [];
	for (const [id, t] of live) {
		if (!t.hasBody) continue;
		if (t.resolved && !includeResolved) continue;
		rows.push({
			id,
			screenId: t.screenId,
			text: t.text,
			hasReply: hasSamanthaReply(t.replies),
			resolved: t.resolved,
		});
	}
	return rows;
}
