import { join } from "node:path";
import type { StorePaths } from "./paths.ts";
import { appendText, readText } from "./store.ts";

export type TriggerEventOutcome = "surfaced" | "cooldown" | "empty";
export type TriggerOutcome = "engaged" | "ignored";

export interface TriggerEvent {
	at: string;
	kind: "trigger";
	hasQuery: boolean;
	noteId?: string;
	outcome: TriggerEventOutcome;
	sessionId: string;
}

export interface TriggerOutcomeEvent {
	at: string;
	kind: "outcome";
	noteId: string;
	outcome: TriggerOutcome;
	sessionId: string;
}

export interface TriggerStats {
	total: number;
	byOutcome: Record<TriggerEventOutcome, number>;
	engagedRate: number;
	bySession: Record<string, number>;
}

export async function appendTriggerEvent(paths: StorePaths, event: Omit<TriggerEvent, "at" | "kind">): Promise<void> {
	const { noteId: rawNoteId, ...rest } = event;
	const noteId = rawNoteId && !isProtectedTriggerNoteId(rawNoteId) ? rawNoteId : undefined;
	const entry: TriggerEvent = {
		at: new Date().toISOString(),
		kind: "trigger",
		...rest,
		...(noteId ? { noteId } : {}),
	};
	await appendText(triggerLogPath(paths), `${JSON.stringify(entry)}\n`);
}

export async function recordTriggerOutcome(
	paths: StorePaths,
	event: Omit<TriggerOutcomeEvent, "at" | "kind">,
): Promise<void> {
	if (isProtectedTriggerNoteId(event.noteId)) return;
	const entry: TriggerOutcomeEvent = { at: new Date().toISOString(), kind: "outcome", ...event };
	await appendText(triggerLogPath(paths), `${JSON.stringify(entry)}\n`);
}

export async function readTriggerStats(paths: StorePaths): Promise<TriggerStats> {
	const stats = emptyTriggerStats();
	let text: string | undefined;
	try {
		text = await readText(triggerLogPath(paths));
	} catch {
		return stats;
	}
	if (!text?.trim()) return stats;

	const surfacedBySessionAndNote = new Map<string, number>();
	const resolvedSurfaced = new Set<number>();
	let engaged = 0;
	let surfaced = 0;
	for (const line of text.split(/\r?\n/)) {
		const event = parseTriggerLogLine(line);
		if (!event) continue;
		if (event.kind === "trigger") {
			stats.total += 1;
			stats.byOutcome[event.outcome] += 1;
			stats.bySession[event.sessionId] = (stats.bySession[event.sessionId] ?? 0) + 1;
			if (event.outcome === "surfaced") {
				const index = surfaced++;
				if (event.noteId) surfacedBySessionAndNote.set(triggerKey(event.sessionId, event.noteId), index);
			}
			continue;
		}
		const surfaceIndex = surfacedBySessionAndNote.get(triggerKey(event.sessionId, event.noteId));
		if (surfaceIndex === undefined || resolvedSurfaced.has(surfaceIndex)) continue;
		resolvedSurfaced.add(surfaceIndex);
		if (event.outcome === "engaged") engaged += 1;
	}
	stats.engagedRate = surfaced === 0 ? 0 : engaged / surfaced;
	return stats;
}

function emptyTriggerStats(): TriggerStats {
	return {
		total: 0,
		byOutcome: { surfaced: 0, cooldown: 0, empty: 0 },
		engagedRate: 0,
		bySession: {},
	};
}

function parseTriggerLogLine(line: string): TriggerEvent | TriggerOutcomeEvent | undefined {
	if (!line.trim()) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		if (!value || typeof value !== "object") return undefined;
		if (isTriggerEvent(value)) return value;
		if (isTriggerOutcomeEvent(value)) return value;
	} catch {
		return undefined;
	}
	return undefined;
}

function isTriggerEvent(value: unknown): value is TriggerEvent {
	if (!isRecord(value)) return false;
	return (
		value.kind === "trigger" &&
		typeof value.at === "string" &&
		typeof value.sessionId === "string" &&
		typeof value.hasQuery === "boolean" &&
		(value.outcome === "surfaced" || value.outcome === "cooldown" || value.outcome === "empty") &&
		(value.noteId === undefined || typeof value.noteId === "string")
	);
}

function isTriggerOutcomeEvent(value: unknown): value is TriggerOutcomeEvent {
	if (!isRecord(value)) return false;
	return (
		value.kind === "outcome" &&
		typeof value.at === "string" &&
		typeof value.sessionId === "string" &&
		typeof value.noteId === "string" &&
		(value.outcome === "engaged" || value.outcome === "ignored")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object");
}

function isProtectedTriggerNoteId(noteId: string): boolean {
	return /^samantha\/(?:wants|journal)(?:\/|$)/.test(noteId);
}

function triggerKey(sessionId: string, noteId: string): string {
	return `${sessionId}\u0000${noteId}`;
}

function triggerLogPath(paths: StorePaths): string {
	return join(paths.herDir, "trigger-log.jsonl");
}
