import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	appendEvent,
	eventHistoryPath,
	eventHistoryStatePath,
	type HistoryEvent,
	readEventHistory,
} from "./event-history.ts";
import { toWinAbs } from "./snapshot-paths.ts";
import { writeJson } from "./store.ts";

export function mergeEventsById(a: HistoryEvent[], b: HistoryEvent[]): HistoryEvent[] {
	const byId = new Map<string, HistoryEvent>();
	for (const event of a) byId.set(event.id, event);
	for (const event of b) {
		if (!byId.has(event.id)) byId.set(event.id, event);
	}
	return [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export async function writeMergedHistory(root: string, events: HistoryEvent[]): Promise<void> {
	const path = eventHistoryPath(root);
	await mkdir(toWinAbs(dirname(path)), { recursive: true });
	const body = events.map((event) => JSON.stringify(event)).join("\n");
	await writeFile(toWinAbs(path), events.length === 0 ? "" : `${body}\n`, "utf8");
}

export async function mergeAndRecordRestore(opts: {
	snapshotTs: string;
	snapshotTree: string;
	targetRoot: string;
}): Promise<void> {
	const current = await readEventHistory(opts.targetRoot);
	const fromSnap = await readEventHistory(opts.snapshotTree);
	const merged = mergeEventsById(current.events, fromSnap.events);
	await writeMergedHistory(opts.targetRoot, merged);
	await appendEvent(
		"host.restore",
		"snapshot-restore",
		{ snapshotTs: opts.snapshotTs, target: opts.targetRoot },
		undefined,
		opts.targetRoot,
	);
	await rewriteHistoryState(opts.targetRoot);
}

export async function rewriteHistoryState(root: string): Promise<void> {
	let bytes: Buffer;
	try {
		bytes = await readFile(toWinAbs(eventHistoryPath(root)));
	} catch {
		bytes = Buffer.alloc(0);
	}
	const { events } = await readEventHistory(root);
	const lastId = events.length === 0 ? "" : events[events.length - 1].id;
	await writeJson(eventHistoryStatePath(root), {
		lastId,
		prefixLength: bytes.byteLength,
		prefixSha256: createHash("sha256").update(bytes).digest("hex"),
	});
}
