import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage } from "./memory-utils.ts";
import { classifyDiffPaths } from "./selfmod-paths.ts";
import type { SelfModEvalContext } from "./selfmod-runners.ts";
import { MERGE_CRITERIA, type SelfModGateResult, type SelfModProposal } from "./selfmod-types.ts";
import { listDiffNames, readPathDiff, type SelfmodGit } from "./selfmod-worktree.ts";
import { isTransientFsContention, retryOnFsContention } from "./store.ts";

const execFileAsync = promisify(execFile);

const CODE_EXTS = new Set([".ts", ".mts", ".cts", ".mjs", ".cjs", ".js", ".ps1", ".psm1", ".cedar", ".json"]);

export interface SelfModRetry {
	attempts?: number;
	baseDelayMs?: number;
}

export interface SelfModGateHooks {
	readDiff?: (path: string) => Promise<string>;
	runEvalFixtures?: (worktreePath: string, ctx?: SelfModEvalContext) => Promise<boolean>;
	runTests?: (worktreePath: string, targetPaths: string[]) => Promise<{ failed: number; passed: number }>;
	runTypecheck?: (worktreePath: string) => Promise<number>;
}

export interface SelfModGateReport {
	allowlistViolations: string[];
	anchorHits: string[];
	error?: string;
	errors: string[];
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
	memoryDir?: string;
	proposal?: SelfModProposal;
	retry?: SelfModRetry;
	targetPaths: string[];
	worktreePath: string;
}): Promise<SelfModGateReport> {
	const errors: string[] = [];
	const typecheck = await runTypecheckStep(opts.worktreePath, opts.hooks, errors);
	const tests = await runTestsStep(opts.worktreePath, opts.targetPaths, opts.hooks, errors);
	const evalOk = await runEvalStep(opts, errors);
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
		errors,
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
	if (!hooks?.runTests) {
		errors.push("no test runner wired");
		return { failed: 1, passed: 0 };
	}
	try {
		return await hooks.runTests(worktreePath, targetPaths);
	} catch (error) {
		errors.push(errorMessage(error));
		return { failed: 1, passed: 0 };
	}
}

async function runEvalStep(
	opts: {
		anchorCommit: string;
		git?: SelfmodGit;
		hooks?: SelfModGateHooks;
		memoryDir?: string;
		proposal?: SelfModProposal;
		worktreePath: string;
	},
	errors: string[],
): Promise<boolean> {
	if (!opts.hooks?.runEvalFixtures) {
		errors.push("no selfmod-gate eval fixtures wired");
		return false;
	}
	try {
		return await opts.hooks.runEvalFixtures(opts.worktreePath, {
			anchorCommit: opts.anchorCommit,
			git: opts.git,
			memoryDir: opts.memoryDir,
			proposal: opts.proposal,
			worktreePath: opts.worktreePath,
		});
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
	const encodingScanClean = await encodingCleanFor(opts, paths, errors);
	return { ...classified, encodingScanClean };
}

async function encodingCleanFor(
	opts: {
		anchorCommit: string;
		git?: SelfmodGit;
		hooks?: SelfModGateHooks;
		retry?: SelfModRetry;
		worktreePath: string;
	},
	paths: string[],
	errors: string[],
): Promise<boolean> {
	const read =
		opts.hooks?.readDiff ??
		((rel: string) =>
			readPathDiff({
				from: opts.anchorCommit,
				git: opts.git,
				path: rel,
				worktreePath: opts.worktreePath,
			}));
	for (const rel of paths) {
		try {
			const diff = await retryOnFsContention(() => read(rel), {
				attempts: opts.retry?.attempts ?? 8,
				baseDelayMs: opts.retry?.baseDelayMs ?? 25,
				label: "selfmod-gate-read",
			});
			if (addedLinesAreDirty(rel, diff)) return false;
		} catch (error) {
			errors.push(errorMessage(error));
			if (isTransientFsContention(error)) return false;
			return false;
		}
	}
	return true;
}

function addedLinesAreDirty(rel: string, diff: string): boolean {
	const code = isCodePath(rel);
	for (const line of diff.split(/\r?\n/)) {
		if (!line.startsWith("+") || line.startsWith("+++")) continue;
		const added = line.slice(1);
		if (code) {
			if (hasNonAscii(added)) return true;
		} else if (proseAddedLineIsDirty(added)) {
			return true;
		}
	}
	return false;
}

function proseAddedLineIsDirty(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 0xfffd) return true;
		if (isCyrillicOrKana(code)) return true;
	}
	return false;
}

function isCodePath(rel: string): boolean {
	const base = rel.replace(/\\/g, "/").split("/").pop() ?? rel;
	const dot = base.lastIndexOf(".");
	if (dot < 0) return false;
	return CODE_EXTS.has(base.slice(dot).toLowerCase());
}

function hasNonAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 127) return true;
	}
	return false;
}

function isCyrillicOrKana(code: number): boolean {
	return (
		(code >= 0x0400 && code <= 0x04ff) ||
		(code >= 0x0500 && code <= 0x052f) ||
		(code >= 0x3040 && code <= 0x309f) ||
		(code >= 0x30a0 && code <= 0x30ff) ||
		(code >= 0x31f0 && code <= 0x31ff) ||
		(code >= 0xff66 && code <= 0xff9d)
	);
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
