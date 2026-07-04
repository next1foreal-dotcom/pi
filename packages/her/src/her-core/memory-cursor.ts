export interface ConsolidateCursorState {
	ts: string;
	done_ids: string[];
}

export interface ParsedConsolidateCursor {
	ts: string;
	doneIds: Set<string>;
	legacy: boolean;
}

export interface CursorEpisode {
	ts: string;
	cursorId: string;
}

export function rawEpisodeTimestamp(name: string): string {
	return name.split("--", 1)[0] ?? "";
}

export function rawEpisodeIdFromName(name: string): string {
	const stem = name.replace(/\.md$/, "");
	const marker = stem.indexOf("--");
	return marker >= 0 ? stem.slice(marker + 2) : stem;
}

export function parseConsolidateCursor(value: unknown): ParsedConsolidateCursor | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "string") return { ts: value, doneIds: new Set(), legacy: true };
	if (typeof value !== "object") throw new Error("invalid consolidate cursor");
	const record = value as { ts?: unknown; done_ids?: unknown };
	if (typeof record.ts !== "string" || record.ts.length === 0) throw new Error("invalid consolidate cursor ts");
	const doneIds = Array.isArray(record.done_ids) ? record.done_ids.map(String) : [];
	return { ts: record.ts, doneIds: new Set(doneIds), legacy: false };
}

export function shouldReadRawEpisodeName(name: string, cursor: ParsedConsolidateCursor | null): boolean {
	if (!cursor) return true;
	const ts = rawEpisodeTimestamp(name);
	if (cursor.legacy) return ts > cursor.ts;
	if (ts > cursor.ts) return true;
	if (ts < cursor.ts) return false;
	return !cursor.doneIds.has(rawEpisodeIdFromName(name));
}

export function shouldUseRawEpisode(ts: string, cursorId: string, cursor: ParsedConsolidateCursor | null): boolean {
	if (!cursor) return true;
	if (cursor.legacy) return ts > cursor.ts;
	if (ts > cursor.ts) return true;
	if (ts < cursor.ts) return false;
	return !cursor.doneIds.has(cursorId);
}

export function advanceConsolidateCursor(
	cursor: ParsedConsolidateCursor | null,
	episodes: CursorEpisode[],
): ConsolidateCursorState {
	const last = episodes.at(-1);
	if (!last) throw new Error("cannot advance consolidate cursor without episodes");
	const doneIds = new Set<string>(!cursor?.legacy && cursor?.ts === last.ts ? cursor.doneIds : []);
	for (const episode of episodes) {
		if (episode.ts === last.ts) doneIds.add(episode.cursorId);
	}
	return { ts: last.ts, done_ids: [...doneIds] };
}
