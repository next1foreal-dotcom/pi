import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
	ChoiceModelDomain,
	ChoiceRuleEvidence,
	ChoiceRuleRecord,
	ClaimLedgerEntry,
	ContextUpdateInput,
	ContextUpdateRecord,
	JudgmentFields,
	WorldNoteData,
} from "./memory-types.ts";
import { readText } from "./store.ts";

const execFileAsync = promisify(execFile);
export const UNIT_TYPES = new Set(["question", "concept", "opinion", "case", "solution"]);
const RELATION_TYPES = new Set(["replaces", "enriches", "confirms", "challenges", "relates"]);
const RELATION_TYPE_ALIASES = new Map([
	["responds", "enriches"],
	["explains", "enriches"],
	["proves", "confirms"],
	["supports", "confirms"],
	["conflict", "challenges"],
	["conflicts", "challenges"],
	["contradicts", "challenges"],
	["questions", "challenges"],
	["supersedes", "replaces"],
	["updates", "replaces"],
]);
const CHALLENGE_RELATIONS = new Set(["challenges", "conflicts"]);
const ACTIVE_MEMORY_TIERS = new Set(["exact", "summarizable", "rule", "decay"]);
const CHOICE_MODEL_DOMAINS = new Set(["code-style", "writing-style", "design-taste", "communication-tone"]);
const CHOICE_RULES_MARKER = "her-choice-rules";
const CHOICE_RULE_STALE_AFTER_DAYS = 30;

export async function readChoiceModelRuleFiles(
	dir: string,
): Promise<Array<{ name: string; text: string; rules: ChoiceRuleRecord[] }>> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	const markdown = names.filter((name) => name.endsWith(".md")).sort((a, b) => a.localeCompare(b));
	const files: Array<{ name: string; text: string; rules: ChoiceRuleRecord[] }> = [];
	for (const name of markdown) {
		const text = await readText(join(dir, name));
		if (text?.trim()) files.push({ name, text, rules: parseChoiceRuleRecords(text) });
	}
	return files;
}

export function validateChoiceModelDomain(domain: string): ChoiceModelDomain {
	if (CHOICE_MODEL_DOMAINS.has(domain)) return domain as ChoiceModelDomain;
	throw new Error(`unknown choice-model domain: ${domain}`);
}

export function validateFeedbackWeight(weight: number | undefined): number {
	if (weight === undefined) return 1;
	if (!Number.isFinite(weight)) throw new Error("feedback weight must be finite");
	const normalized = Math.floor(weight);
	if (normalized < 1) throw new Error("feedback weight must be at least 1");
	return normalized;
}

export function parseChoiceRuleRecords(text: string): ChoiceRuleRecord[] {
	const pattern = new RegExp(`<!-- ${CHOICE_RULES_MARKER}\\n([\\s\\S]*?)\\n-->`, "m");
	const match = pattern.exec(text);
	if (!match) return [];
	try {
		const parsed = JSON.parse(match[1] ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((item) => normalizeChoiceRuleRecord(item));
	} catch {
		return [];
	}
}

export function normalizeChoiceRuleRecord(value: unknown): ChoiceRuleRecord[] {
	if (!value || typeof value !== "object") return [];
	const record = value as Partial<ChoiceRuleRecord>;
	if (typeof record.id !== "string" || typeof record.rule !== "string") return [];
	const evidence = Array.isArray(record.evidence)
		? record.evidence.flatMap((item) => {
				if (!item || typeof item !== "object") return [];
				const maybe = item as Partial<ChoiceRuleEvidence>;
				if (
					typeof maybe.at !== "string" ||
					typeof maybe.task !== "string" ||
					typeof maybe.diff_summary !== "string"
				) {
					return [];
				}
				return [{ at: maybe.at, task: maybe.task, diff_summary: maybe.diff_summary }];
			})
		: [];
	return [
		{
			id: record.id,
			rule: record.rule,
			weight: typeof record.weight === "number" && Number.isFinite(record.weight) ? record.weight : 1,
			first_recorded: typeof record.first_recorded === "string" ? record.first_recorded : today(),
			last_triggered: typeof record.last_triggered === "string" ? record.last_triggered : today(),
			status: record.status === "stale" ? "stale" : "active",
			evidence,
		},
	];
}

export function renderChoiceRuleFile(domain: ChoiceModelDomain, rules: ChoiceRuleRecord[]): string {
	const active = rules.filter((rule) => rule.status === "active");
	const stale = rules.filter((rule) => rule.status === "stale");
	const sections = [
		`# ${choiceModelDomainTitle(domain)}`,
		"",
		renderChoiceRuleSection("Active Rules", active),
		renderChoiceRuleSection("Stale Rules", stale),
		`<!-- ${CHOICE_RULES_MARKER}`,
		JSON.stringify(rules, null, 2),
		"-->",
		"",
	];
	return sections.filter((section) => section !== "").join("\n");
}

export function renderChoiceRuleSection(title: string, rules: ChoiceRuleRecord[]): string {
	if (rules.length === 0) return `## ${title}\n\n(none)\n`;
	return [
		`## ${title}`,
		"",
		...rules.map((rule) => {
			const label = rule.status === "stale" ? `stale weight ${rule.weight}` : `weight ${rule.weight}`;
			const latest = rule.evidence.at(-1);
			const detail = latest ? `\n  - last: ${rule.last_triggered.slice(0, 10)} · ${latest.task}` : "";
			return `- [${label}] ${rule.rule}${detail}`;
		}),
		"",
	].join("\n");
}

export function renderTasteRuleSummary(files: Array<{ name: string; rules: ChoiceRuleRecord[] }>): string {
	const now = new Date().toISOString();
	const sections: string[] = [];
	for (const file of files) {
		const domain = file.name.replace(/\.md$/, "");
		if (!CHOICE_MODEL_DOMAINS.has(domain) || file.rules.length === 0) continue;
		const rules = sortChoiceRules(file.rules, now).map((rule) => ({
			...rule,
			status: choiceRuleRuntimeStatus(rule, now),
		}));
		sections.push(`## Your Taste Rules (${domain})`);
		for (const rule of rules) {
			const label = rule.status === "stale" ? `stale weight ${rule.weight}` : `weight ${rule.weight}`;
			sections.push(`- [${label}] ${rule.rule}`);
		}
		sections.push("");
	}
	return sections.length > 0 ? `# Your Taste Rules\n\n${sections.join("\n").trim()}` : "";
}

export function sortChoiceRules(rules: ChoiceRuleRecord[], now: string): ChoiceRuleRecord[] {
	return [...rules].sort((a, b) => {
		const aStale = choiceRuleRuntimeStatus(a, now) === "stale";
		const bStale = choiceRuleRuntimeStatus(b, now) === "stale";
		if (aStale !== bStale) return aStale ? 1 : -1;
		if (a.weight !== b.weight) return b.weight - a.weight;
		return b.last_triggered.localeCompare(a.last_triggered);
	});
}

export function choiceRuleRuntimeStatus(rule: ChoiceRuleRecord, now: string): "active" | "stale" {
	return daysBetween(rule.last_triggered, now) > CHOICE_RULE_STALE_AFTER_DAYS ? "stale" : "active";
}

export function daysBetween(from: string, to: string): number {
	const start = Date.parse(from);
	const end = Date.parse(to);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
	return Math.floor((end - start) / 86_400_000);
}

export function normalizeChoiceRule(rule: string): string {
	return rule.trim().toLowerCase().replace(/\s+/g, " ");
}

export function choiceModelDomainTitle(domain: ChoiceModelDomain): string {
	if (domain === "code-style") return "Code Style Rules";
	if (domain === "writing-style") return "Writing Style Rules";
	if (domain === "design-taste") return "Design Taste Rules";
	return "Communication Tone Rules";
}

export function episodeSection(
	sid: string,
	ts: string,
	project: string,
	summary: string,
	rawStem: string,
	pending: boolean,
): string {
	return `\n## ${sid} · ${ts.replace("T", " ")} · project: ${project}\n${summary}\n- raw: [[episodic/raw/${rawStem}]]\n- summary_pending: ${String(pending)}\n`;
}

export function worldBody(data: WorldNoteData, memoryStatusReason: string): string {
	return `# ${data.title}

## Extracted Content

${data.extracted}

## Coverage

${data.coverage}

## Claim Ledger

${claimLedgerBody(data.claims ?? [])}

## Samantha's Read

${data.read}

## What To Steal

${data.steal.map((item) => `- ${item}`).join("\n")}

## Connections

${data.connections.map((item) => `- [[${item}]]`).join("\n")}

## Samantha's Take

${data.take}

## Possible Moves

${data.possibleMoves.map((item) => `- ${item}`).join("\n")}

## Memory Status

- status: ${data.memoryStatus}
- reason: ${memoryStatusReason}

## Judgment Trail

`;
}

export function normalizeMemoryStatusReason(status: WorldNoteData["memoryStatus"], reason: string | undefined): string {
	const trimmed = reason?.trim();
	if (trimmed) return trimmed;
	if (status === "active") return "Trusted writer marked this source active after intake.";
	throw new Error(`${status} world note requires memoryStatusReason`);
}

export function claimLedgerBody(claims: ClaimLedgerEntry[]): string {
	if (claims.length === 0) return "(none recorded)";
	return claims
		.map((claim) =>
			[
				`- claim: ${claim.claim}`,
				`  verdict: ${claim.verdict}`,
				`  evidence: ${claim.evidence}`,
				`  source_quality: ${claim.sourceQuality}`,
				claim.caveats ? `  caveats: ${claim.caveats}` : undefined,
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n");
}

export function appendJudgment(body: string, fields: JudgmentFields): string {
	const heading = "## Judgment Trail";
	const entry = [`### ${new Date().toISOString()}`];
	for (const [key, value] of Object.entries(fields)) {
		if (value) entry.push(`- ${snakeCase(key)}: ${value}`);
	}
	const block = `${entry.join("\n")}\n`;
	if (body.includes(heading)) return `${body.trimEnd()}\n\n${block}`;
	return `${body.trimEnd()}\n\n${heading}\n\n${block}`;
}

export function contextLogBlock(id: string, timestamp: string, input: ContextUpdateInput): string {
	const drivenBy = input.drivenBy.length > 0 ? input.drivenBy.join(", ") : "(none)";
	const change = input.change.replace(/\r?\n/g, " ");
	return `\n### ${id} · ${timestamp} · ${input.type}
- commit: self
- driven_by: ${drivenBy}
- change: ${change}
- status: unreviewed
`;
}

export function choiceModelLogBlock(id: string, timestamp: string, drivenBy: string[]): string {
	return `\n### ${id} · ${timestamp}
- commit: self
- driven_by: ${drivenBy.join(", ")}
- change: Synthesize choice model from Judgment Trail
- status: unreviewed
`;
}

export function selfNarrativeLogBlock(id: string, timestamp: string, drivenBy: string[]): string {
	return `\n### ${id} · ${timestamp}
- commit: self
- driven_by: ${drivenBy.join(", ")}
- change: Synthesize Samantha self narrative
- status: unreviewed
`;
}

export function parseContextLog(text: string): ContextUpdateRecord[] {
	const records: ContextUpdateRecord[] = [];
	for (const block of text.split(/\n(?=### )/)) {
		const header = /^###\s+(\S+)\s+·\s+(.+?)\s+·\s+(.+)\s*$/m.exec(block);
		if (!header) continue;
		const rawStatus = contextLogField(block, "status");
		const status =
			rawStatus === "kept" || rawStatus === "reverted" || rawStatus === "unreviewed" ? rawStatus : "unreviewed";
		const drivenBy = contextLogField(block, "driven_by");
		const commit = contextLogField(block, "commit");
		records.push({
			id: header[1],
			timestamp: header[2],
			type: header[3],
			change: contextLogField(block, "change"),
			status,
			drivenBy:
				drivenBy && drivenBy !== "(none)"
					? drivenBy
							.split(",")
							.map((item) => item.trim())
							.filter(Boolean)
					: [],
			commit: commit || undefined,
		});
	}
	return records;
}

export function contextLogField(block: string, name: string): string {
	const match = new RegExp(`^- ${escapeRegExp(name)}:\\s*(.*)$`, "m").exec(block);
	return match?.[1]?.trim() ?? "";
}

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripSection(body: string, heading: string): string {
	const pattern = new RegExp(`\\n?## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`, "m");
	return body.replace(pattern, "").trimEnd();
}

export function extractSection(body: string, heading: string): string {
	const marker = `## ${heading}`;
	const start = body.indexOf(marker);
	if (start < 0) return "";
	const afterHeading = body.slice(start + marker.length).replace(/^\r?\n/, "");
	const nextHeading = afterHeading.search(/\r?\n## /);
	return (nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading).trim();
}

export function genId(seedA: string, seedB: string): string {
	return createHash("sha1").update(`${seedA}${seedB}`).digest("hex").slice(0, 8);
}

export function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "note"
	);
}

export function safeStem(text: string): string {
	return text.replace(/[^A-Za-z0-9._-]/g, "_") || "x";
}

export function isFileExists(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

export function isNotFound(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export function sourceRef(source: string): string {
	const trimmed = source.trim();
	if (!trimmed) return "[[episodic/raw/unknown]]";
	if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) return trimmed;
	if (trimmed.includes("/")) return `[[${trimmed.replace(/\.md$/, "")}]]`;
	return `[[episodic/raw/${trimmed.replace(/\.md$/, "")}]]`;
}

export function sameStrings(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function changedAfter(data: Record<string, unknown>, lastTime: number | undefined): boolean {
	if (lastTime === undefined) return true;
	const noteTime = parseDate(String(data.updated ?? data.created ?? ""));
	return noteTime !== undefined && noteTime > lastTime;
}

export function hasConflictRelation(relations: unknown): boolean {
	if (!Array.isArray(relations)) return false;
	return relations.some(
		(relation) =>
			relation !== null &&
			typeof relation === "object" &&
			"rel" in relation &&
			CHALLENGE_RELATIONS.has(normalizeRelationType(relation.rel)),
	);
}

export function parseDate(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const time = Date.parse(value);
	return Number.isNaN(time) ? undefined : time;
}

export function daysSince(time: number | undefined): number | undefined {
	if (time === undefined) return undefined;
	return Math.floor((Date.now() - time) / 86400000);
}

export function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

export async function readLastSyncedAt(cwd: string): Promise<{ value?: string; error?: string }> {
	try {
		// Git does not store a durable push timestamp locally; upstream HEAD time is the closest sync signal.
		const value = (await git(cwd, "log", "-1", "--format=%cI", "@{upstream}")).stdout.trim();
		return value ? { value } : {};
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const JSON_LEGAL_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

export function repairJsonEscapes(source: string): string {
	let out = "";
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char !== "\\") {
			out += char;
			continue;
		}
		const next = source[i + 1];
		const isLegal =
			next !== undefined &&
			JSON_LEGAL_ESCAPES.has(next) &&
			(next !== "u" || /^[0-9a-fA-F]{4}/.test(source.slice(i + 2, i + 6)));
		out += isLegal ? "\\" : "\\\\";
	}
	return out;
}

export function extractJson<T>(text: string): T {
	let source = text.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
	if (fence) source = fence[1].trim();
	try {
		return JSON.parse(source) as T;
	} catch (originalError) {
		try {
			return JSON.parse(repairJsonEscapes(source)) as T;
		} catch (repairError) {
			throw new Error(
				`extractJson failed. original error: ${errorMessage(originalError)}; after repair attempt error: ${errorMessage(repairError)}`,
			);
		}
	}
}

export async function markdownEntries(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((entry) => entry.endsWith(".md")).sort();
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

export async function markdownStems(dir: string): Promise<string[]> {
	return (await markdownEntries(dir)).map((entry) => entry.replace(/\.md$/, ""));
}

export async function readMarkdownDir(dir: string): Promise<string> {
	const chunks = [];
	for (const entry of await markdownEntries(dir)) {
		chunks.push((await readText(join(dir, entry))) ?? "");
	}
	return chunks.join("\n\n");
}

export function normalizeRelations(note: Record<string, unknown>): Array<{ to: string; rel: string }> {
	const raw =
		Array.isArray(note.relations) && note.relations.length > 0
			? note.relations
			: Array.isArray(note.links)
				? note.links.map((link) => ({ to: link, rel: "relates" }))
				: [];
	const out: Array<{ to: string; rel: string }> = [];
	for (const item of raw) {
		const record: Record<string, unknown> =
			item && typeof item === "object" ? (item as Record<string, unknown>) : { to: item };
		const to = slug(String(record.to ?? ""));
		if (!to) continue;
		out.push({ to, rel: normalizeRelationType(record.rel) });
	}
	return out;
}

export function normalizeRelationType(value: unknown): string {
	const raw = String(value ?? "relates")
		.trim()
		.toLowerCase();
	const aliased = RELATION_TYPE_ALIASES.get(raw) ?? raw;
	return RELATION_TYPES.has(aliased) ? aliased : "relates";
}

export function normalizeActiveTier(value: unknown, fallback: unknown): string {
	if (typeof value === "string" && ACTIVE_MEMORY_TIERS.has(value)) return value;
	if (typeof fallback === "string" && ACTIVE_MEMORY_TIERS.has(fallback)) return fallback;
	return "summarizable";
}

export function timestampMinute(): string {
	return new Date().toISOString().slice(0, 16);
}

export function snakeCase(text: string): string {
	return text.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}
