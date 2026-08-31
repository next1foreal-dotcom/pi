import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, readdir, rm, rmdir, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enforceDailyCostCap } from "./cost-ledger.ts";
import { completeLongTask, startLongTask } from "./long-task.ts";
import { Memory } from "./memory.ts";
import { git } from "./memory-utils.ts";
import { readText } from "./store.ts";
import { storeLock } from "./store-lock.ts";

// dispatch.ts lives at packages/her/src/her-core/dispatch.ts; the pi CLI lives at
// packages/coding-agent/dist/cli.js in the same monorepo checkout. Anchor to this
// file's own location (not the executor's --cwd, which may be a different repo).
const SAMANTHA_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

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
	maxCodexRunsPerDay?: number;
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
	branch?: string;
	commits: number;
	dispatchId: string;
	durationMs: number;
	executor: string;
	filesChanged: number;
	handoffPath: string;
	status: DispatchStatus;
	usd?: number;
	violations: string[];
	worktreePath?: string;
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
const DEFAULT_CODEX_USD_ESTIMATE = 0.5;
const DEFAULT_MAX_CODEX_RUNS_PER_DAY = 10;
const DEFAULT_COMPLETION_LOCK_TIMEOUT_MS = 20_000;
const DEFAULT_COMPLETION_LOCK_RETRIES = 3;
const WINDOWS_CODEX_COMMANDS = ["codex.cmd", "codex.exe", "codex"] as const;

type CodexCommandName = (typeof WINDOWS_CODEX_COMMANDS)[number];
type CodexCommandProbe = Record<CodexCommandName, string | boolean>;

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
	const maxCodexRunsPerDay =
		opts.maxCodexRunsPerDay ??
		parsePositiveEnvInt(env.HER_DISPATCH_MAX_CODEX_RUNS_PER_DAY) ??
		DEFAULT_MAX_CODEX_RUNS_PER_DAY;
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
		if (executor.kind === "codex") await enforceDailyCodexRunCap(memoryDir, maxCodexRunsPerDay);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		await completeDispatchWithLock(memoryDir, env, async () => {
			await completeLongTask(memoryDir, dispatchId, {
				now,
				outcome: `rejected: over-budget (${reason})`,
			});
			await captureDispatchEpisode(memoryDir, {
				dispatchId,
				executor: opts.executor,
				handoffPath: opts.handoffPath,
				status: "rejected",
				summary: `Dispatch rejected for ${opts.executor} on ${opts.handoffPath}: over-budget: ${reason}`,
			});
		});
		await recordDispatchAudit(memoryDir, {
			dispatchId,
			executor: opts.executor,
			handoff: opts.handoffPath,
			status: "rejected",
			ts: now,
		});
		throw new Error(`her dispatch rejected: over-budget: ${reason}`);
	}

	const prompt = `${DISPATCH_GROUND_RULES}\n\n${handoffText.trim()}\n`;
	const spawnFn = opts.spawnExecutor ?? spawnRealExecutor;
	const timeoutMs = Math.max(1, Math.round(timeoutMin * 60_000));
	const started = Date.now();

	let worktree: DispatchWorktree;
	let execResult: DispatchExecutorResult;
	try {
		worktree = await createDispatchWorktree(cwd, env, dispatchId);
		execResult = await raceAgainstTimeout(
			spawnFn({ cwd: worktree.worktreePath, env, executor, handoffText, prompt, timeoutMs }),
			timeoutMs,
		);
	} catch (error) {
		const durationMs = Date.now() - started;
		const failedAt = new Date().toISOString();
		const reason = error instanceof Error ? error.message : String(error);
		const cost = resolveDispatchCost(executor, undefined, env);
		await completeDispatchWithLock(memoryDir, env, async () => {
			await completeLongTask(memoryDir, dispatchId, { now: failedAt, outcome: `failed: ${reason}` });
			await captureDispatchEpisode(memoryDir, {
				dispatchId,
				executor: opts.executor,
				handoffPath: opts.handoffPath,
				status: "failed",
				summary: `Dispatch failed for ${opts.executor} on ${opts.handoffPath}: ${reason}`,
			});
		});
		await recordDispatchAudit(memoryDir, {
			dispatchId,
			executor: opts.executor,
			handoff: opts.handoffPath,
			status: "failed",
			ts: failedAt,
			...(cost ? { cost } : {}),
		});
		return {
			commits: 0,
			dispatchId,
			durationMs,
			executor: opts.executor,
			filesChanged: 0,
			handoffPath: opts.handoffPath,
			status: "failed",
			violations: [],
			...(cost ? { usd: cost.usd } : {}),
		};
	}
	const durationMs = Date.now() - started;

	if (execResult.timedOut) {
		const cost = resolveDispatchCost(executor, execResult.usd, env);
		await completeDispatchWithLock(memoryDir, env, async () => {
			await completeLongTask(memoryDir, dispatchId, {
				now: new Date().toISOString(),
				outcome: `timed-out after ${timeoutMin}min`,
			});
			await captureDispatchEpisode(memoryDir, {
				dispatchId,
				executor: opts.executor,
				handoffPath: opts.handoffPath,
				status: "timed-out",
				summary: `Dispatch timed out after ${timeoutMin} minutes.`,
			});
		});
		await recordDispatchAudit(memoryDir, {
			dispatchId,
			executor: opts.executor,
			handoff: opts.handoffPath,
			status: "timed-out",
			ts: new Date().toISOString(),
			...(cost ? { cost } : {}),
		});
		return {
			branch: worktree.branch,
			commits: 0,
			dispatchId,
			durationMs,
			executor: opts.executor,
			filesChanged: 0,
			handoffPath: opts.handoffPath,
			status: "timed-out",
			violations: [],
			worktreePath: worktree.worktreePath,
			...(cost ? { usd: cost.usd } : {}),
		};
	}

	const { changedFiles, commits } = await diffAgainstBaseline(worktree.worktreePath, worktree.headSha);
	const violations = detectViolations(changedFiles);
	const pushed = await remoteAdvanced(worktree.worktreePath, worktree.remoteRefs);
	if (pushed) violations.push("remote ref changed (executor pushed)");
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
	const cost = resolveDispatchCost(executor, execResult.usd, env);
	// A true no-op run (nothing committed, nothing to flag) is the only case the dispatch body
	// cleans up itself; any commit or violation leaves the branch/worktree for the acceptor.
	const isNoOp = commits === 0 && violations.length === 0;
	if (isNoOp) await removeDispatchWorktree(cwd, worktree);

	await completeDispatchWithLock(memoryDir, env, async () => {
		await completeLongTask(memoryDir, dispatchId, { now: new Date().toISOString(), outcome });
		await captureDispatchEpisode(memoryDir, {
			dispatchId,
			executor: opts.executor,
			handoffPath: opts.handoffPath,
			status,
			summary: `Dispatched ${opts.executor} for ${opts.handoffPath}. Result: ${status}. ${commits} commit(s), ${changedFiles.length} file(s) changed.${violations.length ? ` Violations: ${violations.join("; ")}.` : ""}`,
		});
	});
	await recordDispatchAudit(memoryDir, {
		dispatchId,
		executor: opts.executor,
		handoff: opts.handoffPath,
		status,
		ts: new Date().toISOString(),
		...(cost ? { cost } : {}),
	});

	return {
		...(isNoOp ? {} : { branch: worktree.branch, worktreePath: worktree.worktreePath }),
		commits,
		dispatchId,
		durationMs,
		executor: opts.executor,
		filesChanged: changedFiles.length,
		handoffPath: opts.handoffPath,
		status,
		violations,
		...(cost ? { usd: cost.usd } : {}),
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

export function resolvePiCliPath(env: NodeJS.ProcessEnv): string {
	const override = env.HER_DISPATCH_PI_CLI?.trim();
	const resolved = override
		? resolve(SAMANTHA_REPO_ROOT, override)
		: join(SAMANTHA_REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
	if (override && !isInsideSamanthaRepo(resolved)) {
		throw new Error(`her dispatch: HER_DISPATCH_PI_CLI outside samantha repo: ${override}`);
	}
	return resolved;
}

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
		const cli = resolvePiCliPath(opts.env);
		return runSpawn(
			process.execPath,
			[cli, "--print", "--mode", "json", "--provider", mapping.provider, "--model", mapping.model, opts.prompt],
			opts,
		);
	}
	const plan = resolveCodexSpawnPlan(opts.env, opts.cwd);
	return runSpawn(plan.command, plan.args, opts, opts.prompt);
}

export interface CodexSpawnPlan {
	args: string[];
	command: string;
}

export function selectCodexCommand(platform: NodeJS.Platform, probe: CodexCommandProbe): CodexCommandName {
	if (platform !== "win32") return "codex";
	for (const command of WINDOWS_CODEX_COMMANDS) {
		if (probe[command]) return command;
	}
	return "codex.cmd";
}

export function selectCodexSpawnPlan(
	platform: NodeJS.Platform,
	probe: CodexCommandProbe,
	cwd: string,
	nodePath = process.execPath,
	pathExists: (path: string) => boolean = existsSync,
): CodexSpawnPlan {
	const command = selectCodexCommand(platform, probe);
	const args = ["exec", "-s", "workspace-write", "--cd", cwd, "-"];
	if (platform === "win32" && command === "codex.cmd") {
		const shimDir = probe["codex.cmd"];
		if (typeof shimDir === "string") {
			const codexJs = join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js");
			if (pathExists(codexJs)) return { command: nodePath, args: [codexJs, ...args] };
		}
		return {
			command: "cmd.exe",
			args: ["/d", "/s", "/c", "codex", "exec", "-s", "workspace-write", "--cd", ".", "-"],
		};
	}
	return { command, args };
}

function resolveCodexSpawnPlan(env: NodeJS.ProcessEnv, cwd: string): CodexSpawnPlan {
	const pathValue = env.PATH ?? env.Path ?? env.path;
	return selectCodexSpawnPlan(process.platform, probeCodexCommands(pathValue), cwd);
}

function probeCodexCommands(pathValue: string | undefined): CodexCommandProbe {
	const probe: CodexCommandProbe = { "codex.cmd": false, "codex.exe": false, codex: false };
	if (!pathValue) return probe;
	for (const rawDir of pathValue.split(delimiter)) {
		const dir = rawDir.trim().replace(/^"|"$/g, "");
		if (!dir) continue;
		for (const command of WINDOWS_CODEX_COMMANDS) {
			if (!probe[command] && existsSync(join(dir, command))) probe[command] = dir;
		}
	}
	return probe;
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
			killTimedOutChild(child.pid, child.kill.bind(child));
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

interface PiNdjsonUsage {
	cost?: { total?: number };
	input?: number;
	output?: number;
	output_tokens?: number;
	input_tokens?: number;
}

export function estimateUsdFromNdjson(stdout: string): number | undefined {
	let lastCostTotal: number | undefined;
	let totalTokens = 0;
	let sawTokensWithoutCost = false;
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed: { message?: { usage?: PiNdjsonUsage }; usage?: PiNdjsonUsage };
		try {
			parsed = JSON.parse(line);
		} catch {
			// non-JSON lines are expected in NDJSON streams (progress text); ignore.
			continue;
		}
		const usage = parsed.message?.usage ?? parsed.usage;
		if (!usage) continue;
		if (typeof usage.cost?.total === "number") {
			// pi reports a running total per event; the last one is the settled turn cost.
			lastCostTotal = usage.cost.total;
			continue;
		}
		const tokens = (usage.output_tokens ?? usage.output ?? 0) + (usage.input_tokens ?? usage.input ?? 0);
		if (tokens > 0) {
			totalTokens = tokens;
			sawTokensWithoutCost = true;
		}
	}
	if (lastCostTotal !== undefined) return Math.round(lastCostTotal * 1_000_000) / 1_000_000;
	if (!sawTokensWithoutCost) return undefined;
	// ponytail: cheap $/token estimate for providers that report tokens but no cost; swap when it drifts.
	return Math.round(totalTokens * 0.000002 * 1_000_000) / 1_000_000;
}

interface DispatchWorktree {
	branch: string;
	headSha: string;
	remoteRefs: string[];
	worktreePath: string;
}

function dispatchWorktreeRoot(env: NodeJS.ProcessEnv): string {
	return env.HER_DISPATCH_WORKTREE_ROOT?.trim() || join(tmpdir(), "her-dispatch-worktrees");
}

/**
 * Creates an isolated `dispatch/<id>` branch and worktree off the target repo's current HEAD.
 * Every concurrent dispatch gets its own working tree and branch, so one dispatch's commits can
 * never leak into another's violation diff (they physically aren't in the same working tree).
 * The dispatch body never merges this branch back — that is always the acceptor's action.
 */
async function createDispatchWorktree(
	cwd: string,
	env: NodeJS.ProcessEnv,
	dispatchId: string,
): Promise<DispatchWorktree> {
	const headSha = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
	const remoteRefs = await captureRemoteRefs(cwd);
	const worktreePath = resolve(dispatchWorktreeRoot(env), dispatchId);
	const branch = `dispatch/${dispatchId}`;
	await mkdir(dirname(worktreePath), { recursive: true });
	await git(cwd, "worktree", "add", worktreePath, "-b", branch, "HEAD");
	await junctionNodeModules(worktreePath, dispatchNodeModulesSource(env));
	return { branch, headSha, remoteRefs, worktreePath };
}

/**
 * Removes a dispatch worktree and its branch. Only called by the dispatch body itself when the
 * run produced zero commits and zero violations (a true no-op) — any other outcome leaves the
 * worktree and branch in place for the acceptor to merge/cherry-pick and clean up.
 */
async function removeDispatchWorktree(cwd: string, worktree: DispatchWorktree): Promise<void> {
	const warnings: string[] = [];
	const worktreePath = worktree.worktreePath;
	try {
		await unlinkJunction(join(worktreePath, "node_modules"));
	} catch (error) {
		if (!isMissing(error)) warnings.push(`unlink-junction: ${errorMessage(error)}`);
	}
	try {
		for (const leftover of await scanJunctions(worktreePath)) {
			try {
				await unlinkJunction(leftover);
			} catch (error) {
				if (!isMissing(error)) warnings.push(`scan-unlink ${leftover}: ${errorMessage(error)}`);
			}
		}
	} catch (error) {
		if (!isMissing(error)) warnings.push(`scan-junctions: ${errorMessage(error)}`);
	}
	try {
		await git(cwd, "worktree", "remove", worktreePath, "--force");
	} catch (error) {
		if (!isMissing(error)) warnings.push(`worktree-remove: ${errorMessage(error)}`);
	}
	try {
		await rm(worktreePath, { force: true, recursive: true });
	} catch (error) {
		if (!isMissing(error)) warnings.push(`remove-tree: ${errorMessage(error)}`);
	}
	try {
		await git(cwd, "branch", "-D", worktree.branch);
	} catch (error) {
		const message = errorMessage(error);
		if (!isMissingBranchError(message)) warnings.push(`delete-branch: ${message}`);
	}
	if (warnings.length > 0) console.error(`[her] dispatch worktree teardown failed: ${warnings.join("; ")}`);
}

function dispatchNodeModulesSource(env: NodeJS.ProcessEnv): string | undefined {
	const override = env.HER_DISPATCH_NODE_MODULES?.trim();
	if (override) return override;
	// Tests must opt in via HER_DISPATCH_NODE_MODULES so leftover worktrees never junction
	// the live samantha node_modules (G-357: git worktree remove --force follows junctions).
	if (env.NODE_TEST_CONTEXT) return undefined;
	return join(SAMANTHA_REPO_ROOT, "node_modules");
}

async function junctionNodeModules(worktreePath: string, source: string | undefined): Promise<void> {
	if (!source) return;
	const dest = join(worktreePath, "node_modules");
	if (!(await pathExists(source)) || (await pathExists(dest))) return;
	const type = process.platform === "win32" ? "junction" : "dir";
	await symlink(source, dest, type);
}

async function unlinkJunction(path: string): Promise<void> {
	try {
		await rmdir(path);
	} catch (error) {
		if (isMissing(error)) return;
		await unlink(path);
	}
}

async function scanJunctions(root: string): Promise<string[]> {
	const found: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) break;
		let entries: Array<{ isDirectory(): boolean; isSymbolicLink(): boolean; name: string }>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const child = join(dir, entry.name);
			if (entry.isSymbolicLink() || (await isReparseDir(child))) {
				found.push(child);
				continue;
			}
			if (entry.isDirectory()) stack.push(child);
		}
	}
	return found;
}

async function isReparseDir(path: string): Promise<boolean> {
	try {
		const info = await lstat(path);
		return info.isSymbolicLink();
	} catch {
		return false;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

function isMissing(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT",
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingBranchError(message: string): boolean {
	return /not found|unknown branch|doesn't exist/i.test(message);
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

async function remoteAdvanced(cwd: string, baselineRemoteRefs: string[]): Promise<boolean> {
	const currentRemoteRefs = await captureRemoteRefs(cwd);
	if (currentRemoteRefs.length !== baselineRemoteRefs.length) return true;
	const baseline = new Set(baselineRemoteRefs);
	return currentRemoteRefs.some((ref) => !baseline.has(ref));
}

async function captureRemoteRefs(cwd: string): Promise<string[]> {
	return git(cwd, "for-each-ref", "refs/remotes", "--format=%(refname) %(objectname)")
		.then((result) => result.stdout.split(/\r?\n/).filter((line) => line.trim()))
		.catch(() => []);
}

export function normalizeDispatchPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "")
		.toLowerCase();
}

function isInsideSamanthaRepo(path: string): boolean {
	const root = normalizeDispatchPath(SAMANTHA_REPO_ROOT).replace(/\/+$/, "");
	const target = normalizeDispatchPath(path);
	return target === root || target.startsWith(`${root}/`);
}

export function timeoutKillPlan(
	platform: NodeJS.Platform,
	pid: number,
): { args: string[]; command: string } | undefined {
	if (platform !== "win32") return undefined;
	return { command: "taskkill", args: ["/pid", String(pid), "/T", "/F"] };
}

function killTimedOutChild(pid: number | undefined, fallbackKill: () => boolean): void {
	if (pid !== undefined) {
		const plan = timeoutKillPlan(process.platform, pid);
		if (plan) {
			try {
				spawn(plan.command, plan.args, { stdio: "ignore", windowsHide: true }).unref();
				return;
			} catch {
				// fall through to the direct child kill.
			}
		}
	}
	fallbackKill();
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

/**
 * Runs the goal-file completion + episodic capture as one store-locked unit, retrying on lock
 * contention instead of dying on the first timeout. Each attempt gets a short lock timeout
 * (default 20s); up to `retries` attempts are made (default 3) before failing loud.
 */
async function completeDispatchWithLock(
	memoryDir: string,
	env: NodeJS.ProcessEnv,
	fn: () => Promise<void>,
): Promise<void> {
	const timeoutMs =
		parsePositiveEnvInt(env.HER_DISPATCH_COMPLETION_LOCK_TIMEOUT_MS) ?? DEFAULT_COMPLETION_LOCK_TIMEOUT_MS;
	const retries = parsePositiveEnvInt(env.HER_DISPATCH_COMPLETION_LOCK_RETRIES) ?? DEFAULT_COMPLETION_LOCK_RETRIES;
	let lastError: unknown;
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			await storeLock(memoryDir, fn, { timeoutMs });
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

function parsePositiveEnvInt(value: string | undefined): number | undefined {
	if (!value?.trim()) return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Every codex terminal state (completed / failed / timed-out) must leave a cost entry so the
 * daily cost cap can see the main executor. estimateUsdFromNdjson (the real pi accounting path)
 * is untouched: when it produced a number, that number is trusted as-is. Codex output isn't
 * NDJSON, so its usd is never parsed here — codex always falls back to the conservative estimate
 * and is labeled "codex-estimated" so the ledger is honest about what's measured vs. guessed.
 */
function resolveDispatchCost(
	executor: ParsedExecutor,
	usd: number | undefined,
	env: NodeJS.ProcessEnv,
): { purpose?: string; usd: number } | undefined {
	if (usd !== undefined) return { usd };
	if (executor.kind !== "codex") return undefined;
	const estimate = parsePositiveEnvNumber(env.HER_CODEX_USD_ESTIMATE) ?? DEFAULT_CODEX_USD_ESTIMATE;
	return { purpose: "codex-estimated", usd: estimate };
}

async function enforceDailyCodexRunCap(memoryDir: string, limit: number, date = today()): Promise<void> {
	const auditDir = join(memoryDir, "audit");
	const auditFile = join(auditDir, `${date}.jsonl`);
	const text = (await readText(auditFile)) ?? "";
	let runs = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parsed = JSON.parse(line) as { executor?: string; tool?: string };
		if (parsed.tool === "her_dispatch" && parsed.executor === "codex") runs += 1;
	}
	if (runs >= limit) throw new Error(`daily codex dispatch run cap reached: ${runs} >= ${limit}`);
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}
