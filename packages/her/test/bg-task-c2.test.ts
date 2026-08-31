import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { herTaskOutput } from "../src/her-core/bg-task-output.ts";
import { parseCodexSessionId, reconcileBgTasks } from "../src/her-core/bg-task-reconcile.ts";
import { type BgTaskRecord, loadBgTask, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { continueBgTask } from "../src/her-core/bg-task-spawn.ts";
import { ensureTaskWorktree } from "../src/her-core/long-task-worktree.ts";
import { prepareWorkerCommand, type WorkerProfile } from "../src/her-core/worker-profile.ts";

const execFileAsync = promisify(execFile);

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-c2-"));
	await mkdir(tasksDir(root), { recursive: true });
	return root;
}

async function waitForDone(root: string, id: string, timeoutMs = 15_000): Promise<void> {
	const path = join(tasksDir(root), `${id}.done`);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await readFile(path, "utf8");
			return;
		} catch {
			await sleep(50);
		}
	}
	throw new Error(`timeout waiting for ${id}.done`);
}

async function writeConfig(root: string, text: string): Promise<void> {
	await writeFile(join(root, ".her", "config.yaml"), text, "utf8");
}

function record(overrides: Partial<BgTaskRecord> = {}): BgTaskRecord {
	return {
		id: "t-20260802-c2",
		status: "completed",
		objective: "C2 fixture",
		worker: "codex",
		command: ["codex"],
		created: "2026-08-02T00:00:00.000Z",
		updated: "2026-08-02T00:00:00.000Z",
		endedAt: "2026-08-02T00:00:01.000Z",
		retries: 0,
		host: hostname(),
		...overrides,
	};
}

// G-187 — 注入位置从「追加到末尾」改成「插在 exec 之后」。原因是实弹量出来的:
// `codex exec resume <id> <prompt>` 不接受位置参数之后的旗子(codex 直接吐 usage 并非零退出),
// 而 `codex exec [OPTIONS] [PROMPT]` 两种位置都收。一条对两种形状都合法的规则胜过两条。
// 同时补 --skip-git-repo-check: worker 的 cwd 是 <memoryRoot>/.her/tasks,不是 workspace。
test("C2 worker command adds --json and -o once, without changing non-Codex profiles", () => {
	const profile: WorkerProfile = { argv: ["codex", "exec", "-"] };
	assert.deepEqual(prepareWorkerCommand("codex", profile, "C:\\tasks", "t-1"), [
		"codex",
		"exec",
		"--json",
		"-o",
		join("C:\\tasks", "t-1.result.md"),
		"--skip-git-repo-check",
		"-",
	]);
	assert.deepEqual(
		prepareWorkerCommand(
			"codex",
			{ argv: ["codex", "exec", "--json", "-o", "custom.md", "--skip-git-repo-check", "-"] },
			"C:\\tasks",
			"t-2",
		),
		["codex", "exec", "--json", "-o", "custom.md", "--skip-git-repo-check", "-"],
		"已配置的旗子不许重复注入",
	);
	assert.deepEqual(prepareWorkerCommand("deer", { argv: ["node", "deer.mjs"] }, "C:\\tasks", "t-3"), [
		"node",
		"deer.mjs",
	]);
});

test("C2 parser keeps the first Codex session id and ignores non-JSON log lines", () => {
	const id = "0198f1a0-7e1b-7c01-9b6c-123456789abc";
	const stream = [
		"warning: noisy stderr",
		JSON.stringify({ type: "turn.started" }),
		JSON.stringify({ type: "thread.started", thread_id: id }),
		JSON.stringify({ type: "thread.started", thread_id: "later-id" }),
	].join("\n");
	assert.equal(parseCodexSessionId(stream), id);
	assert.equal(parseCodexSessionId(`not json\n${JSON.stringify({ type: "turn.started" })}`), undefined);
});

test("C2 reconcile persists a Codex session id from the combined JSONL log", async () => {
	const root = await memoryRoot();
	const id = "t-20260802-parse";
	const sessionId = "0198f1a0-7e1b-7c01-9b6c-123456789abc";
	await saveBgTask(root, record({ id, status: "running", command: ["codex", "exec"] }), "# fixture\n");
	await writeFile(
		join(tasksDir(root), `${id}.log`),
		`stderr\n${JSON.stringify({ type: "thread.started", thread_id: sessionId })}\n`,
		"utf8",
	);
	await writeFile(
		join(tasksDir(root), `${id}.done`),
		JSON.stringify({ exitCode: 0, endedAt: "2026-08-02T00:00:02.000Z" }),
		"utf8",
	);
	const events = await reconcileBgTasks(root, { hostname: hostname(), skipRetry: true });
	assert.equal(events[0]?.status, "completed");
	assert.equal((await loadBgTask(root, id))?.record.codexSessionId, sessionId);
});

test("C2 her_task_output prefers result.md and falls back to the raw log", async () => {
	const root = await memoryRoot();
	const id = "t-20260802-output";
	await saveBgTask(root, record({ id }), "# fixture\n");
	await writeFile(join(tasksDir(root), `${id}.log`), "raw log\n", "utf8");
	await writeFile(join(tasksDir(root), `${id}.result.md`), "clean result\n", "utf8");
	assert.equal((await herTaskOutput(root, id)).chunk, "clean result\n");
	await rm(join(tasksDir(root), `${id}.result.md`));
	assert.equal((await herTaskOutput(root, id)).chunk, "raw log\n");
});

test("C2 continue rejects non-terminal, missing uuid, and non-Codex records explicitly", async () => {
	const root = await memoryRoot();
	await saveBgTask(root, record({ id: "t-running", status: "running", endedAt: undefined }), "# fixture\n");
	await assert.rejects(
		() => continueBgTask(root, "t-running", "hello", "owner-1"),
		(error: Error) => error.message === "该任务暂不支持续跑: 原任务未处于终态（当前状态 running）",
	);

	await saveBgTask(root, record({ id: "t-no-uuid" }), "# fixture\n");
	await assert.rejects(
		() => continueBgTask(root, "t-no-uuid", "hello", "owner-1"),
		(error: Error) => error.message === "该任务暂不支持续跑: 原任务没有 codexSessionId",
	);

	await saveBgTask(root, record({ id: "t-deer", worker: "deer", codexSessionId: "uuid-deer" }), "# fixture\n");
	await assert.rejects(
		() => continueBgTask(root, "t-deer", "hello", "owner-1"),
		(error: Error) => error.message === "该任务暂不支持续跑: 任务类型不是 codex",
	);
});

test("C2 continue spawns a normal child with parentTask, ownerSessionId, and redacted resume argv", async () => {
	const root = await memoryRoot();
	const fakeBin = await mkdtemp(join(tmpdir(), "her-codex-bin-"));
	const fakeCodex = join(fakeBin, process.platform === "win32" ? "codex.exe" : "codex");
	await copyFile(process.execPath, fakeCodex);
	await writeConfig(
		root,
		[
			"workers:",
			"  codex:",
			'    argv: ["codex"]',
			"tasks:",
			"  max_concurrent: 3",
			"  budget_daily_cap: 100",
			"",
		].join("\n"),
	);
	const oldPath = process.env.PATH;
	process.env.PATH = fakeBin + (process.platform === "win32" ? ";" : ":") + (oldPath ?? "");
	try {
		const oldId = "t-20260802-parent";
		const sessionId = "0198f1a0-7e1b-7c01-9b6c-123456789abc";
		await saveBgTask(root, record({ id: oldId, codexSessionId: sessionId }), "# fixture\n");
		const result = await continueBgTask(root, oldId, `remember sk-${"a".repeat(30)}`, "owner-2");
		assert.equal(result.status, "running");
		if (result.status !== "running") return;
		await waitForDone(root, result.id);
		const child = await loadBgTask(root, result.id);
		assert.equal(child?.record.parentTask, oldId);
		assert.equal(child?.record.ownerSessionId, "owner-2");
		// G-187 — 续跑现在继承 profile 旗子并注入自己的 --json/-o(旗子一律排在 resume 之前),
		// 所以子任务能捕到自己的 session id、写自己的 result.md,也就还能再被续。
		assert.deepEqual(child?.record.command, [
			"codex",
			"exec",
			"--json",
			"-o",
			join(tasksDir(root), `${result.id}.result.md`),
			"--skip-git-repo-check",
			"resume",
			sessionId,
			"remember «REDACTED:secret»",
		]);
	} finally {
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
	}
});

function sameDir(a: string, b: string): boolean {
	return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execFileAsync("git", args, { cwd });
}

async function tempGitRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-c2-repo-"));
	await git(root, "init", "-q");
	await git(root, "config", "user.email", "c2@example.com");
	await git(root, "config", "user.name", "Her C2 Test");
	await writeFile(join(root, "README.md"), "# repo\n", "utf8");
	await git(root, "add", "-A");
	await git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

async function withWorktreeRoot<T>(worktreeRoot: string, fn: () => Promise<T>): Promise<T> {
	const prev = process.env.HER_LONGTASK_WORKTREE_ROOT;
	process.env.HER_LONGTASK_WORKTREE_ROOT = worktreeRoot;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.HER_LONGTASK_WORKTREE_ROOT;
		else process.env.HER_LONGTASK_WORKTREE_ROOT = prev;
	}
}

async function writeGrokPromptFixture(dir: string): Promise<string> {
	const path = join(dir, "read-prompt-file.mjs");
	await writeFile(
		path,
		[
			"import { readFileSync } from 'node:fs';",
			"const i = process.argv.indexOf('--prompt-file');",
			"if (i < 0 || !process.argv[i + 1]) {",
			"  process.stderr.write('NO_PROMPT_FILE\\n');",
			"  process.exit(2);",
			"}",
			"process.stdout.write('CWD=' + process.cwd() + '\\n');",
			"process.stdout.write(readFileSync(process.argv[i + 1], 'utf8'));",
			"",
		].join("\n"),
		"utf8",
	);
	return path;
}

test("C2 grok continue reuses parent worktree and injects --continue via prompt-file", async () => {
	const root = await memoryRoot();
	const fixture = await writeGrokPromptFixture(root);
	const parentWorktree = await mkdtemp(join(tmpdir(), "her-c2-grok-wt-"));
	const pool = await mkdtemp(join(tmpdir(), "her-c2-wt-pool-"));
	await writeConfig(
		root,
		[
			"workers:",
			"  grok:",
			`    argv: ["${process.execPath.replace(/\\/g, "/")}", "${fixture.replace(/\\/g, "/")}"]`,
			"tasks:",
			"  max_concurrent: 3",
			"  budget_daily_cap: 100",
			"  probe_max_age_hours: 0",
			"",
		].join("\n"),
	);
	const oldId = "t-20260802-grok-parent";
	await saveBgTask(
		root,
		record({
			id: oldId,
			worker: "grok",
			command: ["grok"],
			worktree: parentWorktree,
		}),
		"# fixture\n",
	);
	await withWorktreeRoot(pool, async () => {
		const result = await continueBgTask(root, oldId, "keep going", "owner-2");
		assert.equal(result.status, "running");
		if (result.status !== "running") return;
		await waitForDone(root, result.id);
		const child = await loadBgTask(root, result.id);
		assert.equal(child?.record.parentTask, oldId);
		assert.equal(child?.record.ownerSessionId, "owner-2");
		assert.equal(child?.record.worker, "grok");
		assert.equal(child?.record.worktreeReused, true);
		assert.ok(typeof child?.record.worktree === "string" && sameDir(String(child.record.worktree), parentWorktree));
		assert.ok(
			child?.record.command.includes("--continue"),
			`expected --continue in ${JSON.stringify(child?.record.command)}`,
		);
		assert.ok(
			child?.record.command.includes("--prompt-file"),
			`expected --prompt-file in ${JSON.stringify(child?.record.command)}`,
		);
		const briefPath = join(tasksDir(root), `${result.id}.brief`);
		assert.equal(child.record.command[child.record.command.indexOf("--prompt-file") + 1], briefPath);
		assert.equal(await readFile(briefPath, "utf8"), "keep going");
		const log = await readFile(join(tasksDir(root), `${result.id}.log`), "utf8");
		const cwdLine = log.split("\n").find((line) => line.startsWith("CWD="));
		assert.ok(cwdLine, `expected CWD= in log, got ${JSON.stringify(log)}`);
		assert.ok(sameDir(cwdLine.slice(4), parentWorktree), `cwd ${cwdLine.slice(4)} !== parent ${parentWorktree}`);
		assert.deepEqual(await readdir(pool), [], "grok continue must not create or claim a worktree");
	});
});

test("C2 grok continue rejects missing worktree and a recycled worktree explicitly", async () => {
	const root = await memoryRoot();
	await saveBgTask(root, record({ id: "t-grok-none", worker: "grok", command: ["grok"] }), "# fixture\n");
	await assert.rejects(
		() => continueBgTask(root, "t-grok-none", "hello", "owner-1"),
		(error: Error) => error.message === "该任务暂不支持续跑: grok 续跑需要原任务的 worktree",
	);

	const gone = join(root, "already-reclaimed");
	await saveBgTask(
		root,
		record({ id: "t-grok-gone", worker: "grok", command: ["grok"], worktree: gone }),
		"# fixture\n",
	);
	await assert.rejects(
		() => continueBgTask(root, "t-grok-gone", "hello", "owner-1"),
		(error: Error) => error.message === "该任务暂不支持续跑: 原任务的 worktree 已被回收",
	);
});

test("C2 reused worktree survives child settlement", async () => {
	const root = await memoryRoot();
	await writeConfig(root, ["tasks:", "  max_concurrent: 5", "  max_retries: 0", ""].join("\n"));
	const repo = await tempGitRepo();
	const worktreeRoot = await mkdtemp(join(tmpdir(), "her-c2-reuse-"));
	const childId = "t-20260802-reuse";
	await withWorktreeRoot(worktreeRoot, async () => {
		const wt = await ensureTaskWorktree(repo, childId);
		await saveBgTask(
			root,
			record({
				id: childId,
				status: "running",
				endedAt: undefined,
				worker: "grok",
				command: ["grok"],
				worktree: wt.worktreePath,
				codeRoot: repo,
				worktreeBranch: wt.branch,
				worktreeBaseSha: wt.baseSha,
				worktreeReused: true,
			}),
			"# reused child\n",
		);
		await writeFile(
			join(tasksDir(root), `${childId}.done`),
			JSON.stringify({ exitCode: 0, endedAt: "2026-08-02T00:00:02.000Z" }),
			"utf8",
		);
		await reconcileBgTasks(root, { hostname: hostname(), skipRetry: true });
		assert.equal(existsSync(wt.worktreePath), true, "shared parent worktree must survive child settlement");
		const loaded = await loadBgTask(root, childId);
		assert.equal(loaded?.record.status, "completed");
		assert.ok(typeof loaded?.record.worktree === "string" && loaded.record.worktree.length > 0);
	});
});
