import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type CompletionResult, invokeCompletion, type ModelLike } from "./model.ts";
import { completionMetaOf, withOpBracket } from "./op-brackets.ts";
import { StorePaths } from "./paths.ts";
import { SELFMOD_PLAN_SUMMARY_MAX, SELFMOD_PROPOSAL_ID_RE } from "./selfmod-pickup.ts";
import { MERGE_CRITERIA, SELFMOD_ALLOWED_PATHS_V1, SELFMOD_OWNED_SKILLS } from "./selfmod-types.ts";
import { SKILL_SCAN_ORGAN_SYSTEM_PROMPT } from "./skill-scan-prompt.ts";
import { SKILLS_PREFIX } from "./skills-drift.ts";
import { readJson, readText, redactSecrets, writeJson, writeText } from "./store.ts";
import { storeLock } from "./store-lock.ts";

export { SKILL_SCAN_ORGAN_SYSTEM_PROMPT };
export const DEFAULT_SKILL_SCAN_INTERVAL_DAYS = 7;
export const SKILL_SCAN_INPUT_BUDGET_CHARS = 48_000;
export const SKILL_SCAN_MODEL_TIMEOUT_MS = 15 * 60 * 1000;

const DAY_MS = 86_400_000;
const SCAFFOLD_COMMENT =
	"SCAFFOLD from the skill-scan organ, not a finished proposal. The patch is deliberately missing: writing it is yours. Moving this file up one level without a patch will be rejected at intake AND will burn the id permanently. Read the finding first, decide whether you even agree with it, and change anything here you disagree with - including the id and the whole plan.";
const FIELD_LABELS = [
	"SKILL",
	"QUOTE",
	"CONFLICTS WITH",
	"WHY THEY CANNOT BOTH BE RIGHT",
	"WHAT FOLLOWING THE SKILL WOULD CAUSE",
	"SLUG",
	"PLAN",
] as const;

export interface SkillScanCandidateRef {
	findingPath: string;
	proposalPath: string;
	skill: string;
}
export interface SkillScanOrganResult {
	candidates: SkillScanCandidateRef[];
	due: boolean;
	error?: string;
	ran: boolean;
	skippedReason?: string;
}
export interface RunSkillScanOrganOptions {
	ifDue?: boolean;
	log?: (line: string) => void;
	model?: ModelLike;
	modelTimeoutMs?: number;
	now?: Date;
	repoRoot: string;
	sendTelegram?: (text: string) => Promise<void>;
}
interface ParsedCandidate {
	cause: string;
	conflict: string;
	plan: string;
	quote: string;
	skill: string;
	slug: string;
	why: string;
}

export async function runSkillScanOrgan(
	memoryDir: string,
	opts: RunSkillScanOrganOptions,
): Promise<SkillScanOrganResult> {
	const now = opts.now ?? new Date();
	const log = opts.log ?? ((line: string) => console.log(line));
	const paths = new StorePaths(memoryDir);
	const prepared = await storeLock(memoryDir, async () => {
		const state = await readJson<Record<string, unknown>>(paths.stateFile, {});
		const last = typeof state.last_skill_scan === "string" ? state.last_skill_scan : undefined;
		return {
			draftOpen: await hasOpenSelfmodDrafts(memoryDir),
			due: isDue(last, DEFAULT_SKILL_SCAN_INTERVAL_DAYS, now.getTime()),
		};
	});
	if (opts.ifDue && !prepared.due) {
		log("skill-scan: not due, skipping");
		return { ran: false, due: false, candidates: [], skippedReason: "not-due" };
	}
	if (prepared.draftOpen) {
		log("skill-scan: draft already open, skipping");
		return { ran: false, due: prepared.due, candidates: [], skippedReason: "draft-open" };
	}
	if (!opts.model) throw new Error("skill-scan requires a model");
	const prompt = await assemblePrompt(opts.repoRoot);
	return finishSkillScan({
		due: prepared.due,
		log,
		memoryDir,
		model: opts.model,
		now,
		paths,
		prompt,
		sendTelegram: opts.sendTelegram,
		timeoutMs: opts.modelTimeoutMs ?? SKILL_SCAN_MODEL_TIMEOUT_MS,
	});
}

async function finishSkillScan(opts: {
	due: boolean;
	log: (line: string) => void;
	memoryDir: string;
	model: ModelLike;
	now: Date;
	paths: StorePaths;
	prompt: string;
	sendTelegram?: (text: string) => Promise<void>;
	timeoutMs: number;
}): Promise<SkillScanOrganResult> {
	return withOpBracket(opts.memoryDir, "skill-scan", async (ctx) => {
		let completion: CompletionResult;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
		const call = invokeCompletion(opts.model, opts.prompt, { strong: true, signal: controller.signal });
		void call.catch(() => {});
		try {
			completion = await Promise.race([call, timeoutRejection(controller.signal, opts.timeoutMs)]);
		} catch (error) {
			const message = controller.signal.aborted
				? skillScanTimeoutError(opts.timeoutMs)
				: error instanceof Error
					? error.message
					: String(error);
			return failSkillScan({ due: opts.due, error: message, log: opts.log, sendTelegram: opts.sendTelegram });
		} finally {
			clearTimeout(timer);
		}
		ctx.noteModel(completionMetaOf(opts.model));
		return handleCompletion(opts, completion.text);
	});
}

async function handleCompletion(
	opts: {
		due: boolean;
		log: (line: string) => void;
		memoryDir: string;
		now: Date;
		paths: StorePaths;
		sendTelegram?: (text: string) => Promise<void>;
	},
	text: string,
): Promise<SkillScanOrganResult> {
	const trimmed = text.trim();
	if (!trimmed) {
		return failSkillScan({
			due: opts.due,
			error: "empty model response",
			log: opts.log,
			sendTelegram: opts.sendTelegram,
		});
	}
	const parsed = parseSkillScanCandidate(trimmed);
	if (parsed === "NO_CANDIDATE") {
		await markLastRun(opts.memoryDir, opts.paths, opts.now);
		opts.log("skill-scan: no candidate");
		return { ran: true, due: true, candidates: [] };
	}
	if (!parsed) {
		return failSkillScan({
			due: opts.due,
			error: "unusable model response",
			log: opts.log,
			sendTelegram: opts.sendTelegram,
		});
	}
	const candidate = await storeLock(opts.memoryDir, () =>
		persistCandidate(opts.memoryDir, opts.paths, opts.now, parsed),
	);
	const telegram = renderTelegram(candidate);
	opts.log(telegram);
	if (opts.sendTelegram) await opts.sendTelegram(telegram);
	return { ran: true, due: true, candidates: [candidate] };
}

function skillScanTimeoutError(timeoutMs: number): string {
	return `skill-scan timed out after ${Math.max(1, Math.round(timeoutMs / 60_000))}m`;
}
function timeoutRejection(signal: AbortSignal, timeoutMs: number): Promise<never> {
	return new Promise((_, reject) => {
		const fail = () => reject(new Error(skillScanTimeoutError(timeoutMs)));
		if (signal.aborted) return fail();
		signal.addEventListener("abort", fail, { once: true });
	});
}

function isDue(lastRun: string | undefined, intervalDays: number, nowMs: number): boolean {
	if (!lastRun) return true;
	const lastMs = Date.parse(lastRun);
	return !Number.isFinite(lastMs) || nowMs - lastMs >= intervalDays * DAY_MS;
}

async function failSkillScan(opts: {
	due: boolean;
	error: string;
	log: (line: string) => void;
	sendTelegram?: (text: string) => Promise<void>;
}): Promise<SkillScanOrganResult> {
	const error = sanitizeSkillScanFailure(opts.error);
	const line = `skill-scan failed: ${error}`;
	opts.log(line);
	if (opts.sendTelegram) await opts.sendTelegram(line);
	return { ran: false, due: opts.due, candidates: [], error };
}

function sanitizeSkillScanFailure(raw: string): string {
	const redacted = redactSecrets(raw).replace(/https?:\/\/\S+/gi, "<redacted-url>");
	return (redacted.replace(/\s+/g, " ").trim() || "model call failed").slice(0, 200);
}

async function hasOpenSelfmodDrafts(memoryDir: string): Promise<boolean> {
	try {
		const names = await readdir(join(memoryDir, "proposals", "selfmod", "drafts"));
		return names.some((name) => /^selfmod-.*\.json$/i.test(name));
	} catch {
		return false;
	}
}

async function assemblePrompt(repoRoot: string): Promise<string> {
	const herMd = (await readText(join(repoRoot, "packages", "her", "pi-package", "prompts", "her.md"))) ?? "";
	const prefix = [
		SKILL_SCAN_ORGAN_SYSTEM_PROMPT,
		"",
		"## Current self-modification rules (from her.md)",
		"",
		extractSelfModification(herMd) || "(missing)",
		"",
		"## System facts (from contract constants)",
		"",
		currentFacts(),
		"",
		"## Owned skills",
		"",
	].join("\n");
	const skills: Array<{ name: string; text: string }> = [];
	for (const name of SELFMOD_OWNED_SKILLS) {
		const body = (await readText(join(repoRoot, ...skillMdRel(name).split("/")))) ?? "";
		skills.push({ name, text: `### ${name}/SKILL.md\n\n${body.trim() || "(missing)"}\n` });
	}
	return fitToBudget(prefix, skills);
}

function currentFacts(): string {
	return [
		`Allowed selfmod paths: ${SELFMOD_ALLOWED_PATHS_V1.join(", ")}`,
		`Owned skills: ${SELFMOD_OWNED_SKILLS.join(", ")}`,
		`Five gates: ${Object.keys(MERGE_CRITERIA).join(", ")}`,
		`Skills drift detection exists for ${SKILLS_PREFIX}`,
	].join("\n");
}

function extractSelfModification(herMd: string): string {
	const match = /^##\s+Self-modification\s*$/m.exec(herMd);
	if (!match || match.index === undefined) return "";
	const start = match.index;
	const rest = herMd.slice(start + match[0].length);
	const next = /^##\s+/m.exec(rest);
	return (next ? herMd.slice(start, start + match[0].length + next.index) : herMd.slice(start)).trim();
}

function fitToBudget(prefix: string, skills: Array<{ name: string; text: string }>): string {
	const truncated: string[] = [];
	const chunks = [...skills];
	let body = prefix + chunks.map((item) => item.text).join("\n");
	for (let i = chunks.length - 1; i >= 0 && body.length > SKILL_SCAN_INPUT_BUDGET_CHARS; i--) {
		const overflow = body.length - SKILL_SCAN_INPUT_BUDGET_CHARS;
		if (!truncated.includes(chunks[i].name)) truncated.unshift(chunks[i].name);
		if (overflow >= chunks[i].text.length) {
			chunks.splice(i, 1);
		} else {
			chunks[i] = { name: chunks[i].name, text: chunks[i].text.slice(0, chunks[i].text.length - overflow) };
		}
		body = prefix + chunks.map((item) => item.text).join("\n");
	}
	if (truncated.length > 0) {
		body += `\n\nTruncated skills (input over ${SKILL_SCAN_INPUT_BUDGET_CHARS} chars): ${truncated.join(", ")}\n`;
	}
	return body;
}

function parseSkillScanCandidate(text: string): ParsedCandidate | "NO_CANDIDATE" | undefined {
	const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (firstLine.toUpperCase() === "NO_CANDIDATE") return "NO_CANDIDATE";
	const fields = extractFields(text);
	const skillRaw = fields.get("SKILL") ?? "";
	const skill = SELFMOD_OWNED_SKILLS.find((name) => name.toLowerCase() === skillRaw.toLowerCase());
	const quote = fields.get("QUOTE") ?? "";
	const conflict = fields.get("CONFLICTS WITH") ?? "";
	const why = fields.get("WHY THEY CANNOT BOTH BE RIGHT") ?? "";
	const cause = fields.get("WHAT FOLLOWING THE SKILL WOULD CAUSE") ?? "";
	const slug = sanitizeSlug(fields.get("SLUG") ?? "");
	let plan = clipPlanAtNextUpperLabel(fields.get("PLAN") ?? "");
	if (plan.length > SELFMOD_PLAN_SUMMARY_MAX) plan = plan.slice(0, SELFMOD_PLAN_SUMMARY_MAX);
	if (!skill || !quote || !conflict || !why || !cause || !slug || !plan) return undefined;
	return { skill, quote, conflict, why, cause, slug, plan };
}

function extractFields(text: string): Map<string, string> {
	const pattern = new RegExp(
		`^(${FIELD_LABELS.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}):\\s*`,
		"gim",
	);
	const matches = [...text.matchAll(pattern)];
	const out = new Map<string, string>();
	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		const label = FIELD_LABELS.find((name) => name.toUpperCase() === match[1].toUpperCase());
		if (!label || out.has(label)) continue;
		const start = (match.index ?? 0) + match[0].length;
		const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
		out.set(label, text.slice(start, end).trim());
	}
	return out;
}

/** PLAN is last in FIELD_LABELS, so extractFields would otherwise swallow a trailing PATCH/diff. */
function clipPlanAtNextUpperLabel(plan: string): string {
	const kept: string[] = [];
	for (const line of plan.split(/\r?\n/)) {
		if (/^[A-Z][A-Z ]*:/.test(line)) break;
		kept.push(line);
	}
	return kept.join("\n").trim();
}

function sanitizeSlug(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)
		.replace(/-$/g, "");
}

function skillMdRel(name: string): string {
	return `${SELFMOD_ALLOWED_PATHS_V1[0]}${name}/SKILL.md`;
}
async function persistCandidate(
	memoryDir: string,
	paths: StorePaths,
	now: Date,
	candidate: ParsedCandidate,
): Promise<SkillScanCandidateRef> {
	const day = now.toISOString().slice(0, 10);
	const compact = day.replaceAll("-", "");
	const findingRel = `proposals/selfmod/drafts/FINDING-${day}-${candidate.slug}.md`;
	const jsonRel = `proposals/selfmod/drafts/selfmod-${compact}-${candidate.slug}.json`;
	const id = `selfmod-${compact}-${candidate.slug}`;
	if (!SELFMOD_PROPOSAL_ID_RE.test(id)) throw new Error(`unusable skill-scan id: ${id}`);
	const scaffold = {
		_comment: SCAFFOLD_COMMENT,
		id,
		createdAt: now.toISOString(),
		motivation: { kind: "failure-anchored" as const, evidenceRef: findingRel },
		targetPaths: [skillMdRel(candidate.skill)],
		planSummary: candidate.plan,
	};
	await writeText(join(memoryDir, ...findingRel.split("/")), renderFinding(candidate, day));
	await writeJson(join(memoryDir, ...jsonRel.split("/")), scaffold);
	await markLastRun(memoryDir, paths, now);
	return { skill: candidate.skill, findingPath: findingRel, proposalPath: jsonRel };
}
async function markLastRun(memoryDir: string, paths: StorePaths, now: Date): Promise<void> {
	await storeLock(memoryDir, async () => {
		const latest = await readJson<Record<string, unknown>>(paths.stateFile, {});
		await writeJson(paths.stateFile, { ...latest, last_skill_scan: now.toISOString() });
	});
}
function renderFinding(candidate: ParsedCandidate, day: string): string {
	const skillRel = skillMdRel(candidate.skill);
	const quote = candidate.quote.replace(/\n/g, "\n> ");
	const conflict = candidate.conflict.replace(/\n/g, "\n> ");
	return `Written by the skill-scan organ on ${day}.

# Finding: \`${candidate.skill}\` contradicts current system facts

## What is wrong

\`${skillRel}\`:

> ${quote}

**CONFLICTS WITH** (quoted with its source):

> ${conflict}

**WHY THEY CANNOT BOTH BE RIGHT**

${candidate.why}

**WHAT FOLLOWING THE SKILL WOULD CAUSE**

${candidate.cause}

## What this does NOT claim

This finding claims only that the quoted instruction and the quoted current fact cannot both be right. It does not claim a style problem, a missing feature, or a future risk. It does not include a patch or the corrected text.

## Refs

- \`${skillRel}\`
- \`packages/her/pi-package/prompts/her.md\` — \`## Self-modification\`
`;
}

function renderTelegram(candidate: SkillScanCandidateRef): string {
	const finding = candidate.findingPath.split("/").pop() ?? candidate.findingPath;
	const proposal = candidate.proposalPath.split("/").pop() ?? candidate.proposalPath;
	return `skill-scan found a candidate in ${candidate.skill}: ${finding}, ${proposal}`;
}
