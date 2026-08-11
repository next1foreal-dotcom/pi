// G-237 session_read: read-only, forced-pagination access to any harness's raw
// session transcript (JSONL) by session id or id-prefix.
//
// Four active harness sources on this machine plus a her-memory archive fallback.
// Everything is a pure read: no writes, no logs to disk, no network, no store
// mutation. Paths are never hardcoded — each source resolves from os.homedir()
// with a per-source env override so tests point every source at a temp fixture.
//
// The hard output cap (SESSION_READ_MAX_BYTES / SESSION_READ_MAX_RECORDS) is the
// point of this tool: transcripts are MB-scale, so every mode truncates and tells
// the caller how to page for the rest.

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

export const SESSION_READ_MAX_BYTES = 64 * 1024;
export const SESSION_READ_MAX_RECORDS = 200;
/** Ambiguous listings are output too: a 1-char prefix must not flood the caller. */
export const SESSION_READ_MAX_CANDIDATES = 25;
export const DEFAULT_GREP_CONTEXT = 2;
/** Recursion ceiling so a pathological tree can never hang the walk. */
const MAX_WALK_DEPTH = 8;

export type SessionSourceName = "claude" | "codex" | "cursor" | "pi" | "archive";

/** Env override per source; defaults are derived from os.homedir(). */
const SOURCE_ENV: Record<SessionSourceName, string> = {
	claude: "HER_CLAUDE_SESSIONS_DIR",
	codex: "HER_CODEX_SESSIONS_DIR",
	cursor: "HER_CURSOR_PROJECTS_DIR",
	pi: "HER_PI_SESSIONS_DIR",
	archive: "HER_MEMORY_DIR",
};

export interface SessionReadConfig {
	claudeDir: string;
	codexDir: string;
	cursorDir: string;
	piDir: string;
	/** her-memory archive root (harvested memory — see archive fallback caveat). */
	archiveDir: string;
}

function defaultSourceDir(name: SessionSourceName, home: string): string {
	switch (name) {
		case "claude":
			return join(home, ".claude", "projects");
		case "codex":
			return join(home, ".codex", "sessions");
		case "cursor":
			return join(home, ".cursor", "projects");
		case "pi":
			// Mirrors pi's own getSessionsDir(): ~/.pi/agent/sessions.
			return join(home, ".pi", "agent", "sessions");
		case "archive":
			return join(home, "her-memory");
	}
}

/**
 * Resolve every source directory: env override wins, then explicit overrides
 * (used by the CLI/extension to inject the already-resolved memory dir), then
 * the os.homedir()-derived default.
 */
export function resolveSessionReadConfig(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	overrides: Partial<SessionReadConfig> = {},
): SessionReadConfig {
	const pick = (name: SessionSourceName, overrideKey: keyof SessionReadConfig): string =>
		overrides[overrideKey] ?? env[SOURCE_ENV[name]]?.trim() ?? defaultSourceDir(name, home);
	return {
		claudeDir: pick("claude", "claudeDir"),
		codexDir: pick("codex", "codexDir"),
		cursorDir: pick("cursor", "cursorDir"),
		piDir: pick("pi", "piDir"),
		archiveDir: pick("archive", "archiveDir"),
	};
}

// ---------------------------------------------------------------------------
// Source specs: how to recognise a transcript file and pull its session id
// token from the filename WITHOUT reading the file (so id/prefix matching stays
// cheap across thousands of sessions).
// ---------------------------------------------------------------------------

interface ActiveSourceSpec {
	name: Exclude<SessionSourceName, "archive">;
	dir: string;
	matchFile(name: string): boolean;
	idOf(name: string): string;
}

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function stripJsonl(name: string): string {
	return name.replace(/\.jsonl$/i, "");
}

export function activeSpecs(config: SessionReadConfig): ActiveSourceSpec[] {
	return [
		{
			// ~/.claude/projects/<slug>/<session-uuid>.jsonl (+ subagents/agent-*.jsonl).
			// Session id = filename stem.
			name: "claude",
			dir: config.claudeDir,
			matchFile: (n) => n.endsWith(".jsonl"),
			idOf: stripJsonl,
		},
		{
			// ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl.
			// Session id = trailing uuid.
			name: "codex",
			dir: config.codexDir,
			matchFile: (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"),
			idOf: (n) => UUID_TAIL.exec(stripJsonl(n))?.[1] ?? stripJsonl(n),
		},
		{
			// ~/.cursor/projects/<project>/agent-transcripts/**/<uuid>.jsonl (+ subagents/).
			// Session id = filename stem.
			name: "cursor",
			dir: config.cursorDir,
			matchFile: (n) => n.endsWith(".jsonl"),
			idOf: stripJsonl,
		},
		{
			// ~/.pi/agent/sessions/--<enc-cwd>--/<ts>_<uuid>.jsonl.
			// Session id = part after the last underscore.
			name: "pi",
			dir: config.piDir,
			matchFile: (n) => n.endsWith(".jsonl"),
			idOf: (n) => {
				const stem = stripJsonl(n);
				const us = stem.lastIndexOf("_");
				return us >= 0 ? stem.slice(us + 1) : stem;
			},
		},
	];
}

/** Best-effort recursive listing of files matching `match`. Never throws. */
export async function walkFiles(dir: string, match: (name: string) => boolean, depth = 0): Promise<string[]> {
	if (depth > MAX_WALK_DEPTH || !existsSync(dir)) return [];
	// A source dir we cannot read is simply a source with no candidates.
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
	if (!entries) return [];
	const found: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...(await walkFiles(full, match, depth + 1)));
		} else if (entry.isFile() && match(entry.name)) {
			found.push(full);
		}
	}
	return found;
}

// ---------------------------------------------------------------------------
// Candidate resolution (id / prefix → exactly one file, or a candidate list).
// ---------------------------------------------------------------------------

export interface SessionCandidate {
	source: SessionSourceName;
	id: string;
	path: string;
	mtimeMs: number;
	/** Coarse harness bucket: first path segment under the source root. */
	project?: string;
}

interface RawMatch {
	source: SessionSourceName;
	id: string;
	path: string;
	matchType: "exact" | "prefix" | "archive";
}

function idMatch(token: string, query: string): "exact" | "prefix" | null {
	if (token === query) return "exact";
	if (query.length > 0 && token.startsWith(query)) return "prefix";
	return null;
}

export function firstSegment(root: string, file: string): string | undefined {
	const rel = relative(root, file);
	if (!rel || rel.startsWith("..")) return undefined;
	return rel.split(/[\\/]/)[0] || undefined;
}

async function toCandidate(match: RawMatch, root: string): Promise<SessionCandidate> {
	let mtimeMs = 0;
	try {
		mtimeMs = (await stat(match.path)).mtimeMs;
	} catch {
		// A file that vanished between listing and stat just sorts oldest.
	}
	return {
		source: match.source,
		id: match.id,
		path: match.path,
		mtimeMs,
		...(firstSegment(root, match.path) ? { project: firstSegment(root, match.path) } : {}),
	};
}

async function collectActiveMatches(id: string, config: SessionReadConfig): Promise<RawMatch[]> {
	const matches: RawMatch[] = [];
	for (const spec of activeSpecs(config)) {
		for (const path of await walkFiles(spec.dir, spec.matchFile)) {
			const token = spec.idOf(basename(path));
			const type = idMatch(token, id);
			if (type) matches.push({ source: spec.name, id: token, path, matchType: type });
		}
	}
	return matches;
}

async function collectArchiveMatches(id: string, archiveDir: string): Promise<RawMatch[]> {
	// The archive holds harvested memory keyed by capture time, not by harness
	// session id, so we can only match on the id appearing in a filename. This is
	// intentionally weak: a hit is whatever archived file mentions the id, and it
	// is NOT guaranteed to be the complete original transcript.
	const files = await walkFiles(archiveDir, (n) => n.endsWith(".jsonl") || n.endsWith(".md") || n.endsWith(".json"));
	return files
		.filter((path) => basename(path).includes(id))
		.map((path) => ({ source: "archive" as const, id, path, matchType: "archive" as const }));
}

// ---------------------------------------------------------------------------
// Record loading (growing-file tolerant, half-line safe).
// ---------------------------------------------------------------------------

interface LoadedRecord {
	index: number;
	raw: string;
	parsed: unknown;
	timestamp?: string;
}

interface LoadedFile {
	records: LoadedRecord[];
	malformed: number;
	partialTrailing: boolean;
}

function extractTimestamp(parsed: unknown): string | undefined {
	if (!parsed || typeof parsed !== "object") return undefined;
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.timestamp === "string") return obj.timestamp;
	const payload = obj.payload;
	if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).timestamp === "string") {
		return (payload as Record<string, unknown>).timestamp as string;
	}
	return undefined;
}

function extractCwd(parsed: unknown): string | undefined {
	if (!parsed || typeof parsed !== "object") return undefined;
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.cwd === "string") return obj.cwd;
	const payload = obj.payload;
	if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).cwd === "string") {
		return (payload as Record<string, unknown>).cwd as string;
	}
	return undefined;
}

async function loadRecords(path: string): Promise<LoadedFile> {
	// One-shot snapshot read with no lock — a concurrently-appending writer keeps
	// working, and we just see whatever was flushed at read time.
	const content = await readFile(path, "utf8");
	const endsWithNewline = content.endsWith("\n");
	const lines = content.split("\n");
	const nonEmpty: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim()) nonEmpty.push(i);
	}
	const lastNonEmpty = nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1] : -1;

	const records: LoadedRecord[] = [];
	let malformed = 0;
	let partialTrailing = false;
	for (const i of nonEmpty) {
		const raw = lines[i].replace(/\r$/, "");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// A final unterminated line on a file without a trailing newline is the
			// classic "read caught a half-written append" case: skip and flag it.
			if (i === lastNonEmpty && !endsWithNewline) {
				partialTrailing = true;
				continue;
			}
			malformed++;
			continue;
		}
		records.push({ index: records.length, raw, parsed, timestamp: extractTimestamp(parsed) });
	}
	return { records, malformed, partialTrailing };
}

// ---------------------------------------------------------------------------
// Modes + hard cap.
// ---------------------------------------------------------------------------

export type SessionMode =
	| { kind: "meta" }
	| { kind: "slice"; offset: number; limit: number }
	| { kind: "head"; count: number }
	| { kind: "tail"; count: number }
	| { kind: "grep"; pattern: string; context?: number };

export interface SessionRecordOut {
	index: number;
	raw: string;
	timestamp?: string;
	/** Set when a single oversized record's raw text was clipped to fit the byte cap. */
	rawTruncated?: boolean;
}

interface CapResult {
	out: SessionRecordOut[];
	truncated: boolean;
	truncatedReason?: "bytes" | "count";
}

function toOut(record: LoadedRecord): SessionRecordOut {
	return { index: record.index, raw: record.raw, ...(record.timestamp ? { timestamp: record.timestamp } : {}) };
}

/** Trim an ordered candidate window to the record/byte ceiling, front-first. */
function applyCaps(candidates: LoadedRecord[], maxRecords: number, maxBytes: number): CapResult {
	const out: SessionRecordOut[] = [];
	let bytes = 0;
	let truncated = false;
	let truncatedReason: "bytes" | "count" | undefined;
	for (const record of candidates) {
		if (out.length >= maxRecords) {
			truncated = true;
			truncatedReason = "count";
			break;
		}
		const lineBytes = Buffer.byteLength(record.raw, "utf8") + 1;
		if (out.length === 0 && lineBytes > maxBytes) {
			// A single record larger than the whole budget: return it clipped rather
			// than nothing, so the byte ceiling still holds.
			out.push({ ...toOut(record), raw: clipToBytes(record.raw, maxBytes), rawTruncated: true });
			truncated = true;
			truncatedReason = "bytes";
			break;
		}
		if (out.length > 0 && bytes + lineBytes > maxBytes) {
			truncated = true;
			truncatedReason = "bytes";
			break;
		}
		out.push(toOut(record));
		bytes += lineBytes;
	}
	return { out, truncated, ...(truncatedReason ? { truncatedReason } : {}) };
}

function clipToBytes(text: string, maxBytes: number): string {
	const marker = "…[record truncated]";
	const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	let end = Math.min(text.length, budget);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > budget) end--;
	return text.slice(0, end) + marker;
}

function buildGrepMatcher(pattern: string): (raw: string) => boolean {
	try {
		const re = new RegExp(pattern);
		return (raw) => re.test(raw);
	} catch {
		// An invalid regex degrades to a literal substring search.
		return (raw) => raw.includes(pattern);
	}
}

// ---------------------------------------------------------------------------
// Result union + public entry point.
// ---------------------------------------------------------------------------

export interface SessionMetaResult {
	status: "meta";
	source: SessionSourceName;
	id: string;
	path: string;
	bytes: number;
	records: number;
	firstTimestamp?: string;
	lastTimestamp?: string;
	cwd?: string;
	project?: string;
	malformed?: number;
	partialTrailing?: boolean;
}

export interface SessionRecordsResult {
	status: "records";
	mode: "slice" | "head" | "tail" | "grep";
	source: SessionSourceName;
	id: string;
	path: string;
	records: SessionRecordOut[];
	returned: number;
	totalRecords: number;
	offset: number;
	nextOffset?: number;
	remaining?: number;
	truncated: boolean;
	truncatedReason?: "bytes" | "count";
	matches?: number;
	malformed?: number;
	partialTrailing?: boolean;
}

export interface SessionAmbiguousResult {
	status: "ambiguous";
	query: string;
	/** Newest-first, capped at SESSION_READ_MAX_CANDIDATES. */
	candidates: SessionCandidate[];
	totalCandidates: number;
}

export interface SessionNotFoundResult {
	status: "not_found";
	query: string;
	searched: string[];
}

export type SessionReadResult =
	| SessionMetaResult
	| SessionRecordsResult
	| SessionAmbiguousResult
	| SessionNotFoundResult;

export interface SessionReadInput {
	id: string;
	mode?: SessionMode;
	env?: NodeJS.ProcessEnv;
	home?: string;
	/** Directory overrides (CLI/extension inject the resolved memory dir here). */
	config?: Partial<SessionReadConfig>;
	maxBytes?: number;
	maxRecords?: number;
}

/** Directory a given source root lives at, for a resolved candidate. */
function rootForSource(source: SessionSourceName, config: SessionReadConfig): string {
	switch (source) {
		case "claude":
			return config.claudeDir;
		case "codex":
			return config.codexDir;
		case "cursor":
			return config.cursorDir;
		case "pi":
			return config.piDir;
		case "archive":
			return config.archiveDir;
	}
}

async function decide(
	id: string,
	config: SessionReadConfig,
): Promise<{ chosen: RawMatch } | { candidates: RawMatch[] } | { none: true }> {
	const active = await collectActiveMatches(id, config);
	if (active.length > 0) {
		const exact = active.filter((m) => m.matchType === "exact");
		const pool = exact.length > 0 ? exact : active;
		return pool.length === 1 ? { chosen: pool[0] } : { candidates: pool };
	}
	const archive = await collectArchiveMatches(id, config.archiveDir);
	if (archive.length === 0) return { none: true };
	return archive.length === 1 ? { chosen: archive[0] } : { candidates: archive };
}

export async function readSession(input: SessionReadInput): Promise<SessionReadResult> {
	const id = input.id?.trim();
	if (!id) throw new Error("session id is required");
	const config = resolveSessionReadConfig(input.env, input.home, input.config);
	const mode: SessionMode = input.mode ?? { kind: "meta" };
	const maxRecords = input.maxRecords ?? SESSION_READ_MAX_RECORDS;
	const maxBytes = input.maxBytes ?? SESSION_READ_MAX_BYTES;

	const decision = await decide(id, config);
	if ("none" in decision) {
		return {
			status: "not_found",
			query: id,
			searched: [config.claudeDir, config.codexDir, config.cursorDir, config.piDir, config.archiveDir],
		};
	}
	if ("candidates" in decision) {
		const candidates = await Promise.all(
			decision.candidates.map((m) => toCandidate(m, rootForSource(m.source, config))),
		);
		candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return {
			status: "ambiguous",
			query: id,
			candidates: candidates.slice(0, SESSION_READ_MAX_CANDIDATES),
			totalCandidates: candidates.length,
		};
	}

	const chosen = decision.chosen;
	const loaded = await loadRecords(chosen.path);
	const project = firstSegment(rootForSource(chosen.source, config), chosen.path);

	if (mode.kind === "meta") {
		const first = loaded.records.find((r) => r.timestamp)?.timestamp;
		let last: string | undefined;
		for (let i = loaded.records.length - 1; i >= 0; i--) {
			if (loaded.records[i].timestamp) {
				last = loaded.records[i].timestamp;
				break;
			}
		}
		const cwd = loaded.records.map((r) => extractCwd(r.parsed)).find((c) => c);
		const bytes = await fileSize(chosen.path);
		return {
			status: "meta",
			source: chosen.source,
			id: chosen.id,
			path: chosen.path,
			bytes,
			records: loaded.records.length,
			...(first ? { firstTimestamp: first } : {}),
			...(last ? { lastTimestamp: last } : {}),
			...(cwd ? { cwd } : {}),
			...(project ? { project } : {}),
			...(loaded.malformed > 0 ? { malformed: loaded.malformed } : {}),
			...(loaded.partialTrailing ? { partialTrailing: true } : {}),
		};
	}

	const total = loaded.records.length;
	const window = selectWindow(loaded.records, mode);
	const cap = applyCaps(window.candidates, maxRecords, maxBytes);
	const returned = cap.out.length;
	const remaining = window.candidates.length - returned;
	// nextOffset resumes the same window; only contiguous modes can be paged by offset.
	const nextOffset = mode.kind !== "grep" && cap.truncated && remaining > 0 ? window.baseOffset + returned : undefined;

	return {
		status: "records",
		mode: mode.kind,
		source: chosen.source,
		id: chosen.id,
		path: chosen.path,
		records: cap.out,
		returned,
		totalRecords: total,
		offset: window.baseOffset,
		...(nextOffset !== undefined ? { nextOffset } : {}),
		...(remaining > 0 ? { remaining } : {}),
		truncated: cap.truncated,
		...(cap.truncatedReason ? { truncatedReason: cap.truncatedReason } : {}),
		...(window.matches !== undefined ? { matches: window.matches } : {}),
		...(loaded.malformed > 0 ? { malformed: loaded.malformed } : {}),
		...(loaded.partialTrailing ? { partialTrailing: true } : {}),
	};
}

interface Window {
	candidates: LoadedRecord[];
	baseOffset: number;
	matches?: number;
}

function selectWindow(records: LoadedRecord[], mode: Exclude<SessionMode, { kind: "meta" }>): Window {
	if (mode.kind === "slice") {
		const offset = Math.max(0, Math.trunc(mode.offset));
		const limit = Math.max(0, Math.trunc(mode.limit));
		return { candidates: records.slice(offset, offset + limit), baseOffset: offset };
	}
	if (mode.kind === "head") {
		const count = Math.max(0, Math.trunc(mode.count));
		return { candidates: records.slice(0, count), baseOffset: 0 };
	}
	if (mode.kind === "tail") {
		const count = Math.max(0, Math.trunc(mode.count));
		const start = Math.max(0, records.length - count);
		return { candidates: records.slice(start), baseOffset: start };
	}
	// grep: matched records plus N context records on each side, merged in order.
	const context = Math.max(0, Math.trunc(mode.context ?? DEFAULT_GREP_CONTEXT));
	const matcher = buildGrepMatcher(mode.pattern);
	const matchIndexes = records.filter((r) => matcher(r.raw)).map((r) => r.index);
	const keep = new Set<number>();
	for (const mi of matchIndexes) {
		for (let j = mi - context; j <= mi + context; j++) {
			if (j >= 0 && j < records.length) keep.add(j);
		}
	}
	const candidates = [...keep].sort((a, b) => a - b).map((i) => records[i]);
	return { candidates, baseOffset: candidates[0]?.index ?? 0, matches: matchIndexes.length };
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Text rendering (shared by CLI and the pi tool).
// ---------------------------------------------------------------------------

export function formatSessionRead(result: SessionReadResult): string {
	if (result.status === "not_found") {
		return [`No session matched "${result.query}".`, "Searched:", ...result.searched.map((d) => `  ${d}`)].join("\n");
	}
	if (result.status === "ambiguous") {
		const lines = [`"${result.query}" matched ${result.totalCandidates} sessions — narrow the id:`];
		for (const c of result.candidates) {
			const when = c.mtimeMs ? new Date(c.mtimeMs).toISOString() : "?";
			lines.push(`  [${c.source}] ${c.id}  (${when})${c.project ? `  ${c.project}` : ""}`);
			lines.push(`      ${c.path}`);
		}
		const hidden = result.totalCandidates - result.candidates.length;
		if (hidden > 0) lines.push(`  … ${hidden} more (newest shown first) — narrow the id further`);
		return lines.join("\n");
	}
	if (result.status === "meta") {
		const lines = [
			`[${result.source}] ${result.id}`,
			`  path:    ${result.path}`,
			`  size:    ${result.bytes} bytes`,
			`  records: ${result.records}`,
		];
		if (result.firstTimestamp) lines.push(`  first:   ${result.firstTimestamp}`);
		if (result.lastTimestamp) lines.push(`  last:    ${result.lastTimestamp}`);
		if (result.cwd) lines.push(`  cwd:     ${result.cwd}`);
		if (result.project) lines.push(`  project: ${result.project}`);
		if (result.malformed) lines.push(`  malformed lines skipped: ${result.malformed}`);
		if (result.partialTrailing) lines.push(`  note:    trailing partial line skipped (file is growing)`);
		lines.push(`  (meta only — use --head/--tail/--slice/--grep to read records)`);
		return lines.join("\n");
	}
	const header =
		result.mode === "grep"
			? `[${result.source}] ${result.id} — grep: ${result.matches ?? 0} match(es), ${result.returned}/${result.totalRecords} records shown`
			: `[${result.source}] ${result.id} — ${result.mode}: records ${result.offset}..${result.offset + result.returned - 1} of ${result.totalRecords}`;
	const body = result.records.map((r) => r.raw);
	const footer: string[] = [];
	if (result.truncated) {
		const reason = result.truncatedReason === "bytes" ? "byte cap" : "record cap";
		if (result.nextOffset !== undefined) {
			footer.push(
				`… truncated (${reason}); ${result.remaining ?? 0} more — page with --slice ${result.nextOffset},<n>`,
			);
		} else {
			footer.push(`… truncated (${reason}); ${result.remaining ?? 0} more record(s) not shown`);
		}
	}
	if (result.partialTrailing) footer.push("note: trailing partial line skipped (file is growing)");
	if (result.malformed) footer.push(`note: ${result.malformed} malformed line(s) skipped`);
	return [header, ...body, ...footer].join("\n");
}
