/**
 * G-355 — acceptance judge. Assembles task evidence, calls the model once,
 * writes a verdict sidecar. Never touches the task record, never writes git,
 * never merges, never changes status.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { ACCEPT_JUDGE_SYSTEM_PROMPT } from "./acceptance-judge-prompt.ts";
import { ACCEPTANCE_REPORT_FILENAME } from "./bg-task-acceptance.ts";
import { type BgTaskRecord, loadBgTask, taskMdPath, tasksDir } from "./bg-task-record.ts";
import { type CompletionResult, invokeCompletion, type ModelLike } from "./model.ts";
import { readText, redactSecrets, writeJson } from "./store.ts";

export { ACCEPT_JUDGE_SYSTEM_PROMPT };

const execFileAsync = promisify(execFile);

export const ACCEPT_INPUT_BUDGET_CHARS = 48_000;
export const ACCEPT_MODEL_TIMEOUT_MS = 10 * 60 * 1000;
export const ACCEPT_LOG_TAIL_CHARS = 8_000;
const GIT_READ_TIMEOUT_MS = 60_000;
const GIT_READ_VERBS = new Set(["diff", "log", "status", "merge-base", "rev-parse", "show"]);
const NO_DIFF_GAP = "无 diff:非隔离任务";
const NO_GATES_NOTE = "无门禁记录,verdict 不得引用门禁绿";

export type AcceptanceJudgeVerdict = "PASS" | "FIX" | "ESCALATE";
export type AcceptanceJudgeConfidence = "high" | "low";

export type GitRead = (cwd: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

export interface AcceptanceJudgeDocument {
	verdict: AcceptanceJudgeVerdict;
	reasons: string[];
	silences: string[];
	out_of_scope: string[];
	evidence_gaps: string[];
	confidence: AcceptanceJudgeConfidence;
	model: string;
	at: string;
	previous?: AcceptanceJudgeDocument[];
}

export interface AssembledAcceptanceEvidence {
	evidence_gaps: string[];
	text: string;
	truncated: boolean;
}

export interface RunAcceptanceJudgeOptions {
	force?: boolean;
	gitRun?: GitRead;
	log?: (line: string) => void;
	model?: ModelLike;
	modelTimeoutMs?: number;
	now?: Date;
	sendTelegram?: (text: string) => Promise<void>;
}

export interface AcceptanceJudgeResult {
	document?: AcceptanceJudgeDocument;
	error?: string;
	ran: boolean;
	usage?: boolean;
}

export function acceptanceJudgeFilename(taskId: string): string {
	return `${taskId}.judge.json`;
}

export function acceptanceJudgePath(memoryRoot: string, taskId: string): string {
	return join(tasksDir(memoryRoot), acceptanceJudgeFilename(taskId));
}

export async function assembleAcceptanceEvidence(
	memoryRoot: string,
	taskId: string,
	opts: { gitRun?: GitRead } = {},
): Promise<AssembledAcceptanceEvidence> {
	const loaded = await loadTaskOrThrow(memoryRoot, taskId);
	return assembleFromRecord(memoryRoot, loaded.record, opts.gitRun ?? defaultGitRead);
}

export async function runAcceptanceJudge(
	memoryRoot: string,
	taskId: string,
	opts: RunAcceptanceJudgeOptions = {},
): Promise<AcceptanceJudgeResult> {
	const log = opts.log ?? ((line: string) => console.log(line));
	const now = opts.now ?? new Date();
	let loaded: { record: BgTaskRecord; body: string };
	try {
		loaded = await loadTaskOrThrow(memoryRoot, taskId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(message);
		return { ran: false, error: message, usage: true };
	}

	const outPath = acceptanceJudgePath(memoryRoot, taskId);
	const existingText = await readText(outPath);
	if (existingText !== undefined && !opts.force) {
		const message = `accept: ${acceptanceJudgeFilename(taskId)} already exists; pass --force to overwrite`;
		log(message);
		return { ran: false, error: message };
	}

	if (!opts.model) {
		return failJudge({ error: "accept requires a model", log, sendTelegram: opts.sendTelegram });
	}

	let assembled: AssembledAcceptanceEvidence;
	try {
		assembled = await assembleFromRecord(memoryRoot, loaded.record, opts.gitRun ?? defaultGitRead);
	} catch (error) {
		return failJudge({
			error: error instanceof Error ? error.message : String(error),
			log,
			sendTelegram: opts.sendTelegram,
		});
	}

	const prompt = `${ACCEPT_JUDGE_SYSTEM_PROMPT}\n\n## Assembled evidence\n\n${assembled.text}`;
	const timeoutMs = opts.modelTimeoutMs ?? ACCEPT_MODEL_TIMEOUT_MS;
	let completion: CompletionResult;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const call = invokeCompletion(opts.model, prompt, { strong: true, signal: controller.signal });
	void call.catch(() => {});
	try {
		completion = await Promise.race([call, timeoutRejection(controller.signal, timeoutMs)]);
	} catch (error) {
		const message = controller.signal.aborted
			? acceptTimeoutError(timeoutMs)
			: error instanceof Error
				? error.message
				: String(error);
		return failJudge({ error: message, log, sendTelegram: opts.sendTelegram });
	} finally {
		clearTimeout(timer);
	}

	const trimmed = completion.text.trim();
	if (!trimmed) {
		return failJudge({ error: "empty model response", log, sendTelegram: opts.sendTelegram });
	}
	const parsed = parseJudgeVerdict(trimmed);
	if (!parsed) {
		const failed = await failJudge({
			error: "unusable model response: missing or invalid verdict",
			log,
			sendTelegram: opts.sendTelegram,
		});
		const head = trimmed.replace(/\s+/g, " ").trim().slice(0, 120);
		return { ...failed, error: `${failed.error}; head: ${head}` };
	}

	const evidenceGaps = unionGaps(parsed.evidence_gaps, assembled.evidence_gaps);
	const previous = opts.force ? previousFromExisting(existingText) : undefined;
	const document: AcceptanceJudgeDocument = {
		verdict: parsed.verdict,
		reasons: parsed.reasons,
		silences: parsed.silences,
		out_of_scope: parsed.out_of_scope,
		evidence_gaps: evidenceGaps,
		confidence: parsed.confidence,
		model: completion.model?.trim() || "unknown",
		at: now.toISOString(),
		...(previous && previous.length > 0 ? { previous } : {}),
	};
	await writeJson(outPath, document);
	const line = `accept ${taskId}: ${document.verdict}`;
	log(line);
	if (opts.sendTelegram) await opts.sendTelegram(line);
	return { ran: true, document };
}

async function loadTaskOrThrow(memoryRoot: string, taskId: string): Promise<{ record: BgTaskRecord; body: string }> {
	const path = taskMdPath(memoryRoot, taskId);
	try {
		const loaded = await loadBgTask(memoryRoot, taskId);
		if (!loaded) {
			throw new Error(`accept: task not found: ${taskId} (looked in ${path})`);
		}
		return loaded;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("accept:")) throw error;
		throw new Error(`accept: cannot read record for ${taskId} (looked in ${path}): ${message}`);
	}
}

async function assembleFromRecord(
	memoryRoot: string,
	record: BgTaskRecord,
	gitRun: GitRead,
): Promise<AssembledAcceptanceEvidence> {
	const gaps: string[] = [];
	const dir = tasksDir(memoryRoot);
	const brief = (await readText(join(dir, `${record.id}.brief`))) ?? "";
	const rawLog = (await readText(join(dir, `${record.id}.log`))) ?? "";
	const worktree = typeof record.worktree === "string" ? record.worktree.trim() : "";
	const hasWorktree = worktree.length > 0;

	if (!hasWorktree) gaps.push(NO_DIFF_GAP);

	const recordView: Record<string, unknown> = {
		id: record.id,
		objective: record.objective,
		worker: record.worker,
		command: record.command,
		status: record.status,
		...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
		...(record.failureReason !== undefined ? { failureReason: record.failureReason } : {}),
		...(record.worktree !== undefined ? { worktree: record.worktree } : {}),
		...(record.worktreeBaseSha !== undefined ? { worktreeBaseSha: record.worktreeBaseSha } : {}),
		acceptance: record.acceptance ?? NO_GATES_NOTE,
	};
	if (record.acceptance === undefined) {
		recordView.acceptance = NO_GATES_NOTE;
	}

	const fixed: string[] = [
		`## 记录\n\n${JSON.stringify(recordView, null, 2)}`,
		`## 任务书\n\n${brief || "(missing)"}`,
	];
	if (record.acceptance === undefined) {
		fixed.push(`## G-206 门禁\n\n${NO_GATES_NOTE}`);
	} else {
		fixed.push(`## G-206 门禁\n\n${JSON.stringify(record.acceptance, null, 2)}`);
	}

	if (hasWorktree) {
		const report = await readText(join(worktree, ACCEPTANCE_REPORT_FILENAME));
		if (report !== undefined) {
			fixed.push(`## 执行方自述（自述,仅线索）\n\n${report}`);
		}
	}

	let logKept = Math.min(ACCEPT_LOG_TAIL_CHARS, rawLog.length);
	let logTruncated = rawLog.length > ACCEPT_LOG_TAIL_CHARS;

	const diffs: Array<{ path: string; raw: string; kept: number }> = [];
	let statText = "";

	if (hasWorktree) {
		const baseline = await resolveBaseline(worktree, record, gitRun, gaps);
		if (baseline) {
			try {
				const stat = await gitRun(worktree, ["diff", "--stat", `${baseline}...HEAD`]);
				statText = `## git diff --stat\n\n${stat.stdout.trim() || "(empty)"}`;
			} catch (error) {
				gaps.push(`git diff --stat failed: ${errorMessage(error)}`);
			}
			try {
				const names = await gitRun(worktree, ["diff", "--name-only", `${baseline}...HEAD`]);
				const files = names.stdout
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter(Boolean);
				for (const path of files) {
					try {
						const diff = await gitRun(worktree, ["diff", `${baseline}...HEAD`, "--", path]);
						const raw = diff.stdout;
						diffs.push({ path, raw, kept: raw.length });
					} catch (error) {
						gaps.push(`git diff -- ${path} failed: ${errorMessage(error)}`);
					}
				}
			} catch (error) {
				gaps.push(`git diff --name-only failed: ${errorMessage(error)}`);
			}
		} else if (!gaps.some((gap) => gap.includes("基线"))) {
			gaps.push("基线 commit 缺失,无法 diff");
		}
	} else {
		fixed.push(`## git diff\n\n${NO_DIFF_GAP}`);
	}

	const render = (): string => {
		const logSection = renderLog(rawLog, logKept, logTruncated);
		const diffSections = diffs.map((item) => renderDiff(item.path, item.raw, item.kept));
		return [...fixed, logSection, statText, ...diffSections].filter((part) => part.length > 0).join("\n\n");
	};

	let text = render();
	while (text.length > ACCEPT_INPUT_BUDGET_CHARS) {
		const over = text.length - ACCEPT_INPUT_BUDGET_CHARS;
		if (logKept > 0) {
			logKept = Math.max(0, logKept - over);
			logTruncated = true;
			text = render();
			continue;
		}
		const biggest = diffs.reduce<AssembledDiff | undefined>(
			(current, item) => (!current || item.kept > current.kept ? item : current),
			undefined,
		);
		if (!biggest || biggest.kept <= 0) break;
		biggest.kept = Math.max(0, biggest.kept - over);
		text = render();
	}

	return {
		text,
		evidence_gaps: gaps,
		truncated: logTruncated || diffs.some((item) => item.kept < item.raw.length),
	};
}

type AssembledDiff = { path: string; raw: string; kept: number };

function renderLog(raw: string, kept: number, truncated: boolean): string {
	if (!raw && !truncated) return "## 日志\n\n(missing)";
	if (!truncated && kept >= raw.length) return `## 日志\n\n${raw}`;
	const tail = kept <= 0 ? "" : raw.slice(-kept);
	return `## 日志\n\n[日志截断:只含尾部 ${Math.max(0, kept)} 字符]\n${tail}`;
}

function renderDiff(path: string, raw: string, kept: number): string {
	const header = `## git diff -- ${path}\n\n`;
	if (kept >= raw.length) return header + raw;
	const slice = kept <= 0 ? "" : raw.slice(0, kept);
	return `${header}${slice}\n[diff 截断: ${path} 只含前 ${Math.max(0, kept)} 字符,原长 ${raw.length}]`;
}

async function resolveBaseline(
	worktree: string,
	record: BgTaskRecord,
	gitRun: GitRead,
	gaps: string[],
): Promise<string | undefined> {
	const recorded = typeof record.worktreeBaseSha === "string" ? record.worktreeBaseSha.trim() : "";
	if (recorded) return recorded;
	for (const ref of ["main", "master"]) {
		try {
			const { stdout } = await gitRun(worktree, ["merge-base", "HEAD", ref]);
			const sha = stdout.trim();
			if (sha) {
				gaps.push(`基线 commit 取自 git merge-base HEAD ${ref}`);
				return sha;
			}
		} catch {
			/* try next ref */
		}
	}
	gaps.push("基线 commit 缺失,无法 diff");
	return undefined;
}

function gitVerb(args: readonly string[]): string {
	for (const arg of args) {
		if (!arg.startsWith("-")) return arg;
	}
	return "";
}

async function defaultGitRead(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
	const verb = gitVerb(args);
	if (!GIT_READ_VERBS.has(verb)) {
		throw new Error(`accept judge refused non-read git verb: ${verb || args.join(" ")}`);
	}
	const { stdout, stderr } = await execFileAsync("git", [...args], { cwd, timeout: GIT_READ_TIMEOUT_MS });
	return { stdout, stderr };
}

export function extractJudgeJson(raw: string): string | null {
	const fence = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i.exec(raw);
	const source = fence ? (fence[1] ?? "") : raw;
	const trimmed = source.trim();
	if (!trimmed) return null;
	const start = trimmed.startsWith("[") ? 0 : trimmed.indexOf("{");
	if (start < 0) return null;
	return sliceBalancedJson(trimmed, start);
}

function sliceBalancedJson(source: string, start: number): string | null {
	const opener = source[start];
	if (opener !== "{" && opener !== "[") return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < source.length; i++) {
		const char = source[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") {
			depth--;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	return null;
}

function parseJudgeVerdict(raw: string): {
	verdict: AcceptanceJudgeVerdict;
	reasons: string[];
	silences: string[];
	out_of_scope: string[];
	evidence_gaps: string[];
	confidence: AcceptanceJudgeConfidence;
} | null {
	const candidate = extractJudgeJson(raw);
	if (candidate === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(candidate);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const object = value as Record<string, unknown>;
	if (object.verdict !== "PASS" && object.verdict !== "FIX" && object.verdict !== "ESCALATE") return null;
	if (!isStringArray(object.reasons)) return null;
	if (!isStringArray(object.silences)) return null;
	if (!isStringArray(object.out_of_scope)) return null;
	if (!isStringArray(object.evidence_gaps)) return null;
	if (object.confidence !== "high" && object.confidence !== "low") return null;
	return {
		verdict: object.verdict,
		reasons: object.reasons,
		silences: object.silences,
		out_of_scope: object.out_of_scope,
		evidence_gaps: object.evidence_gaps,
		confidence: object.confidence,
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function unionGaps(fromModel: string[], structural: string[]): string[] {
	const out = [...fromModel];
	for (const gap of structural) {
		if (!out.includes(gap)) out.push(gap);
	}
	return out;
}

function previousFromExisting(text: string | undefined): AcceptanceJudgeDocument[] | undefined {
	if (text === undefined) return undefined;
	try {
		const value = JSON.parse(text) as AcceptanceJudgeDocument;
		if (!value || typeof value !== "object") return undefined;
		if (value.verdict !== "PASS" && value.verdict !== "FIX" && value.verdict !== "ESCALATE") return undefined;
		const { previous, ...rest } = value;
		return [rest, ...(Array.isArray(previous) ? previous : [])];
	} catch {
		return undefined;
	}
}

async function failJudge(opts: {
	error: string;
	log: (line: string) => void;
	sendTelegram?: (text: string) => Promise<void>;
}): Promise<AcceptanceJudgeResult> {
	const error = sanitizeFailure(opts.error);
	const line = `accept failed: ${error}`;
	opts.log(line);
	if (opts.sendTelegram) await opts.sendTelegram(line);
	return { ran: false, error };
}

function sanitizeFailure(raw: string): string {
	const redacted = redactSecrets(raw).replace(/https?:\/\/\S+/gi, "<redacted-url>");
	const collapsed = redacted.replace(/\s+/g, " ").trim() || "model call failed";
	return collapsed.slice(0, 200);
}

function acceptTimeoutError(timeoutMs: number): string {
	const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
	return `accept timed out after ${minutes}m`;
}

function timeoutRejection(signal: AbortSignal, timeoutMs: number): Promise<never> {
	return new Promise((_, reject) => {
		const fail = () => reject(new Error(acceptTimeoutError(timeoutMs)));
		if (signal.aborted) {
			fail();
			return;
		}
		signal.addEventListener("abort", fail, { once: true });
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
