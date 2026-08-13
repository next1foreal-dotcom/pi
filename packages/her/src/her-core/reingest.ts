import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { isJunkNote, Memory, selectRelevantKeys, stripCipherBlobs } from "./memory.ts";
import {
	completeJson,
	JsonMalformedError,
	JsonTruncatedError,
	markdownEntries,
	markdownStems,
	slug,
} from "./memory-utils.ts";
import type { ModelLike } from "./model.ts";
import { StorePaths } from "./paths.ts";
import { consolidatePrompt } from "./prompts.ts";
import { appendText, parseFrontmatter, readJson, readText, writeJson } from "./store.ts";
import { storeLock } from "./store-lock.ts";

const DEFAULT_LIMIT = 50;
const DEFAULT_EPISODE_CHARS = 8000;
const DEFAULT_KEY_BUDGET = 120;
const DEFAULT_KEY_RECENT = 30;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const LEDGER_VERSION = 1 as const;

export interface ReingestOptions {
	dryRun?: boolean;
	limit?: number;
	model?: ModelLike;
}

export type ReingestOutcome = "ingested" | "skipped" | "failed" | "dry-run";

export interface ReingestEntry {
	chars: number;
	episode: string;
	id: string;
	noteKeys: string[];
	outcome: ReingestOutcome;
	part: string;
	reason: string;
}

export interface ReingestReport {
	entries: ReingestEntry[];
	failed: number;
	ingested: number;
	scanned: number;
	skipped: { alreadyProcessed: number; duplicateBody: number; inFlight: number };
}

interface ReingestLedgerRecord {
	at: string;
	bodySha256: string;
	leaseOwner?: string;
	leaseUntil?: number;
	outcome: string;
}

interface ReingestLedger {
	processed: Record<string, ReingestLedgerRecord>;
	version: typeof LEDGER_VERSION;
}

interface QuarantineSegment {
	body: string;
	bodySha256: string;
	chars: number;
	episode: string;
	id: string;
	part: string;
	path: string;
	quarantineReason: string;
	raw: string;
	ts: string;
}

interface DistilledSegment {
	moments: Array<{ shift?: string; trigger?: string }>;
	notes: Array<Record<string, unknown>>;
}

function envPositiveInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
	return Math.floor(value);
}

function truncateEpisodeText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = `...[truncated, original ${text.length} chars]`;
	const keep = Math.max(0, maxChars - marker.length);
	return `${text.slice(0, keep)}${marker}`;
}

function sha256Utf8(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function ledgerPath(paths: StorePaths): string {
	return join(paths.herDir, "reingest-state.json");
}

function quarantineDir(paths: StorePaths): string {
	return join(paths.herDir, "quarantine");
}

function auditPath(paths: StorePaths): string {
	return join(paths.root, "audit", "reingest.jsonl");
}

function emptyLedger(): ReingestLedger {
	return { version: LEDGER_VERSION, processed: {} };
}

async function loadLedger(path: string): Promise<ReingestLedger> {
	const raw = await readJson<Partial<ReingestLedger>>(path, emptyLedger());
	if (raw.version !== undefined && raw.version !== LEDGER_VERSION) {
		throw new Error(`unsupported reingest ledger version: ${String(raw.version)}`);
	}
	const processed =
		raw.processed && typeof raw.processed === "object" && !Array.isArray(raw.processed) ? raw.processed : {};
	return { version: LEDGER_VERSION, processed: { ...processed } };
}

async function saveLedger(path: string, ledger: ReingestLedger): Promise<void> {
	await writeJson(path, ledger);
}

async function recentSemanticStems(dir: string, limit: number): Promise<string[]> {
	if (limit <= 0) return [];
	const entries = await markdownEntries(dir);
	const stamped = await Promise.all(
		entries.map(async (entry) => {
			try {
				return { stem: entry.replace(/\.md$/, ""), mtimeMs: (await stat(join(dir, entry))).mtimeMs };
			} catch {
				return undefined;
			}
		}),
	);
	return stamped
		.filter((item): item is { stem: string; mtimeMs: number } => item !== undefined)
		.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0))
		.slice(0, limit)
		.map((item) => item.stem);
}

function bindNotesToOrigin(notes: Array<Record<string, unknown>>, episodeId: string): Array<Record<string, unknown>> {
	const originLink = `[[episodic/raw/${episodeId}]]`;
	return notes.map((note) => {
		const sources = Array.isArray(note.sources) ? note.sources.map(String) : [];
		if (!sources.includes(episodeId)) sources.push(episodeId);
		const content = typeof note.content === "string" ? note.content : "";
		const rewritten = content.replace(/\[\[\.her\/quarantine\/[^\]]+\]\]/g, originLink);
		return { ...note, sources, content: rewritten };
	});
}

async function readSegment(dir: string, name: string): Promise<QuarantineSegment> {
	const path = join(dir, name);
	const raw = (await readText(path)) ?? "";
	const parsed = parseFrontmatter(raw);
	const id = name.replace(/\.md$/, "");
	const episode = String(parsed.data.episode ?? id.replace(/--part-.*$/, ""));
	const part = String(parsed.data.part ?? "");
	const ts = String(parsed.data.ts ?? "");
	const quarantineReason = String(parsed.data.reason ?? "");
	const chars = typeof parsed.data.chars === "number" ? parsed.data.chars : parsed.body.length;
	return {
		body: parsed.body,
		bodySha256: sha256Utf8(parsed.body),
		chars,
		episode,
		id,
		part,
		path,
		quarantineReason,
		raw,
		ts,
	};
}

async function listQuarantineSegments(paths: StorePaths): Promise<QuarantineSegment[]> {
	const dir = quarantineDir(paths);
	const names = await markdownEntries(dir);
	const segments: QuarantineSegment[] = [];
	for (const name of names) segments.push(await readSegment(dir, name));
	return segments;
}

async function appendAudit(
	paths: StorePaths,
	entry: {
		bodySha256: string;
		id: string;
		noteKeys: string[];
		outcome: "ingested" | "skipped" | "failed";
		reason: string;
		segment: QuarantineSegment;
	},
): Promise<void> {
	await appendText(
		auditPath(paths),
		`${JSON.stringify({
			at: new Date().toISOString(),
			id: entry.id,
			episode: entry.segment.episode,
			part: entry.segment.part,
			outcome: entry.outcome,
			reason: entry.reason,
			note_keys: entry.noteKeys,
			body_sha256: entry.bodySha256,
		})}\n`,
	);
}

async function recordProcessed(
	paths: StorePaths,
	ledger: ReingestLedger,
	segment: QuarantineSegment,
	outcome: "ingested" | "skipped" | "failed",
	reason: string,
	noteKeys: string[],
): Promise<void> {
	const at = new Date().toISOString();
	await appendAudit(paths, {
		bodySha256: segment.bodySha256,
		id: segment.id,
		noteKeys,
		outcome,
		reason,
		segment,
	});
	ledger.processed[segment.id] = { at, bodySha256: segment.bodySha256, outcome };
	await saveLedger(ledgerPath(paths), ledger);
}

async function persistDistilled(
	memory: Memory,
	segment: QuarantineSegment,
	distilled: DistilledSegment,
): Promise<string[]> {
	const noteKeys: string[] = [];
	for (const note of distilled.notes) {
		const key = slug(String(note.key ?? note.title ?? "note"));
		await memory.upsertSemanticNote(note);
		noteKeys.push(key);
	}
	if (distilled.moments.length > 0) {
		const date = (segment.ts || new Date().toISOString()).slice(0, 10);
		await appendText(
			memory.paths.becoming,
			distilled.moments
				.map((moment) => `- ${date} · trigger: ${moment.trigger ?? ""} · shift: ${moment.shift ?? ""}\n`)
				.join(""),
		);
	}
	return noteKeys;
}

function isTerminalOutcome(outcome: string): boolean {
	return outcome === "ingested" || outcome === "skipped";
}

function isOurClaim(record: ReingestLedgerRecord | undefined, owner: string): boolean {
	return record?.outcome === "claimed" && record.leaseOwner === owner;
}

function isLiveForeignClaim(record: ReingestLedgerRecord | undefined, owner: string, now: number): boolean {
	if (!record || record.outcome !== "claimed" || record.leaseOwner === owner) return false;
	return typeof record.leaseUntil === "number" && record.leaseUntil > now;
}

function leaseMs(): number {
	return envPositiveInt("HER_REINGEST_LEASE_MS", DEFAULT_LEASE_MS);
}

async function refreshLedger(paths: StorePaths, ledger: ReingestLedger): Promise<void> {
	const fresh = await loadLedger(ledgerPath(paths));
	ledger.processed = { ...ledger.processed, ...fresh.processed };
}

async function claimSegment(
	root: string,
	paths: StorePaths,
	ledger: ReingestLedger,
	segment: QuarantineSegment,
	owner: string,
	now: number,
): Promise<"claimed" | "terminal" | "inflight"> {
	return storeLock(root, async () => {
		await refreshLedger(paths, ledger);
		const current = ledger.processed[segment.id];
		if (current && isTerminalOutcome(current.outcome)) return "terminal";
		if (isLiveForeignClaim(current, owner, now)) return "inflight";
		ledger.processed[segment.id] = {
			at: new Date(now).toISOString(),
			bodySha256: segment.bodySha256,
			outcome: "claimed",
			leaseOwner: owner,
			leaseUntil: now + leaseMs(),
		};
		await saveLedger(ledgerPath(paths), ledger);
		return "claimed";
	});
}

async function releaseClaim(
	root: string,
	paths: StorePaths,
	ledger: ReingestLedger,
	segment: QuarantineSegment,
	owner: string,
): Promise<void> {
	await storeLock(root, async () => {
		await refreshLedger(paths, ledger);
		if (!isOurClaim(ledger.processed[segment.id], owner)) return;
		delete ledger.processed[segment.id];
		await saveLedger(ledgerPath(paths), ledger);
	});
}

async function distillSegment(memory: Memory, model: ModelLike, segment: QuarantineSegment): Promise<DistilledSegment> {
	const stripped = stripCipherBlobs(segment.body.trim());
	if (stripped.blobs > 0) {
		console.warn(
			`[her] reingest: stripped ${stripped.blobs} cipher blob(s), ${stripped.strippedChars} chars, from ${segment.id}`,
		);
	}
	const episodeChars = envPositiveInt("HER_CONSOLIDATE_EPISODE_CHARS", DEFAULT_EPISODE_CHARS);
	const promptText = `[${segment.episode}] ${truncateEpisodeText(stripped.text, episodeChars)}`;
	const existing = await markdownStems(memory.paths.semantic);
	const recent = await recentSemanticStems(
		memory.paths.semantic,
		envPositiveInt("HER_CONSOLIDATE_KEY_RECENT", DEFAULT_KEY_RECENT),
	);
	const selectedKeys = selectRelevantKeys(promptText, existing, {
		max: envPositiveInt("HER_CONSOLIDATE_KEY_BUDGET", DEFAULT_KEY_BUDGET),
		recent,
	});
	const result = await completeJson<{
		moments?: Array<{ shift?: string; trigger?: string }>;
		notes?: Array<Record<string, unknown>>;
	}>(() => model.complete(consolidatePrompt(promptText, selectedKeys)));
	const accepted: Array<Record<string, unknown>> = [];
	const rawNotes = Array.isArray(result.notes) ? result.notes : [];
	for (const note of rawNotes) {
		if (isJunkNote(note)) continue;
		accepted.push(note);
	}
	return {
		notes: bindNotesToOrigin(accepted, segment.episode),
		moments: Array.isArray(result.moments) ? result.moments : [],
	};
}

function failureReason(error: unknown): "malformed" | "truncated" | undefined {
	if (error instanceof JsonTruncatedError) return "truncated";
	if (error instanceof JsonMalformedError) return "malformed";
	return undefined;
}

export async function runReingest(root: string, opts: ReingestOptions = {}): Promise<ReingestReport> {
	const limit = opts.limit ?? DEFAULT_LIMIT;
	if (!Number.isFinite(limit) || limit <= 0) throw new Error("reingest limit must be positive");
	const dryRun = opts.dryRun === true;
	const paths = new StorePaths(root);
	const ledger = await loadLedger(ledgerPath(paths));
	const segments = await listQuarantineSegments(paths);
	// "failed" records stay in the ledger for audit but do not seed the
	// duplicate-body set and do not park the segment: a truncated model
	// response must remain retryable on a later run.
	const seenHashes = new Set(
		Object.values(ledger.processed)
			.filter((record) => isTerminalOutcome(record.outcome))
			.map((record) => record.bodySha256),
	);
	const unprocessed: QuarantineSegment[] = [];
	let alreadyProcessed = 0;
	for (const segment of segments) {
		const record = ledger.processed[segment.id];
		if (record && isTerminalOutcome(record.outcome)) {
			alreadyProcessed++;
			continue;
		}
		unprocessed.push(segment);
	}
	const batch = unprocessed.slice(0, limit);
	const report: ReingestReport = {
		scanned: segments.length,
		ingested: 0,
		skipped: { alreadyProcessed, duplicateBody: 0, inFlight: 0 },
		failed: 0,
		entries: [],
	};

	if (dryRun) {
		for (const segment of batch) {
			report.entries.push({
				id: segment.id,
				episode: segment.episode,
				part: segment.part,
				chars: segment.chars,
				reason: segment.quarantineReason,
				outcome: "dry-run",
				noteKeys: [],
			});
		}
		return report;
	}

	if (!opts.model) throw new Error("reingest requires a model");
	const model = opts.model;
	const memory = new Memory(root, model);

	// Lock-window discipline (G-36A): distill and upsert-merge model calls run
	// OUTSIDE the store lock. A short claim lease is taken first so a concurrent
	// reingest cannot distill the same segment and clobber the ledger.
	for (const segment of batch) {
		const record = ledger.processed[segment.id];
		if (record && isTerminalOutcome(record.outcome)) {
			report.skipped.alreadyProcessed++;
			continue;
		}
		if (seenHashes.has(segment.bodySha256)) {
			await storeLock(root, () => recordProcessed(paths, ledger, segment, "skipped", "duplicate-body", []));
			seenHashes.add(segment.bodySha256);
			report.skipped.duplicateBody++;
			report.entries.push({
				id: segment.id,
				episode: segment.episode,
				part: segment.part,
				chars: segment.chars,
				reason: "duplicate-body",
				outcome: "skipped",
				noteKeys: [],
			});
			continue;
		}
		const owner = randomUUID();
		const claim = await claimSegment(root, paths, ledger, segment, owner, Date.now());
		if (claim === "terminal") {
			report.skipped.alreadyProcessed++;
			continue;
		}
		if (claim === "inflight") {
			report.skipped.inFlight++;
			continue;
		}
		let distilled: DistilledSegment | undefined;
		let failed: "malformed" | "truncated" | undefined;
		try {
			distilled = await distillSegment(memory, model, segment);
		} catch (error) {
			const reason = failureReason(error);
			if (!reason) {
				await releaseClaim(root, paths, ledger, segment, owner);
				throw error;
			}
			failed = reason;
		}
		let noteKeys: string[] = [];
		if (!failed && distilled) {
			const stillMine = await storeLock(root, async () => {
				await refreshLedger(paths, ledger);
				return isOurClaim(ledger.processed[segment.id], owner);
			});
			if (!stillMine) {
				report.skipped.inFlight++;
				continue;
			}
			try {
				noteKeys = await persistDistilled(memory, segment, distilled);
			} catch (error) {
				await releaseClaim(root, paths, ledger, segment, owner);
				throw error;
			}
		}
		const recorded = await storeLock(root, async (): Promise<"ok" | "inflight" | "terminal"> => {
			await refreshLedger(paths, ledger);
			const current = ledger.processed[segment.id];
			if (current && isTerminalOutcome(current.outcome) && !isOurClaim(current, owner)) return "terminal";
			if (!isOurClaim(current, owner)) return "inflight";
			if (failed) {
				await recordProcessed(paths, ledger, segment, "failed", failed, []);
			} else {
				await recordProcessed(paths, ledger, segment, "ingested", segment.quarantineReason || "ingested", noteKeys);
			}
			return "ok";
		});
		if (recorded !== "ok") {
			if (recorded === "terminal") report.skipped.alreadyProcessed++;
			else report.skipped.inFlight++;
			continue;
		}
		if (failed) {
			report.failed++;
			report.entries.push({
				id: segment.id,
				episode: segment.episode,
				part: segment.part,
				chars: segment.chars,
				reason: failed,
				outcome: "failed",
				noteKeys: [],
			});
		} else {
			seenHashes.add(segment.bodySha256);
			report.ingested++;
			report.entries.push({
				id: segment.id,
				episode: segment.episode,
				part: segment.part,
				chars: segment.chars,
				reason: segment.quarantineReason || "ingested",
				outcome: "ingested",
				noteKeys,
			});
		}
	}

	return report;
}
