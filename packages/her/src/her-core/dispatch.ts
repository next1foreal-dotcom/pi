import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { enforceDailyCostCap } from "./cost-ledger.ts";
import { completeLongTask, startLongTask } from "./long-task.ts";
import { Memory } from "./memory.ts";
import { git } from "./memory-utils.ts";
import { readText } from "./store.ts";

export type DispatchExecutorKind = "codex" | "pi";

export interface ParsedExecutor {
	kind: DispatchExecutorKind;
	model?: string;
	raw: string;
}

export interface DispatchOptions {
	budgetUsd?: number;
	cwd?: string;
	dailyCapUsd?: number;
	env?: NodeJS.ProcessEnv;
	executor: string;
	handoffPath: string;
	label?: string;
	memoryDir: string;
	now?: string;
	spawnExecutor?: SpawnExecutorFn;
	timeoutMin?: number;
}

export type DispatchStatus = "completed" | "completed-with-violations" | "rejected" | "timed-out" | "failed";

export interface DispatchExecutorResult {
	exitCode: number | null;
	prompt: string;
	stderr: string;
	stdout: string;
	timedOut: boolean;
	usd?: number;
}

export type SpawnExecutorFn = (opts: {
	cwd: string;
	env: NodeJS.ProcessEnv;
	executor: ParsedExecutor;
	handoffText: string;
	prompt: string;
	timeoutMs: number;
}) => Promise<DispatchExecutorResult>;

export interface DispatchResult {
	commits: number;
	dispatchId: string;
	durationMs: number;
	executor: string;
	filesChanged: number;
	handoffPath: string;
	status: DispatchStatus;
	usd?: number;
	violations: string[];
}

export interface DispatchAuditEntry {
	context?: Record<string, unknown>;
	cost?: { purpose?: string; usd: number };
	dispatchId: string;
	executor: string;
	handoff: string;
	status: DispatchStatus;
	tool: "her_dispatch";
	ts: string;
}

const DEFAULT_BUDGET_USD = 5;
const DEFAULT_DAILY_CAP_USD = 20;
const DEFAULT_TIMEOUT_MIN = 60;

const FORBIDDEN_PATH_PREFIXES = ["packages/coding-agent/", "narrative/facts.md"];
const FORBIDDEN_PATH_SEGMENTS = ["/her-memory/"];
const FORBIDDEN_ENV_PREFIX = ".env";

export const DISPATCH_GROUND_RULES = `你正在以受治理执行者身份处理一份 Her handoff 任务。铁律(违反=本次派工作废):
1. commit-not-push:每个任务单独 commit,不要 push。
2. 不碰 packages/coding-agent/**(pi core 零 diff)。
3. 不读不写不 echo 任何 .env* 文件。
4. 不碰 narrative/FACTS.md。
5. 不写入 her-memory 的内容(her-memory 是只读参照)。
以下是 handoff 原文,请照此执行：`;

export async function runDispatch(opts: DispatchOptions): Promise<DispatchResult> {
	const env = opts.env ?? process.env;
	const cwd = resolve(opts.cwd ?? process.cwd());
	const memoryDir = opts.memoryDir;
	const budgetUsd = opts.budgetUsd ?? DEFAULT_BUDGET_USD;
	const dailyCapUsd =
		opts.dailyCapUsd ?? parsePositiveEnvNumber(env.HER_DISPATCH_DAILY_CAP_USD) ?? DEFAULT_DAILY_CAP_USD;
	const timeoutMin = opts.timeoutMin ?? DEFAULT_TIMEOUT_MIN;
	const now = opts.now ?? new Date().toISOString();

	const handoffPath = resolve(opts.handoffPath);
	const handoffText = await readText(handoffPath);
	if (!handoffText || !handoffText.trim()) {
		throw new Error(`her dispatch: handoff file not found or empty: ${opts.handoffPath}`);
	}

	const executor = parseExecutor(opts.executor);

	const objective = firstNonBlankLine(handoffText) ?? `dispatch ${opts.executor}`;
	const task = await startLongTask(memoryDir, {
		now,
		objective,
		owner: "dispatch",
		source: opts.handoffPath,
	});
	const dispatchId = task.id;

	try {
		await enforceDailyCostCap(memoryDir, dailyCapUsd);
	} catch (error) {
		await completeLongTask(memoryDir, dispatchId, {
			now,
			outcome: `rejected: over-budget (${error instanceof Error ? error.message : String(error)})`,
		});
		await recordDispatchAudit(memoryDir, {
			dispatchId,
			executor: opts.executor,
			handoff: opts.handoffPath,
			status: "rejected",
			ts: now,
		});
		throw new Error(`her dispatch rejected: over-budget: ${error instanceof Error ? error.message : String(error)}`);
	}

	const baseline = await captureGitBaseline(cwd);
	const prompt = `${DISPATCH_GROUND_RULES}\n\n${handoffText.trim()}\n`;
	const spawnFn = opts.spawnExecutor ?? spawnRealExecutor;
	const timeoutMs = Math.max(1, Math.round(timeoutMin * 60_000));
	const started = Date.now();

	const execResult = await raceAgainstTimeout(
		spawnFn({ cwd, env, executor, handoffText, prompt, timeoutMs }),
		timeoutMs,
	);
	const durationMs = Date.now() - started;

	if (execResult.timedOut) {
		await completeLongTask(memoryDir, dispatchId, {
			now: new Date().toISOString(),
			outcome: `timed-out after ${timeoutMin}min`,
		});
		await recordDispatchAudit(memoryDir, {
			dispatchId,
			executor: opts.executor,
			handoff: opts.handoffPath,
			status: "timed-out",
			ts: new Date().toISOString(),
			...(execResult.usd !== undefined ? { cost: { usd: execResult.usd } } : {}),
		});
		await captureDispatchEpisode(memoryDir, {
			dispatchId,
			executor: opts.executor,
			handoffPath: opts.handoffPath,
			status: "timed-out",
			summary: `Dispatch timed out after ${timeoutMin} minutes.`,
		});
		return {
			commits: 0,
			dispatchId,
			durationMs,
			executor: opts.executor,
			filesChanged: 0,
			handoffPath: opts.handoffPath,
			status: "timed-out",
			violations: [],
			...(execResult.usd !== undefined ? { usd: execResult.usd } : {}),
		};
	}

	const { changedFiles, commits } = await diffAgainstBaseline(cwd, baseline.headSha);
	const violations = detectViolations(changedFiles);
	const pushed = await remoteAdvanced(cwd, baseline.upstreamSha);
	if (pushed) violations.push("remote tracking ref advanced (executor pushed)");
	if (execResult.usd !== undefined && execResult.usd > budgetUsd) {
		violations.push(`actual cost $${execResult.usd} exceeded --budget-usd $${budgetUsd}`);
	}

	const status: DispatchStatus = violations.length > 0 ? "completed-with-violations" : "completed";
	const outcome = renderOutcome(status, {
		commits,
		durationMs,
		filesChanged: changedFiles.length,
		usd: execResult.usd,
		violations,
	});

	await completeLongTask(memoryDir, dispatchId, { now: new Date().toISOString(), outcome });
	await recordDispatchAudit(memoryDir, {
		dispatchId,
		executor: opts.executor,
		handoff: opts.handoffPath,
		status,
		ts: new Date().toISOString(),
		...(execResult.usd !== undefined
			? { cost: { usd: execResult.usd } }
			: executor.kind === "codex"
				? { cost: { usd: 0, purpose: "codex-untracked" } }
				: {}),
	});
	await captureDispatchEpisode(memoryDir, {
		dispatchId,
		executor: opts.executor,
		handoffPath: opts.handoffPath,
		status,
		summary: `Dispatched ${opts.executor} for ${opts.handoffPath}. Result: ${status}. ${commits} commit(s), ${changedFiles.length} file(s) changed.${violations.length ? ` Violations: ${violations.join("; ")}.` : ""}`,
	});

	return {
		commits,
		dispatchId,
		durationMs,
		executor: opts.executor,
		filesChanged: changedFiles.length,
		handoffPath: opts.handoffPath,
		status,
		violations,
		...(execResult.usd !== undefined ? { usd: execResult.usd } : {}),
	};
}

export function parseExecutor(raw: string): ParsedExecutor {
	if (raw === "codex") return { kind: "codex", raw };
	if (raw.startsWith("pi:")) {
		const model = raw.slice(3).trim();
		if (!model) throw new Error(`her dispatch: unknown executor: ${raw}`);
		if (!MODEL_TO_PI[model]) throw new Error(`her dispatch: unknown executor: ${raw}`);
		return { kind: "pi", model, raw };
	}
	throw new Error(`her dispatch: unknown executor: ${raw}`);
}

const MODEL_TO_PI: Record<string, { model: string; provider: string }> = {
	deepseek: { model: "deepseek-v4-pro", provider: "deepseek" },
};

async function spawnRealExecutor(opts: {
	cwd: string;
	env: NodeJS.ProcessEnv;
	executor: ParsedExecutor;
	handoffText: string;
	prompt: string;
	timeoutMs: number;
}): Promise<DispatchExecutorResult> {
	if (opts.executor.kind === "pi") {
		const mapping = MODEL_TO_PI[opts.executor.model ?? ""];
		if (!mapping) throw new Error(`her dispatch: unknown executor: pi:${opts.executor.model}`);
		const cli = resolve(opts.cwd, "packages", "coding-agent", "dist", "cli.js");
		return runSpawn(
			process.execPath,
			[cli, "--print", "--mode", "json", "--provider", mapping.provider, "--model", mapping.model, opts.prompt],
			opts,
		);
	}
	return runSpawn("codex", ["exec", "-s", "workspace-write", "--cd", opts.cwd, "-"], opts, opts.prompt);
}

function runSpawn(
	command: string,
	args: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
	stdin?: string,
): Promise<DispatchExecutorResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, opts.timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({
				exitCode: code,
				prompt: stdin ?? "",
				stderr,
				stdout,
				timedOut,
				usd: estimateUsdFromNdjson(stdout),
			});
		});
		if (stdin !== undefined) {
			child.stdin.end(stdin);
		} else {
			child.stdin.end();
		}
	});
}

function raceAgainstTimeout(
	pending: Promise<DispatchExecutorResult>,
	timeoutMs: number,
): Promise<DispatchExecutorResult> {
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolvePromise({ exitCode: null, prompt: "", stderr: "", stdout: "", timedOut: true });
		}, timeoutMs);
		pending.then(
			(result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolvePromise(result);
			},
			(error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function estimateUsdFromNdjson(stdout: string): number | undefined {
	let totalTokens = 0;
	let found = false;
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as { usage?: { output_tokens?: number; input_tokens?: number } };
			if (parsed.usage) {
				found = true;
				totalTokens += (parsed.usage.output_tokens ?? 0) + (parsed.usage.input_tokens ?? 0);
			}
		} catch {
			// non-JSON lines are expected in NDJSON streams (progress text); ignore.
		}
	}
	if (!found) return undefined;
	// ponytail: cheap $/token estimate until real per-model pricing is wired; swap when it drifts.
	return Math.round(totalTokens * 0.000002 * 1_000_000) / 1_000_000;
}

async function captureGitBaseline(cwd: string): Promise<{ headSha: string; upstreamSha: string | null }> {
	const headSha = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
	const upstreamSha = await git(cwd, "rev-parse", "@{u}")
		.then((result) => result.stdout.trim() || null)
		.catch(() => null);
	return { headSha, upstreamSha };
}

async function diffAgainstBaseline(
	cwd: string,
	baselineSha: string,
): Promise<{ changedFiles: string[]; commits: number }> {
	const changed = await git(cwd, "diff", "--name-only", `${baselineSha}..HEAD`)
		.then((result) => result.stdout.split(/\r?\n/).filter((line) => line.trim()))
		.catch(() => []);
	const commits = await git(cwd, "rev-list", "--count", `${baselineSha}..HEAD`)
		.then((result) => Number(result.stdout.trim()) || 0)
		.catch(() => 0);
	return { changedFiles: changed, commits };
}

async function remoteAdvanced(cwd: string, baselineUpstreamSha: string | null): Promise<boolean> {
	if (baselineUpstreamSha === null) return false;
	const currentUpstreamSha = await git(cwd, "rev-parse", "@{u}")
		.then((result) => result.stdout.trim() || null)
		.catch(() => null);
	if (currentUpstreamSha === null) return false;
	return currentUpstreamSha !== baselineUpstreamSha;
}

export function normalizeDispatchPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "")
		.toLowerCase();
}

function detectViolations(changedFiles: string[]): string[] {
	const violations: string[] = [];
	for (const file of changedFiles) {
		const normalized = normalizeDispatchPath(file);
		const hitsPrefix = FORBIDDEN_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
		const hitsSegment = FORBIDDEN_PATH_SEGMENTS.some((segment) => `/${normalized}`.includes(segment));
		const hitsEnv = normalized.split("/").pop()?.startsWith(FORBIDDEN_ENV_PREFIX) ?? false;
		if (hitsPrefix || hitsSegment || hitsEnv) violations.push(file);
	}
	return violations;
}

function renderOutcome(
	status: DispatchStatus,
	fields: { commits: number; durationMs: number; filesChanged: number; usd?: number; violations: string[] },
): string {
	const parts = [
		`status: ${status}`,
		`commits: ${fields.commits}`,
		`files changed: ${fields.filesChanged}`,
		`duration_ms: ${fields.durationMs}`,
	];
	if (fields.usd !== undefined) parts.push(`usd: ${fields.usd}`);
	if (fields.violations.length > 0) parts.push(`violations: ${fields.violations.join(", ")}`);
	return parts.join(" | ");
}

async function captureDispatchEpisode(
	memoryDir: string,
	opts: { dispatchId: string; executor: string; handoffPath: string; status: DispatchStatus; summary: string },
): Promise<void> {
	const memory = new Memory(memoryDir);
	await memory.capture(opts.summary, {
		dispatchId: opts.dispatchId,
		executor: opts.executor,
		handoff: opts.handoffPath,
		project: "her-dispatch",
		provenance: "her-observed",
	});
}

async function recordDispatchAudit(
	memoryDir: string,
	opts: {
		cost?: { purpose?: string; usd: number };
		dispatchId: string;
		executor: string;
		handoff: string;
		status: DispatchStatus;
		ts: string;
	},
): Promise<DispatchAuditEntry> {
	const entry: DispatchAuditEntry = {
		dispatchId: opts.dispatchId,
		executor: opts.executor,
		handoff: opts.handoff,
		status: opts.status,
		tool: "her_dispatch",
		ts: opts.ts,
		...(opts.cost ? { cost: opts.cost } : {}),
	};
	const auditDir = join(memoryDir, "audit");
	const auditFile = join(auditDir, `${opts.ts.slice(0, 10)}.jsonl`);
	await mkdir(auditDir, { recursive: true });
	await appendFile(auditFile, `${JSON.stringify(entry)}\n`, "utf8");
	return entry;
}

function firstNonBlankLine(text: string): string | undefined {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim().replace(/^#+\s*/, "");
		if (trimmed) return trimmed;
	}
	return undefined;
}

function parsePositiveEnvNumber(value: string | undefined): number | undefined {
	if (!value?.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
