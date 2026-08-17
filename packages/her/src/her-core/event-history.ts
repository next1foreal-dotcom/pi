import { randomBytes } from "node:crypto";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isTransientFsContention, readText, retryOnFsContention } from "./store.ts";
import { isLockContention } from "./store-lock.ts";

export const EVENT_KINDS = [
	"host.run.start",
	"host.run.end",
	"host.restart_planned",
	"host.restore",
	"organ.round.start",
	"organ.round.end",
	"organ.sync.start",
	"organ.sync.end",
	"selfmod.transition",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const HOST_RUNNERS = [
	"heartbeat",
	"memory-sync",
	"memory-mirror",
	"growth-consolidate",
	"growth-synthesize",
	"growth-reflect",
	"growth-ideas",
	"growth-topics",
] as const;

export type HostRunner = (typeof HOST_RUNNERS)[number];

export interface HistoryEvent {
	id: string;
	ts: string;
	kind: EventKind;
	actor: string;
	refs?: unknown;
	data?: Record<string, unknown>;
	derived?: boolean;
}

export interface DerivedEvent {
	id: string;
	ts: string;
	kind: "host.presumed_crash" | "organ.presumed_crash";
	actor: string;
	derived: true;
	refs?: unknown;
	data?: Record<string, unknown>;
}

export interface CorruptMarker {
	id: string;
	ts: string;
	kind: "corrupt_tail" | "corrupt_line";
	actor: "parser";
	derived: true;
	data?: Record<string, unknown>;
}

export interface ReadEventHistoryResult {
	events: HistoryEvent[];
	markers: CorruptMarker[];
}

export interface ListHerEventsOptions {
	kind?: string;
	since?: string;
	limit?: number;
	includeDerived?: boolean;
}

export type ListedEvent = HistoryEvent | DerivedEvent;

const kindSet: ReadonlySet<string> = new Set(EVENT_KINDS);
const runnerSet: ReadonlySet<string> = new Set(HOST_RUNNERS);
const lockStaleMs = 15_000;
const lockTimeoutMs = 10_000;

let lastUuidMs = 0;
let uuidSeq = 0;

export function isEventKind(value: string): value is EventKind {
	return kindSet.has(value);
}

export function isHostRunner(value: string): value is HostRunner {
	return runnerSet.has(value);
}

export function eventHistoryPath(root: string): string {
	return join(root, "audit", "event-history.jsonl");
}

export function eventHistoryStatePath(root: string): string {
	return join(root, "audit", "event-history.state.json");
}

export function uuidv7(): string {
	let ms = Date.now();
	if (ms < lastUuidMs) ms = lastUuidMs;
	if (ms === lastUuidMs) {
		uuidSeq += 1;
		if (uuidSeq > 0xfff) {
			ms += 1;
			uuidSeq = 0;
		}
	} else uuidSeq = 0;
	lastUuidMs = ms;
	const out = randomBytes(16);
	const t = BigInt(ms);
	out[0] = Number((t >> 40n) & 0xffn);
	out[1] = Number((t >> 32n) & 0xffn);
	out[2] = Number((t >> 24n) & 0xffn);
	out[3] = Number((t >> 16n) & 0xffn);
	out[4] = Number((t >> 8n) & 0xffn);
	out[5] = Number(t & 0xffn);
	out[6] = 0x70 | ((uuidSeq >> 8) & 0x0f);
	out[7] = uuidSeq & 0xff;
	out[8] = 0x80 | (out[8] & 0x3f);
	const h = out.toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function appendEvent(
	kind: string,
	actor: string,
	data?: Record<string, unknown>,
	refs?: unknown,
	root?: string,
): Promise<HistoryEvent> {
	if (typeof actor !== "string" || actor.trim() === "") {
		throw new Error("appendEvent requires actor");
	}
	if (!isEventKind(kind)) {
		throw new Error(`appendEvent unknown kind: ${kind}`);
	}
	const event: HistoryEvent = {
		id: uuidv7(),
		ts: new Date().toISOString(),
		kind,
		actor: actor.trim(),
		...(refs !== undefined ? { refs } : {}),
		...(data !== undefined ? { data } : {}),
	};
	const memoryRoot = resolveRoot(root);
	const path = eventHistoryPath(memoryRoot);
	await withHistoryLock(memoryRoot, () => appendLineSynced(path, `${JSON.stringify(event)}\n`));
	return event;
}

export async function appendEventBestEffort(
	kind: EventKind,
	actor: string,
	data?: Record<string, unknown>,
	root?: string,
): Promise<void> {
	try {
		await appendEvent(kind, actor, data, undefined, root);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[her] event-history write failed: ${message}`);
	}
}

/** S5 implementers call this. v1 has no runtime caller. */
export async function appendSelfmodTransition(
	data?: Record<string, unknown>,
	refs?: unknown,
	root?: string,
): Promise<HistoryEvent> {
	return appendEvent("selfmod.transition", "selfmod", data, refs, root);
}

export async function readEventHistory(root: string): Promise<ReadEventHistoryResult> {
	const text = await readText(eventHistoryPath(root));
	if (!text) return { events: [], markers: [] };
	return parseEventHistoryText(text);
}

export function detectPresumedCrashes(events: HistoryEvent[]): DerivedEvent[] {
	const ordered = sortById(events);
	const hostOpen = new Map<string, HistoryEvent>();
	const organOpen = new Map<string, HistoryEvent>();
	const planned = new Set<string>();
	const latestHostStart = new Map<string, string>();
	for (const event of ordered) {
		const runId = runIdOf(event);
		if (event.kind === "host.run.start" && runId) {
			hostOpen.set(pairKey(event.actor, runId), event);
			latestHostStart.set(event.actor, event.id);
		} else if (event.kind === "host.run.end" && runId) {
			hostOpen.delete(pairKey(event.actor, runId));
		} else if (event.kind === "host.restart_planned") {
			planned.add(runId ? pairKey(event.actor, runId) : event.actor);
		} else if (event.kind === "organ.round.start" && runId) {
			organOpen.set(pairKey(event.actor, runId), event);
		} else if (event.kind === "organ.round.end" && runId) {
			organOpen.delete(pairKey(event.actor, runId));
		}
	}
	const derived: DerivedEvent[] = [];
	for (const start of organOpen.values()) derived.push(presumedCrash(start, "organ.presumed_crash"));
	for (const [key, start] of hostOpen) {
		if (planned.has(key) || planned.has(start.actor)) continue;
		if (latestHostStart.get(start.actor) === start.id) continue;
		derived.push(presumedCrash(start, "host.presumed_crash"));
	}
	return sortById(derived);
}

export async function listHerEvents(root: string, opts: ListHerEventsOptions = {}): Promise<ListedEvent[]> {
	const { events } = await readEventHistory(root);
	let rows: ListedEvent[] = opts.includeDerived ? [...events, ...detectPresumedCrashes(events)] : [...events];
	if (opts.kind) rows = rows.filter((event) => event.kind === opts.kind);
	const since = opts.since;
	if (since) rows = rows.filter((event) => event.ts >= since);
	rows.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
	return rows.slice(0, opts.limit ?? 50);
}

function resolveRoot(root?: string): string {
	const value = root ?? process.env.HER_MEMORY_DIR;
	if (!value || value.trim() === "") throw new Error("appendEvent requires HER_MEMORY_DIR or an explicit root");
	return value;
}

function parseEventHistoryText(text: string): ReadEventHistoryResult {
	const events: HistoryEvent[] = [];
	const markers: CorruptMarker[] = [];
	const rawLines = text.split("\n");
	if (rawLines[rawLines.length - 1] === "") rawLines.pop();
	for (let i = 0; i < rawLines.length; i++) {
		const line = rawLines[i];
		if (line.trim() === "") continue;
		const parsed = parseHistoryLine(line);
		if (parsed) {
			events.push(parsed);
			continue;
		}
		const kind = i === rawLines.length - 1 ? "corrupt_tail" : "corrupt_line";
		markers.push({
			id: kind,
			ts: new Date().toISOString(),
			kind,
			actor: "parser",
			derived: true,
			data: { line: i, raw: line.slice(0, 200) },
		});
	}
	return { events, markers };
}

function parseHistoryLine(line: string): HistoryEvent | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (!value || typeof value !== "object") return undefined;
		const rec = value as Record<string, unknown>;
		if (typeof rec.id !== "string" || typeof rec.ts !== "string" || typeof rec.actor !== "string") return undefined;
		if (typeof rec.kind !== "string" || !isEventKind(rec.kind)) return undefined;
		const event: HistoryEvent = { id: rec.id, ts: rec.ts, kind: rec.kind, actor: rec.actor };
		if (rec.refs !== undefined) event.refs = rec.refs;
		if (rec.data !== undefined) {
			if (!rec.data || typeof rec.data !== "object" || Array.isArray(rec.data)) return undefined;
			event.data = rec.data as Record<string, unknown>;
		}
		return event;
	} catch {
		return undefined;
	}
}

async function withHistoryLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = join(root, "audit", "event-history.lock");
	await mkdir(dirname(lockPath), { recursive: true });
	const deadline = Date.now() + lockTimeoutMs;
	for (;;) {
		try {
			await writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
			break;
		} catch (error) {
			if (!isLockContention(error) && !isTransientFsContention(error)) throw error;
			const lockStat = await stat(lockPath).catch(() => undefined);
			if (lockStat && Date.now() - lockStat.mtimeMs > lockStaleMs) {
				await rm(lockPath, { force: true }).catch(() => undefined);
			}
			if (Date.now() >= deadline) throw error;
			await sleep(20);
		}
	}
	try {
		return await fn();
	} finally {
		await rm(lockPath, { force: true }).catch(() => undefined);
	}
}

async function appendLineSynced(path: string, line: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await retryOnFsContention(
		async () => {
			const fh = await open(path, "a");
			try {
				await fh.appendFile(line, "utf8");
				await fh.sync();
			} finally {
				await fh.close();
			}
		},
		{ label: "appendEvent" },
	);
}

function presumedCrash(start: HistoryEvent, kind: DerivedEvent["kind"]): DerivedEvent {
	return {
		id: start.id,
		ts: start.ts,
		kind,
		actor: start.actor,
		derived: true,
		data: { runId: runIdOf(start), unmatchedKind: start.kind },
	};
}

function runIdOf(event: HistoryEvent): string | undefined {
	const value = event.data?.runId;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pairKey(actor: string, runId: string): string {
	return `${actor}\0${runId}`;
}

function sortById<T extends { id: string }>(events: T[]): T[] {
	return [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
