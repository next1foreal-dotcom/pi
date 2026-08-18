import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SelfModProposal } from "./selfmod-types.ts";
import { listDiffNames, type SelfmodGit } from "./selfmod-worktree.ts";

const execFileAsync = promisify(execFile);

export const SELFMOD_GATE_TEST_FILES = [
	"packages/her/test/selfmod-apply.test.ts",
	"packages/her/test/selfmod-c.test.ts",
	"packages/her/test/selfmod-cli.test.ts",
	"packages/her/test/selfmod-encoding.test.ts",
	"packages/her/test/selfmod-pickup.test.ts",
	"packages/her/test/selfmod-propose.test.ts",
	"packages/her/test/selfmod-runners.test.ts",
	"packages/her/test/selfmod-v1.test.ts",
	"packages/her/test/selfmod-v2.test.ts",
	"packages/her/test/selfmod-v3.test.ts",
	"packages/her/test/selfmod-v4.test.ts",
	"packages/her/test/selfmod-worktree.test.ts",
	"packages/her/test/anchor-commit-gate.test.ts",
	"packages/her/test/anchor-tool-call.test.ts",
	"packages/her/test/governed-tools-failsafe.test.ts",
	"packages/her/test/rsi-anchors.test.ts",
] as const;

export const SELFMOD_EVAL_DIR = "evals/selfmod-gate";

export type SelfmodTestSpawn = (
	command: string,
	args: readonly string[],
	opts: { cwd: string },
) => Promise<{ code: number; stderr?: string; stdout?: string }>;

export interface SelfModEvalContext {
	anchorCommit?: string;
	git?: SelfmodGit;
	memoryDir?: string;
	proposal?: SelfModProposal;
	worktreePath?: string;
}

export interface DefaultEvalOptions {
	anchorCommit?: string;
	diffNumstat?: () => Promise<{ added: number; deleted: number }>;
	git?: SelfmodGit;
	listDiff?: () => Promise<string[]>;
	memoryDir: string;
	proposal: SelfModProposal;
	readWorktreeFile?: (rel: string) => Promise<string | undefined>;
	statWorktreeFile?: (rel: string) => Promise<{ bytes: number } | undefined>;
	worktreePath: string;
}

export async function defaultRunTests(
	worktreePath: string,
	_targetPaths: string[] = [],
	spawn: SelfmodTestSpawn = spawnNodeTest,
): Promise<{ failed: number; passed: number }> {
	try {
		const result = await spawn("node", ["--import", "tsx", "--test", ...SELFMOD_GATE_TEST_FILES], {
			cwd: worktreePath,
		});
		if (result.code !== 0) return { failed: 1, passed: 0 };
		return { failed: 0, passed: 1 };
	} catch {
		return { failed: 1, passed: 0 };
	}
}

export async function defaultRunEvalFixtures(opts: DefaultEvalOptions): Promise<boolean> {
	const files = await listFixtureFiles(join(opts.memoryDir, ...SELFMOD_EVAL_DIR.split("/")));
	if (files.length === 0) return false;
	for (const file of files) {
		if (!(await runOneFixture(file, opts))) return false;
	}
	return true;
}

export function resolveMemoryRel(memoryDir: string, rel: string): string | undefined {
	const trimmed = rel.replace(/\\/g, "/").trim();
	if (!trimmed) return undefined;
	if (isEscapingRel(trimmed)) return undefined;
	const root = resolve(memoryDir);
	const resolved = resolve(memoryDir, trimmed);
	const rootNorm = normalizeAbs(root);
	const resolvedNorm = normalizeAbs(resolved);
	if (resolvedNorm !== rootNorm && !resolvedNorm.startsWith(`${rootNorm}/`)) return undefined;
	return resolved;
}

function isEscapingRel(rel: string): boolean {
	if (rel.startsWith("/") || rel.startsWith("//")) return true;
	if (/^[a-zA-Z]:/.test(rel)) return true;
	return rel.split("/").some((part) => part === "..");
}

function normalizeAbs(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

async function spawnNodeTest(
	command: string,
	args: readonly string[],
	opts: { cwd: string },
): Promise<{ code: number; stderr?: string; stdout?: string }> {
	try {
		const result = await execFileAsync(command, [...args], {
			cwd: opts.cwd,
			shell: process.platform === "win32",
			timeout: 180_000,
			windowsHide: true,
		});
		return { code: 0, stderr: result.stderr, stdout: result.stdout };
	} catch (error) {
		const rec = error as { code?: unknown; stderr?: string; stdout?: string };
		if (typeof rec.code === "number") return { code: rec.code, stderr: rec.stderr, stdout: rec.stdout };
		throw error;
	}
}

async function listFixtureFiles(dir: string): Promise<string[]> {
	try {
		const names = await readdir(dir);
		return names
			.filter((name) => name.toLowerCase().endsWith(".json"))
			.sort()
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}

async function runOneFixture(path: string, opts: DefaultEvalOptions): Promise<boolean> {
	let parsed: unknown;
	try {
		parsed = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object") return false;
	const rec = parsed as Record<string, unknown>;
	const kind = typeof rec.kind === "string" ? rec.kind : "";
	if (kind === "skill-shape") return runSkillShape(rec, opts);
	if (kind === "diff-budget") return runDiffBudget(rec, opts);
	if (kind === "evidence-exists") return runEvidenceExists(opts);
	return false;
}

async function runSkillShape(rec: Record<string, unknown>, opts: DefaultEvalOptions): Promise<boolean> {
	const maxBytes = asPositiveInt(rec.maxBytes);
	if (maxBytes === undefined) return false;
	const paths = await resolveDiffPaths(opts);
	const skills = paths.filter(isSkillRel);
	if (skills.length === 0) return true;
	for (const rel of skills) {
		const bytes = (await resolveStat(opts, rel))?.bytes;
		const text = await resolveRead(opts, rel);
		if (bytes === undefined || text === undefined) return false;
		if (!isLegalSkill(rel, text, bytes, maxBytes)) return false;
	}
	return true;
}

async function runDiffBudget(rec: Record<string, unknown>, opts: DefaultEvalOptions): Promise<boolean> {
	const maxLines = asPositiveInt(rec.maxLines);
	if (maxLines === undefined) return false;
	const stats = await resolveNumstat(opts);
	return stats.added + stats.deleted <= maxLines;
}

async function runEvidenceExists(opts: DefaultEvalOptions): Promise<boolean> {
	const abs = resolveMemoryRel(opts.memoryDir, opts.proposal.motivation.evidenceRef);
	if (!abs) return false;
	try {
		const info = await stat(abs);
		return info.isFile();
	} catch {
		return false;
	}
}

function isLegalSkill(rel: string, text: string, bytes: number, maxBytes: number): boolean {
	if (bytes <= 0 || bytes > maxBytes) return false;
	if (text.trim() === "") return false;
	const base = basename(rel.replace(/\\/g, "/"));
	if (base.toLowerCase() === "skill.md") return true;
	return /(^|\n)\s*name\s*:/i.test(text);
}

function isSkillRel(rel: string): boolean {
	const normalized = rel.replace(/\\/g, "/").toLowerCase();
	return normalized.includes("/skills/") || normalized.startsWith("skills/");
}

function asPositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.floor(value);
}

async function resolveDiffPaths(opts: DefaultEvalOptions): Promise<string[]> {
	if (opts.listDiff) return opts.listDiff();
	if (!opts.anchorCommit) return [];
	return listDiffNames({ from: opts.anchorCommit, git: opts.git, worktreePath: opts.worktreePath });
}

async function resolveRead(opts: DefaultEvalOptions, rel: string): Promise<string | undefined> {
	if (opts.readWorktreeFile) return opts.readWorktreeFile(rel);
	try {
		return await readFile(join(opts.worktreePath, ...rel.split("/")), "utf8");
	} catch {
		return undefined;
	}
}

async function resolveStat(opts: DefaultEvalOptions, rel: string): Promise<{ bytes: number } | undefined> {
	if (opts.statWorktreeFile) return opts.statWorktreeFile(rel);
	try {
		const info = await stat(join(opts.worktreePath, ...rel.split("/")));
		return { bytes: info.size };
	} catch {
		return undefined;
	}
}

async function resolveNumstat(opts: DefaultEvalOptions): Promise<{ added: number; deleted: number }> {
	if (opts.diffNumstat) return opts.diffNumstat();
	if (!opts.anchorCommit || !opts.git) return { added: 0, deleted: 0 };
	const text = (await opts.git(opts.worktreePath, "diff", "--numstat", `${opts.anchorCommit}..HEAD`)).stdout;
	let added = 0;
	let deleted = 0;
	for (const line of text.split(/\r?\n/)) {
		const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
		if (!match) continue;
		if (match[1] !== "-") added += Number(match[1]);
		if (match[2] !== "-") deleted += Number(match[2]);
	}
	return { added, deleted };
}
