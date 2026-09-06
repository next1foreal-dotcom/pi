/**
 * G-429 — turn "she is waiting on Fei" into an outbox item.
 *
 * A side scan, deliberately NOT on her_status's call path: she calls her_status
 * every turn, and anything that can fail there can swallow her whole status
 * (that is tonight's bug, and it cost her a round). This runs out of band, is
 * idempotent, and can crash without hurting her.
 *
 * It only writes `<memory root>/outbox/*.md`. Sending is somebody else's job
 * (`her telegram-push-outbox` already drains that directory), so this whole
 * path is verifiable with no token of any kind.
 *
 * The signal is only what she says out loud: the `waiting` block of her LAST
 * her_status call. No question-mark heuristics — if she did not ask to be
 * waited on, she is not waiting.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StorePaths } from "./paths.ts";
import { readText, writeJson, writeText } from "./store.ts";
import { trimTelegramText } from "./telegram.ts";

export const WAITING_LEDGER_VERSION = 1;

/** The `waiting` block she passes to her_status, normalized. */
export interface WaitingRequest {
	question: string;
	options: string[];
}

/** One session that is, as of its last her_status call, waiting on Fei. */
export interface SessionWaiting {
	/** Session id — the deck's conversation id; the next hop replies with it. */
	sessionId: string;
	/** Session file basename, kept for warnings and the ledger. */
	file: string;
	/** The name she gave the session, if she ever gave one. */
	name?: string;
	headline: string;
	waiting: WaitingRequest;
}

export interface WaitingLedgerEntry {
	notifiedAt: string;
	sessionId: string;
	file: string;
}

export interface WaitingLedger {
	version: number;
	notified: Record<string, WaitingLedgerEntry>;
}

export interface WaitingOutboxEntry {
	key: string;
	sessionId: string;
	/** Outbox file name, not a path. */
	file: string;
	body: string;
	record: WaitingLedgerEntry;
}

export interface WaitingOutboxSkip {
	key: string;
	sessionId: string;
	reason: string;
}

export interface WaitingOutboxPlan {
	entries: WaitingOutboxEntry[];
	skipped: WaitingOutboxSkip[];
	ledger: WaitingLedger;
}

export interface ScanWaitingOutboxOptions {
	sessionDir: string;
	memoryRoot: string;
	now?: string;
}

export interface WaitingScanResult {
	scanned: number;
	waiting: number;
	written: Array<{ key: string; path: string; sessionId: string }>;
	skipped: WaitingOutboxSkip[];
	warnings: string[];
}

export function emptyWaitingLedger(): WaitingLedger {
	return { notified: {}, version: WAITING_LEDGER_VERSION };
}

/**
 * Reads the ledger. Absent is fine (first run); malformed is not — a ledger we
 * cannot trust would either re-push everything or swallow everything, and both
 * are worse than stopping.
 */
export function parseWaitingLedger(text: string | undefined): WaitingLedger {
	if (!text || !text.trim()) return emptyWaitingLedger();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		throw new Error(`waiting-outbox ledger is corrupt (invalid JSON): ${errorMessage(error)}`);
	}
	if (!isRecord(parsed)) throw new Error("waiting-outbox ledger is corrupt: expected a JSON object");
	if (!isRecord(parsed.notified)) throw new Error("waiting-outbox ledger is corrupt: `notified` must be an object");
	const notified: Record<string, WaitingLedgerEntry> = {};
	for (const [key, value] of Object.entries(parsed.notified)) {
		if (!isRecord(value) || typeof value.notifiedAt !== "string") {
			throw new Error(`waiting-outbox ledger is corrupt: entry ${key} has no notifiedAt`);
		}
		notified[key] = {
			file: typeof value.file === "string" ? value.file : "",
			notifiedAt: value.notifiedAt,
			sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
		};
	}
	return { notified, version: typeof parsed.version === "number" ? parsed.version : WAITING_LEDGER_VERSION };
}

/**
 * Content hash of one waiting. Hashing the JSON array (not a concatenation)
 * keeps option boundaries from smudging: ["ab","c"] must not equal ["a","bc"].
 */
export function waitingHash(waiting: WaitingRequest): string {
	const canonical = JSON.stringify([waiting.question, waiting.options]);
	return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12);
}

/** Idempotency key: this session, this exact question. She rewords it → new key → she gets pushed again. */
export function waitingKey(sessionId: string, waiting: WaitingRequest): string {
	return `${sessionId}#${waitingHash(waiting)}`;
}

/**
 * Reads one session file. Returns the waiting she is currently on, or null.
 * Warnings are per-file and never fatal — one unreadable session must not cost
 * us the others.
 */
function parseSessionFile(file: string, text: string): { waiting: SessionWaiting | null; warnings: string[] } {
	const warnings: string[] = [];
	const lines = text.split(/\r?\n/);
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

	let headerId: string | undefined;
	let name: string | undefined;
	let lastCall: Record<string, unknown> | undefined;
	let parsedLines = 0;
	let brokenLines = 0;

	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			// A half-written last line is normal: she may be appending right now.
			// Anywhere else — or a file where nothing parses at all — is real damage.
			if (index !== lines.length - 1 || parsedLines === 0) brokenLines++;
			continue;
		}
		parsedLines++;
		if (!isRecord(record)) continue;
		if (record.type === "session" && typeof record.id === "string" && record.id.trim()) {
			headerId = record.id.trim();
		}
		const message = record.message;
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (!isRecord(part) || part.type !== "toolCall" || part.name !== "her_status") continue;
			const args = isRecord(part.arguments) ? part.arguments : {};
			// She only sends `name` when she (re)names the session, so carry the
			// last one she gave forward onto later calls.
			if (typeof args.name === "string" && args.name.trim()) name = args.name.trim();
			lastCall = args;
		}
	}

	if (brokenLines > 0) warnings.push(`${file}: ${brokenLines} 行无法解析，已跳过`);
	if (!lastCall) return { waiting: null, warnings };
	const waiting = normalizeWaiting(lastCall.waiting);
	if (!waiting) return { waiting: null, warnings };
	return {
		waiting: {
			file,
			headline: typeof lastCall.headline === "string" ? lastCall.headline.trim() : "",
			name,
			sessionId: headerId ?? conversationIdFromFile(file),
			waiting,
		},
		warnings,
	};
}

/** The waiting she is on right now, or null when she is not waiting on anybody. */
export function parseSessionWaiting(file: string, text: string): SessionWaiting | null {
	return parseSessionFile(file, text).waiting;
}

/**
 * The message Fei reads on his phone. The session id sits on line 2 so it
 * survives trimming — the next hop needs it to route his reply back.
 */
export function renderWaitingMessage(session: SessionWaiting): string {
	const title = session.name?.trim() || session.sessionId;
	const lines = [`她在等你 · ${title}`, `会话 ${session.sessionId}`, ""];
	const headline = session.headline.trim();
	if (headline) lines.push(headline, "");
	lines.push(session.waiting.question);
	if (session.waiting.options.length > 0) {
		lines.push("");
		for (const [index, option] of session.waiting.options.entries()) lines.push(`${index + 1}. ${option}`);
	}
	return trimTelegramText(`${lines.join("\n")}\n`);
}

/** Timestamp first so the outbox drains in the order she got stuck. */
export function outboxFileName(sessionId: string, hash: string, now: string): string {
	return `${safeTimestamp(now)}-waiting-${slugForFile(sessionId)}-${hash}.md`;
}

export function applyWaitingEntry(ledger: WaitingLedger, entry: WaitingOutboxEntry): WaitingLedger {
	return { notified: { ...ledger.notified, [entry.key]: entry.record }, version: WAITING_LEDGER_VERSION };
}

/**
 * The whole decision, as a pure function: which waitings deserve an outbox item
 * and what the ledger looks like afterwards. No IO, so both sides are testable.
 */
export function planWaitingOutbox(sessions: SessionWaiting[], ledger: WaitingLedger, now: string): WaitingOutboxPlan {
	const entries: WaitingOutboxEntry[] = [];
	const skipped: WaitingOutboxSkip[] = [];
	let next: WaitingLedger = { notified: { ...ledger.notified }, version: ledger.version };
	for (const session of sessions) {
		const key = waitingKey(session.sessionId, session.waiting);
		if (next.notified[key]) {
			skipped.push({ key, reason: "already notified", sessionId: session.sessionId });
			continue;
		}
		const entry: WaitingOutboxEntry = {
			body: renderWaitingMessage(session),
			file: outboxFileName(session.sessionId, waitingHash(session.waiting), now),
			key,
			record: { file: session.file, notifiedAt: now, sessionId: session.sessionId },
			sessionId: session.sessionId,
		};
		entries.push(entry);
		next = applyWaitingEntry(next, entry);
	}
	return { entries, ledger: next, skipped };
}

/** Same resolution the deck uses (samantha-ui `build-root.ts` + the deck stream route). */
export function sessionDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.HER_PI_SESSION_DIR?.trim();
	if (explicit) return resolve(explicit);
	const buildRoot = env.HER_BUILD_DIR?.trim() || join(tmpdir(), "samantha-builds");
	return join(buildRoot, ".pi-sessions");
}

/** A dot file at the memory root — deliberately NOT inside outbox/, which is a send queue. */
export function waitingLedgerPath(memoryRoot: string): string {
	return join(memoryRoot, ".waiting-outbox.json");
}

/**
 * One round: read every session, write an outbox item per new waiting, advance
 * the ledger after each write (so a crash costs at most a repeat, never a lost
 * message). Loud on the things that mean the notifier is broken; merely noisy
 * on a single bad session.
 */
export async function scanWaitingOutbox(opts: ScanWaitingOutboxOptions): Promise<WaitingScanResult> {
	const now = opts.now ?? new Date().toISOString();
	const sessionDir = resolve(opts.sessionDir);
	const memoryRoot = resolve(opts.memoryRoot);
	const paths = new StorePaths(memoryRoot);
	const warnings: string[] = [];

	let files: string[];
	try {
		files = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).sort();
	} catch (error) {
		throw new Error(`cannot read session directory ${sessionDir}: ${errorMessage(error)}`);
	}

	const ledgerFile = waitingLedgerPath(memoryRoot);
	let ledger = parseWaitingLedger(await readText(ledgerFile));

	const sessions: SessionWaiting[] = [];
	let scanned = 0;
	for (const file of files) {
		let text: string;
		try {
			text = await readFile(join(sessionDir, file), "utf8");
		} catch (error) {
			warnings.push(`${file}: 读不到 (${errorMessage(error)})`);
			continue;
		}
		scanned++;
		const parsed = parseSessionFile(file, text);
		warnings.push(...parsed.warnings);
		if (parsed.waiting) sessions.push(parsed.waiting);
	}

	const plan = planWaitingOutbox(sessions, ledger, now);
	const written: WaitingScanResult["written"] = [];
	for (const entry of plan.entries) {
		await writeText(join(paths.outbox, entry.file), entry.body);
		ledger = applyWaitingEntry(ledger, entry);
		await writeJson(ledgerFile, ledger);
		written.push({ key: entry.key, path: `outbox/${entry.file}`, sessionId: entry.sessionId });
	}

	return { scanned, skipped: plan.skipped, waiting: sessions.length, warnings, written };
}

/** Same rule as the deck's `conversationIdFromFile`, so ids line up with the cards. */
function conversationIdFromFile(file: string): string {
	const timestamped = file.match(/^\d{4}-\d{2}-\d{2}T[^_]+_(.+)\.jsonl$/);
	return timestamped?.[1] ?? file.replace(/\.jsonl$/, "");
}

function normalizeWaiting(value: unknown): WaitingRequest | null {
	if (!isRecord(value)) return null;
	const question = typeof value.question === "string" ? value.question.trim() : "";
	if (!question) return null;
	const options = Array.isArray(value.options)
		? value.options.map((option) => (typeof option === "string" ? option.trim() : "")).filter((option) => option)
		: [];
	return { options, question };
}

function safeTimestamp(value: string): string {
	return value.replace(/[.:]/g, "-");
}

function slugForFile(value: string): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, 48)
		.replace(/^-+|-+$/g, "");
	return slug || "session";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
