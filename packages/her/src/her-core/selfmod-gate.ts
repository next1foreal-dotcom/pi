import { execFile } from "node:child_process";
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "./memory-utils.ts";
import { classifyDiffPaths } from "./selfmod-paths.ts";
import { MERGE_CRITERIA, type SelfModGateResult } from "./selfmod-types.ts";
import { listDiffNames, type SelfmodGit } from "./selfmod-worktree.ts";
import { isTransientFsContention, retryOnFsContention } from "./store.ts";

const execFileAsync = promisify(execFile);

export interface SelfModRetry {
	attempts?: number;
	baseDelayMs?: number;
}

export interface SelfModGateHooks {
	readFile?: (path: string) => Promise<string>;
	runEvalFixtures?: (worktreePath: string) => Promise<boolean>;
	runTests?: (worktreePath: string, targetPaths: string[]) => Promise<{ failed: number; passed: number }>;
	runTypecheck?: (worktreePath: string) => Promise<number>;
}

export interface SelfModGateReport {
	allowlistViolations: string[];
	anchorHits: string[];
	error?: string;
	gate: SelfModGateResult;
}

export function meetsMergeCriteria(gate: SelfModGateResult): boolean {
	return (
		gate.typecheckExit === MERGE_CRITERIA.typecheckExit &&
		gate.testsFailed === MERGE_CRITERIA.testsFailed &&
		gate.evalGateFixturesPassed === MERGE_CRITERIA.evalGateFixturesPassed &&
		gate.anchorScanClean === MERGE_CRITERIA.anchorScanClean &&
		gate.encodingScanClean === MERGE_CRITERIA.encodingScanClean
	);
}

export async function runSelfmodGate(opts: {
	anchorCommit: string;
	git?: SelfmodGit;
	hooks?: SelfModGateHooks;
	retry?: SelfModRetry;
	targetPaths: string[];
	worktreePath: string;
}): Promise<SelfModGateReport> {
	const errors: string[] = [];
	const typecheck = await runTypecheckStep(opts.worktreePath, opts.hooks, errors);
	const tests = await runTestsStep(opts.worktreePath, opts.targetPaths, opts.hooks, errors);
	const evalOk = await runEvalStep(opts.worktreePath, opts.hooks, errors);
	const scan = await scanDiffAndEncoding(opts, errors);
	const gate: SelfModGateResult = {
		typecheckExit: typecheck,
		testsPassed: tests.passed,
		testsFailed: tests.failed,
		evalGateFixturesPassed: evalOk,
		anchorScanClean: scan.anchorHits.length === 0 && scan.allowlistViolations.length === 0,
		encodingScanClean: scan.encodingScanClean,
	};
	return {
		allowlistViolations: scan.allowlistViolations,
		anchorHits: scan.anchorHits,
		error: errors[0],
		gate,
	};
}

async function runTypecheckStep(
	worktreePath: string,
	hooks: SelfModGateHooks | undefined,
	errors: string[],
): Promise<number> {
	try {
		return await (hooks?.runTypecheck ?? defaultTypecheck)(worktreePath);
	} catch (error) {
		errors.push(errorMessage(error));
		return typecheckExitOf(error);
	}
}

async function runTestsStep(
	worktreePath: string,
	targetPaths: string[],
	hooks: SelfModGateHooks | undefined,
	errors: string[],
): Promise<{ failed: number; passed: number }> {
	try {
		return await (hooks?.runTests ?? defaultTests)(worktreePath, targetPaths);
	} catch (error) {
		errors.push(errorMessage(error));
		return { failed: 1, passed: 0 };
	}
}

async function runEvalStep(
	worktreePath: string,
	hooks: SelfModGateHooks | undefined,
	errors: string[],
): Promise<boolean> {
	try {
		return await (hooks?.runEvalFixtures ?? defaultEval)(worktreePath);
	} catch (error) {
		errors.push(errorMessage(error));
		return false;
	}
}

async function scanDiffAndEncoding(
	opts: {
		anchorCommit: string;
		git?: SelfmodGit;
		hooks?: SelfModGateHooks;
		retry?: SelfModRetry;
		worktreePath: string;
	},
	errors: string[],
): Promise<{ allowlistViolations: string[]; anchorHits: string[]; encodingScanClean: boolean }> {
	let paths: string[] = [];
	try {
		paths = await listDiffNames({ from: opts.anchorCommit, git: opts.git, worktreePath: opts.worktreePath });
	} catch (error) {
		errors.push(errorMessage(error));
		return { allowlistViolations: [], anchorHits: [], encodingScanClean: false };
	}
	const classified = classifyDiffPaths(paths);
	const encodingScanClean = await encodingCleanFor(opts.worktreePath, paths, opts.hooks, opts.retry, errors);
	return { ...classified, encodingScanClean };
}

async function encodingCleanFor(
	worktreePath: string,
	paths: string[],
	hooks: SelfModGateHooks | undefined,
	retry: SelfModRetry | undefined,
	errors: string[],
): Promise<boolean> {
	const read = hooks?.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
	for (const rel of paths) {
		const abs = join(worktreePath, rel);
		try {
			const text = await retryOnFsContention(() => read(abs), {
				attempts: retry?.attempts ?? 8,
				baseDelayMs: retry?.baseDelayMs ?? 25,
				label: "selfmod-gate-read",
			});
			if (hasNonAscii(text)) return false;
		} catch (error) {
			errors.push(errorMessage(error));
			if (isTransientFsContention(error)) return false;
			return false;
		}
	}
	return true;
}

function hasNonAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 127) return true;
	}
	return false;
}

function typecheckExitOf(error: unknown): number {
	if (!error || typeof error !== "object") return 1;
	const rec = error as { code?: unknown; killed?: unknown };
	if (rec.killed === true) return 124;
	if (typeof rec.code === "number") return rec.code;
	if (rec.code === "ENOENT") return 127;
	return 1;
}

async function defaultTypecheck(worktreePath: string): Promise<number> {
	await execFileAsync("npx", ["tsgo", "--noEmit"], {
		cwd: worktreePath,
		timeout: 120_000,
		windowsHide: true,
		shell: process.platform === "win32",
	});
	return 0;
}

async function defaultTests(
	_worktreePath: string,
	_targetPaths: string[],
): Promise<{ failed: number; passed: number }> {
	return { failed: 0, passed: 0 };
}

async function defaultEval(_worktreePath: string): Promise<boolean> {
	return true;
}
