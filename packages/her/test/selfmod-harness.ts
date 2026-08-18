import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { initStore } from "../src/her-core/index.ts";
import type { SelfModProposal } from "../src/her-core/selfmod-types.ts";

const execFileAsync = promisify(execFile);

export const SKILL_REL = "packages/her/pi-package/skills/fixture/SKILL.md";
export const SKILL_TS_REL = "packages/her/pi-package/skills/fixture/note.ts";
export const PROMPT_REL = "prompts/her.md";

export interface SelfmodFixture {
	id: string;
	memoryDir: string;
	repoRoot: string;
	worktreeRoot: string;
}

export async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

export async function makeFixture(slug: string): Promise<SelfmodFixture> {
	const repoRoot = await mkdtemp(join(tmpdir(), `her-g280-repo-${slug}-`));
	const worktreeRoot = await mkdtemp(join(tmpdir(), `her-g280-wt-${slug}-`));
	const memoryDir = await mkdtemp(join(tmpdir(), `her-g280-mem-${slug}-`));
	await initStore(memoryDir);
	await git(repoRoot, "init", "-q", "-b", "main");
	await git(repoRoot, "config", "user.email", "selfmod@example.com");
	await git(repoRoot, "config", "user.name", "Her Selfmod Test");
	await git(repoRoot, "config", "commit.gpgsign", "false");
	await writeRel(repoRoot, SKILL_REL, "# fixture\nhello\n");
	await writeRel(repoRoot, PROMPT_REL, "# her\n");
	await git(repoRoot, "add", "-A");
	await git(repoRoot, "commit", "-q", "-m", "initial");
	return { id: `selfmod-20260818-${slug}`, memoryDir, repoRoot, worktreeRoot };
}

export async function destroyFixture(fx: SelfmodFixture): Promise<void> {
	try {
		const listed = await git(fx.repoRoot, "worktree", "list", "--porcelain").catch(() => ({ stdout: "" }));
		const paths: string[] = [];
		for (const line of listed.stdout.split(/\r?\n/)) {
			if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
		}
		for (const path of paths) {
			if (samePath(path, fx.repoRoot)) continue;
			await unlinkJunction(join(path, "node_modules"));
			await git(fx.repoRoot, "worktree", "remove", path, "--force").catch(() => undefined);
		}
		await git(fx.repoRoot, "worktree", "prune").catch(() => undefined);
	} finally {
		await rm(fx.repoRoot, { force: true, recursive: true }).catch(() => undefined);
		await rm(fx.worktreeRoot, { force: true, recursive: true }).catch(() => undefined);
		await rm(fx.memoryDir, { force: true, recursive: true }).catch(() => undefined);
	}
}

export function proposalFor(fx: SelfmodFixture, over: Partial<SelfModProposal> = {}): SelfModProposal {
	return {
		id: fx.id,
		createdAt: "2026-08-18T00:00:00.000Z",
		motivation: { kind: "failure-anchored", evidenceRef: "ledger:fail-1" },
		targetPaths: [SKILL_REL],
		planSummary: "harmless skill comment",
		...over,
	};
}

export const greenHooks = {
	runTypecheck: async (): Promise<number> => 0,
	runTests: async (): Promise<{ failed: number; passed: number }> => ({ failed: 0, passed: 1 }),
	runEvalFixtures: async (): Promise<boolean> => true,
};

export async function applySkillLine(worktreePath: string, extraLine = "# touch"): Promise<void> {
	await writeRel(worktreePath, SKILL_REL, `# fixture\nhello\n${extraLine}\n`);
	await git(worktreePath, "add", SKILL_REL);
	await git(worktreePath, "commit", "-q", "-m", "selfmod apply");
}

export async function applySkillTs(worktreePath: string, body: string): Promise<void> {
	await writeRel(worktreePath, SKILL_TS_REL, body);
	await git(worktreePath, "add", SKILL_TS_REL);
	await git(worktreePath, "commit", "-q", "-m", "selfmod apply ts");
}

export async function writeRel(root: string, rel: string, text: string): Promise<void> {
	const abs = join(root, ...rel.split("/"));
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, text, "utf8");
}

async function unlinkJunction(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (!info.isSymbolicLink() && !info.isDirectory()) return;
		await rmdir(path).catch(async () => unlink(path));
	} catch {
		/* missing or not a junction */
	}
}

function samePath(a: string, b: string): boolean {
	const left = a.replace(/\\/g, "/").toLowerCase();
	const right = b.replace(/\\/g, "/").toLowerCase();
	return left === right;
}
