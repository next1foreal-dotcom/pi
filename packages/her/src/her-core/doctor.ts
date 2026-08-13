import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { findSecretMatches, parseFrontmatter } from "./store.ts";
export type Severity = "fail" | "warn";
export type CheckStatus = "pass" | "warn" | "fail";
export interface CheckResult {
	id: string;
	name: string;
	severity: Severity;
	status: CheckStatus;
	detail: string;
	counts?: Record<string, number>;
}
export interface DoctorReport {
	root: string;
	checks: CheckResult[];
	exitCode: 0 | 1 | 2;
	error?: string;
}
export interface DoctorOptions {
	checks?: string[];
	strict?: boolean;
}
type RawEpisode = { name: string; path: string; ts: string; ms: number; id: string };
type DoctorConfig = {
	heartbeatMaxAgeHours: number;
	lockStaleMinutes: number;
	cursorLagWarn: number;
	linksSeverity: Severity;
	secretsAllowLines: string[];
};
type StateInfo = { value?: Record<string, unknown>; error?: string };
type ConfigInfo = { config: DoctorConfig; error?: string };
type DoctorContext = { root: string; config: DoctorConfig; configError?: string; state: StateInfo };
type CheckDefinition = { id: string; name: string; run: (ctx: DoctorContext) => Promise<CheckResult> };
const DEFAULT_CONFIG: DoctorConfig = {
	heartbeatMaxAgeHours: 48,
	lockStaleMinutes: 30,
	cursorLagWarn: 50,
	linksSeverity: "warn",
	secretsAllowLines: [],
};
const SCAN_EXCLUDED = new Set([".git", ".her", "archive"]);
const SCHEMA_DIRS = ["episodic/raw", "semantic", "world", "topics", "recognitions"] as const;
const CHECKS: CheckDefinition[] = [
	{ id: "DR-01", name: "heartbeat", run: checkHeartbeat },
	{ id: "DR-02", name: "cursor-sync", run: checkCursor },
	{ id: "DR-03", name: "frontmatter-schema", run: checkFrontmatter },
	{ id: "DR-04", name: "wikilinks", run: checkWikilinks },
	{ id: "DR-05", name: "secrets-scan", run: checkSecrets },
	{ id: "DR-06", name: "lock", run: checkLock },
	{ id: "DR-07", name: "state-config", run: checkStateConfig },
];
export async function runDoctor(root: string, opts: DoctorOptions = {}): Promise<DoctorReport> {
	const absoluteRoot = resolve(root);
	try {
		if (!(await stat(absoluteRoot)).isDirectory()) throw new Error("store root is not a directory");
	} catch (error) {
		return { root: absoluteRoot, checks: [], exitCode: 2, error: `store root unavailable: ${errorMessage(error)}` };
	}
	const configInfo = await readDoctorConfig(join(absoluteRoot, ".her", "config.yaml"));
	const context: DoctorContext = {
		root: absoluteRoot,
		config: configInfo.config,
		configError: configInfo.error,
		state: await readState(join(absoluteRoot, ".her", "state.json")),
	};
	let definitions = CHECKS;
	if (opts.checks !== undefined) {
		const requested = new Set(opts.checks);
		const unknown = [...requested].filter((id) => !CHECKS.some((check) => check.id === id));
		if (unknown.length > 0)
			return { root: absoluteRoot, checks: [], exitCode: 2, error: `unknown check: ${unknown.join(", ")}` };
		definitions = CHECKS.filter((check) => requested.has(check.id));
	}
	const checks: CheckResult[] = [];
	for (const definition of definitions) {
		let result: CheckResult;
		try {
			result = await definition.run(context);
		} catch (error) {
			result = resultFor(definition.id, definition.name, "fail", `check error: ${errorMessage(error)}`);
		}
		if (opts.strict && result.status === "warn") result = { ...result, status: "fail" };
		checks.push(result);
	}
	return { root: absoluteRoot, checks, exitCode: checks.some((check) => check.status === "fail") ? 1 : 0 };
}
async function checkHeartbeat(ctx: DoctorContext): Promise<CheckResult> {
	const { episodes, unparsed } = await rawEpisodes(ctx.root);
	const newest = episodes.at(-1);
	if (!newest)
		return resultFor("DR-01", "heartbeat", "fail", `no parseable raw episodes (unparsed=${unparsed})`, { unparsed });
	const ageHours = Math.max(0, (Date.now() - newest.ms) / 3_600_000);
	const status: CheckStatus = ageHours > ctx.config.heartbeatMaxAgeHours ? "fail" : "pass";
	return resultFor(
		"DR-01",
		"heartbeat",
		status,
		`newest episode ${compactTimestamp(newest.ts)} (age ${Math.round(ageHours)}h ${status === "pass" ? "<" : ">"} ${ctx.config.heartbeatMaxAgeHours}h${unparsed ? `, unparsed=${unparsed}` : ""})`,
		{ parsed: episodes.length, unparsed },
	);
}
async function checkCursor(ctx: DoctorContext): Promise<CheckResult> {
	if (ctx.state.error) return resultFor("DR-02", "cursor-sync", "fail", ctx.state.error);
	const cursor = ctx.state.value?.cursor;
	if (cursor === null || cursor === undefined)
		return resultFor("DR-02", "cursor-sync", "pass", "cursor=null lag=0", { lag: 0 });
	let cursorTs: string;
	let doneIds = new Set<string>();
	let legacy = false;
	if (typeof cursor === "string") {
		cursorTs = cursor;
		legacy = true;
	} else if (
		isRecord(cursor) &&
		!Array.isArray(cursor) &&
		typeof cursor.ts === "string" &&
		Array.isArray(cursor.done_ids)
	) {
		cursorTs = cursor.ts;
		if (!cursor.done_ids.every((item) => typeof item === "string"))
			return resultFor("DR-02", "cursor-sync", "fail", "invalid cursor.done_ids");
		doneIds = new Set(cursor.done_ids);
	} else return resultFor("DR-02", "cursor-sync", "fail", "invalid cursor shape");
	const cursorMs = parseTimestamp(cursorTs);
	if (cursorMs === undefined) return resultFor("DR-02", "cursor-sync", "fail", "invalid cursor timestamp");
	const { episodes, unparsed } = await rawEpisodes(ctx.root);
	const newest = episodes.at(-1);
	if (!newest)
		return resultFor(
			"DR-02",
			"cursor-sync",
			"fail",
			`cursor=${compactTimestamp(cursorTs)} but no parseable raw episodes`,
		);
	if (cursorMs > newest.ms)
		return resultFor(
			"DR-02",
			"cursor-sync",
			"fail",
			`cursor=${compactTimestamp(cursorTs)} is later than newest episode ${compactTimestamp(newest.ts)}`,
		);
	const lag = episodes.filter(
		(episode) => episode.ms > cursorMs || (!legacy && episode.ms === cursorMs && !doneIds.has(episode.id)),
	).length;
	const status: CheckStatus = lag > ctx.config.cursorLagWarn ? "warn" : "pass";
	return resultFor(
		"DR-02",
		"cursor-sync",
		status,
		// unparsed episodes are invisible to lag, so a bare number would understate
		// the backlog — say it in the line itself, not just in counts.
		`cursor=${compactTimestamp(cursorTs)} lag=${lag} (${status === "warn" ? ">" : "<"} ${ctx.config.cursorLagWarn})${unparsed ? `, unparsed=${unparsed} not counted — true backlog is larger` : ""}`,
		{ lag, unparsed },
	);
}
async function checkFrontmatter(ctx: DoctorContext): Promise<CheckResult> {
	const missing: string[] = [];
	let filesChecked = 0;
	let missingCount = 0;
	for (const dir of SCHEMA_DIRS)
		for (const path of await markdownFiles(join(ctx.root, dir))) {
			if (basename(path).toLowerCase() === "readme.md") continue;
			const rel = relativePath(ctx.root, path);
			// Capture-time snapshots under world/, not live world notes.
			if (rel.includes("/_snapshots/")) continue;
			filesChecked++;
			const { data } = parseFrontmatter(await readFile(path, "utf8"));
			for (const key of schemaMissing(dir, data)) {
				missingCount++;
				if (missing.length < 20) missing.push(`${rel}:${key}`);
			}
		}
	const status: CheckStatus = missingCount > 0 ? "fail" : "pass";
	return resultFor(
		"DR-03",
		"frontmatter-schema",
		status,
		`${filesChecked} files checked, ${missingCount} missing keys${missing.length ? `; ${missing.join(", ")}` : ""}`,
		{ files: filesChecked, missing: missingCount },
	);
}
async function checkWikilinks(ctx: DoctorContext): Promise<CheckResult> {
	const unresolved: Array<{ target: string; from: string }> = [];
	const allFiles = await scanFiles(ctx.root, (file) => file.toLowerCase().endsWith(".md"));
	// Excluded as link SOURCES — every one of these carries links that are not this
	// store's debt, and together they buried the real findings under ~8.8k noise:
	//   episodic/raw   verbatim transcripts, where [[:space:]] / [[...path]] is code
	//   narrative/context-log  frozen history pointing at long-renamed notes
	//   evals/         generated reports; evals/lint.md quotes the dead links it found
	//   world/         ingested articles, whose links point at the author's own vault
	// All of them still count as link TARGETS.
	const appendOnlySource = (rel: string) =>
		rel.startsWith("episodic/raw/") ||
		rel.startsWith("evals/") ||
		rel.startsWith("world/") ||
		rel === "narrative/context-log.md";
	const files = allFiles.filter((file) => !appendOnlySource(relativePath(ctx.root, file)));
	const known = new Set(allFiles.map((file) => relativePath(ctx.root, file)));
	// The store's own citation convention links episodes by session id
	// ([[episodic/raw/<id>]]) while files are named <timestamp>--<id>.md, so
	// episode links resolve by suffix.
	const rawIds = new Set<string>();
	const bareNames = new Set<string>();
	for (const rel of known) {
		const match = /^episodic\/raw\/.+--(.+)\.md$/.exec(rel);
		if (match) rawIds.add(match[1]);
		bareNames.add(rel.slice(rel.lastIndexOf("/") + 1, -3));
	}
	const texts = await readFiles(files);
	for (let index = 0; index < files.length; index++) {
		const path = files[index];
		for (const match of texts[index].matchAll(/\[\[([^\]]+)\]\]/g)) {
			const target = (match[1] ?? "").split("|", 1)[0].split("#", 1)[0].trim();
			if (!target) continue;
			const episodeId = /^episodic\/raw\/(.+)$/.exec(target)?.[1];
			const resolved =
				episodeId !== undefined
					? rawIds.has(episodeId) || known.has(`${target}.md`)
					: wikilinkExists(target, known, bareNames);
			if (resolved) continue;
			unresolved.push({ target, from: relativePath(ctx.root, path) });
		}
	}
	// Grouped by target, most-referenced first: a flat list of 126 source->target
	// lines is unreadable, while "[[multi-model-sop]] ×3" is a worklist — either
	// write that note or fix the links pointing at it.
	const byTarget = new Map<string, { count: number; from: string }>();
	for (const item of unresolved) {
		const seen = byTarget.get(item.target);
		if (seen) seen.count++;
		else byTarget.set(item.target, { count: 1, from: item.from });
	}
	const ranked = [...byTarget].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
	const severity = ctx.config.linksSeverity;
	const status: CheckStatus = unresolved.length === 0 ? "pass" : severity === "fail" ? "fail" : "warn";
	const detail =
		unresolved.length === 0
			? "0 unresolved"
			: `${unresolved.length} unresolved across ${ranked.length} targets: ${ranked
					.slice(0, 20)
					.map(([target, info]) => `[[${target}]] ×${info.count} (${info.from})`)
					.join(" ")} (links_severity=${severity})`;
	return resultFor(
		"DR-04",
		"wikilinks",
		status,
		detail,
		{ unresolved: unresolved.length, targets: ranked.length },
		severity,
	);
}
async function checkSecrets(ctx: DoctorContext): Promise<CheckResult> {
	const hits: string[] = [];
	let hitCount = 0;
	let placeholderCount = 0;
	const allow = ctx.config.secretsAllowLines.filter(Boolean);
	const files = await scanFiles(
		ctx.root,
		(file) => file.toLowerCase().endsWith(".md") || basename(file).toLowerCase() === "inbox.txt",
	);
	const texts = await readFiles(files);
	for (let index = 0; index < files.length; index++) {
		const path = files[index];
		const text = texts[index];
		const lines = text.split(/\r?\n/);
		for (const match of findSecretMatches(text)) {
			const line = text.slice(0, match.index).split(/\r?\n/).length;
			if (allow.some((allowed) => (lines[line - 1] ?? "").includes(allowed))) continue;
			// `api_key: "$HER_LLM_API_KEY"` is a config example, not a leak. Counting it
			// as one trains the reader to ignore the check, which costs more than the
			// finding is worth.
			if (/\$\{?[A-Za-z_]/.test(text.slice(match.index, match.index + match.length))) {
				placeholderCount++;
				continue;
			}
			hitCount++;
			if (hits.length < 20) hits.push(`${relativePath(ctx.root, path)}:${line}`);
		}
	}
	const status: CheckStatus = hitCount > 0 ? "fail" : "pass";
	const placeholderNote = placeholderCount ? ` (+${placeholderCount} $VAR placeholder refs, not counted)` : "";
	return resultFor(
		"DR-05",
		"secrets-scan",
		status,
		`${hitCount ? `${hitCount} hits: ${hits.join(", ")}` : "0 hits"}${placeholderNote}`,
		{ hits: hitCount, placeholders: placeholderCount },
	);
}
async function checkLock(ctx: DoctorContext): Promise<CheckResult> {
	try {
		const info = await stat(join(ctx.root, ".her", "lock"));
		const ageMinutes = Math.max(0, (Date.now() - info.mtimeMs) / 60_000);
		const status: CheckStatus = ageMinutes > ctx.config.lockStaleMinutes ? "fail" : "pass";
		return resultFor(
			"DR-06",
			"lock",
			status,
			`lock age ${Math.round(ageMinutes)}m ${status === "fail" ? ">" : "<"} ${ctx.config.lockStaleMinutes}m`,
			{ ageMinutes: Math.round(ageMinutes) },
		);
	} catch (error) {
		return isCode(error, "ENOENT")
			? resultFor("DR-06", "lock", "pass", "no .her/lock on disk")
			: resultFor("DR-06", "lock", "fail", `cannot inspect .her/lock: ${errorMessage(error)}`);
	}
}
async function checkStateConfig(ctx: DoctorContext): Promise<CheckResult> {
	const problems = [ctx.state.error, ctx.configError].filter((item): item is string => Boolean(item));
	return resultFor(
		"DR-07",
		"state-config",
		problems.length ? "fail" : "pass",
		problems.length ? problems.join("; ") : "state.json ok, config.yaml ok",
	);
}
function resultFor(
	id: string,
	name: string,
	status: CheckStatus,
	detail: string,
	counts?: Record<string, number>,
	severity: Severity = id === "DR-04" ? "warn" : "fail",
): CheckResult {
	return { id, name, severity, status, detail, ...(counts ? { counts } : {}) };
}
async function rawEpisodes(root: string): Promise<{ episodes: RawEpisode[]; unparsed: number }> {
	const episodes: RawEpisode[] = [];
	let unparsed = 0;
	for (const path of await markdownFiles(join(root, "episodic", "raw"))) {
		const name = basename(path);
		const stem = name.slice(0, -3);
		const marker = stem.indexOf("--");
		const prefix = marker < 0 ? "" : stem.slice(0, marker);
		const parsed = parseEpisodePrefix(prefix);
		if (parsed === undefined) {
			unparsed++;
			continue;
		}
		episodes.push({ name, path, ts: parsed.ts, ms: parsed.ms, id: stem.slice(marker + 2) });
	}
	episodes.sort((a, b) => a.ms - b.ms || a.name.localeCompare(b.name));
	return { episodes, unparsed };
}
async function readState(path: string): Promise<StateInfo> {
	try {
		const parsed: unknown = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
		return isRecord(parsed) && !Array.isArray(parsed)
			? { value: parsed }
			: { error: "state.json must contain an object" };
	} catch (error) {
		return { error: `state.json invalid: ${errorMessage(error)}` };
	}
}
async function readDoctorConfig(path: string): Promise<ConfigInfo> {
	try {
		const raw = parseDoctorYaml(await readFile(path, "utf8"));
		const config = { ...DEFAULT_CONFIG };
		const errors: string[] = [];
		const fields = {
			heartbeat_max_age_hours: "heartbeatMaxAgeHours",
			lock_stale_minutes: "lockStaleMinutes",
			cursor_lag_warn: "cursorLagWarn",
		} as const;
		for (const [key, field] of Object.entries(fields) as Array<[keyof typeof fields, keyof typeof config]>) {
			const value = raw[key];
			if (value === undefined) continue;
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) errors.push(`doctor.${key} invalid`);
			else config[field] = value as never;
		}
		if (raw.links_severity !== undefined) {
			if (raw.links_severity === "warn" || raw.links_severity === "fail") config.linksSeverity = raw.links_severity;
			else errors.push("doctor.links_severity invalid");
		}
		if (raw.secrets_allow_lines !== undefined) {
			if (
				Array.isArray(raw.secrets_allow_lines) &&
				raw.secrets_allow_lines.every((item) => typeof item === "string")
			)
				config.secretsAllowLines = raw.secrets_allow_lines;
			else errors.push("doctor.secrets_allow_lines invalid");
		}
		return errors.length ? { config, error: errors.join(", ") } : { config };
	} catch (error) {
		return { config: { ...DEFAULT_CONFIG }, error: `config.yaml invalid: ${errorMessage(error)}` };
	}
}
function parseDoctorYaml(text: string): Record<string, unknown> {
	if (!text.trim() || !/^\s*[A-Za-z0-9_-]+\s*:/m.test(text)) throw new Error("config.yaml is not a mapping");
	for (const line of text.split(/\r?\n/)) {
		const clean = line.replace(/\s+#.*$/, "");
		if (clean.trim() && !/^(?:\s*[A-Za-z0-9_-]+\s*:|\s+-\s*|\s*#)/.test(clean))
			throw new Error("unsupported YAML syntax");
	}
	const block = /^doctor:\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(text)?.[1] ?? "";
	const flat = block.replace(/^[ \t]+([A-Za-z0-9_-]+):/gm, "$1:");
	return parseFrontmatter(`---\n${flat}\n---`).data;
}
async function readFiles(paths: string[]): Promise<string[]> {
	const out: string[] = [];
	for (let index = 0; index < paths.length; index += 64)
		out.push(...(await Promise.all(paths.slice(index, index + 64).map((path) => readFile(path, "utf8")))));
	return out;
}
async function markdownFiles(dir: string): Promise<string[]> {
	return scanFiles(dir, (path) => path.toLowerCase().endsWith(".md"));
}
async function scanFiles(root: string, include: (path: string) => boolean): Promise<string[]> {
	const out: string[] = [];
	async function visit(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (isCode(error, "ENOENT")) return;
			throw error;
		}
		for (const entry of entries) {
			if (SCAN_EXCLUDED.has(entry.name)) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && include(path)) out.push(path);
		}
	}
	await visit(root);
	return out.sort();
}
function schemaMissing(dir: string, data: Record<string, unknown>): string[] {
	const groups =
		dir === "episodic/raw"
			? [["id"], ["timestamp"], ["project"], ["session_id"]]
			: dir === "semantic"
				? [["type"], ["created"], ["id", "key"]]
				: dir === "world"
					? [
							["id"],
							["content_hash"],
							["source_url", "source"],
							["source_type", "type"],
							["captured_at", "ingested"],
						]
					: dir === "topics"
						? [["theme"], ["created", "updated"], ["members"]]
						: [["id"], ["status"], ["created"]];
	return groups.filter((group) => !group.some((key) => data[key] !== undefined)).map((group) => group.join("|"));
}
/**
 * A path-shaped target must resolve exactly; a bare slug resolves against any
 * note in the store. The four-directory list this replaced predates
 * narrative/, goals/, evals/ and choice-model/, so real links like
 * INDEX.md -> [[CONTEXT]] (narrative/CONTEXT.md) were reported as broken.
 * A truly dead slug still matches nothing and is still reported.
 */
function wikilinkExists(target: string, known: Set<string>, bareNames: Set<string>): boolean {
	const normalized = target.replace(/^\.\//, "");
	if (normalized.includes("/")) {
		const name = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
		return known.has(name);
	}
	return bareNames.has(normalized.endsWith(".md") ? normalized.slice(0, -3) : normalized);
}
/**
 * Raw filenames exist in three generations: the current `2026-08-11T14_03--<id>`,
 * the older compact `2026-05-07T0056--<id>`, and bulk session exports named by
 * date only (`2026-06-05--FULL-SESSION-export--<id>`). Recognising only the first
 * left 3999 of 5533 episodes invisible to DR-01/DR-02, so the reported lag read
 * far lower than the real backlog. Kept separate from parseTimestamp, which
 * guards the cursor and must stay strict (DR-02 fails loud on odd shapes).
 */
function parseEpisodePrefix(prefix: string): { ms: number; ts: string } | undefined {
	const text = prefix.trim();
	const withTime = /^(\d{4}-\d{2}-\d{2})T(\d{2})[_:]?(\d{2})/.exec(text);
	if (withTime) {
		const ts = `${withTime[1]}T${withTime[2]}:${withTime[3]}`;
		const ms = Date.parse(`${ts}Z`);
		return Number.isFinite(ms) ? { ms, ts } : undefined;
	}
	const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(text);
	if (dateOnly) {
		// Day-granular: a bulk export carries no clock time, so it sorts at midnight.
		const ms = Date.parse(`${dateOnly[1]}T00:00Z`);
		return Number.isFinite(ms) ? { ms, ts: `${dateOnly[1]}T00:00` } : undefined;
	}
	return undefined;
}
function parseTimestamp(raw: string): number | undefined {
	const text = raw.trim().replace(/_/g, ":");
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return undefined;
	const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
	return Number.isFinite(ms) ? ms : undefined;
}
const compactTimestamp = (raw: string): string => raw.replace(/_/g, ":").replace(/T(\d{2}):(\d{2})/, "T$1$2");
const relativePath = (root: string, path: string): string => relative(root, path).split(sep).join("/");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isCode = (error: unknown, code: string): boolean =>
	Boolean(error && typeof error === "object" && "code" in error && error.code === code);
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
