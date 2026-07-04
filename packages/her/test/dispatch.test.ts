import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	DISPATCH_GROUND_RULES,
	type DispatchExecutorResult,
	estimateUsdFromNdjson,
	resolvePiCliPath,
	runDispatch,
	selectCodexCommand,
	selectCodexSpawnPlan,
	timeoutKillPlan,
} from "../src/her-core/dispatch.ts";
import { initStore, listLongTasks, parseFrontmatter, readText } from "../src/her-core/index.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

async function tempMemoryStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-dispatch-memory-"));
	await initStore(root);
	return root;
}

async function tempGitRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-dispatch-repo-"));
	await git(root, "init", "-q");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Her Dispatch Test");
	await writeFile(join(root, "README.md"), "# repo\n", "utf8");
	await git(root, "add", "-A");
	await git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

async function tempHandoff(text = "# Example Handoff\n\nDo the thing.\n"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "her-dispatch-handoff-"));
	const path = join(dir, "handoff.md");
	await writeFile(path, text, "utf8");
	return path;
}

function okStub(): DispatchExecutorResult {
	return { exitCode: 0, prompt: "", stderr: "", stdout: "", timedOut: false };
}

test("selectCodexCommand chooses the Windows shim from probe results", () => {
	assert.equal(selectCodexCommand("win32", { "codex.cmd": true, "codex.exe": true, codex: true }), "codex.cmd");
	assert.equal(selectCodexCommand("win32", { "codex.cmd": false, "codex.exe": true, codex: true }), "codex.exe");
	assert.equal(selectCodexCommand("win32", { "codex.cmd": false, "codex.exe": false, codex: true }), "codex");
	assert.equal(selectCodexCommand("win32", { "codex.cmd": false, "codex.exe": false, codex: false }), "codex.cmd");
	assert.equal(selectCodexCommand("linux", { "codex.cmd": true, "codex.exe": true, codex: false }), "codex");
});

test("selectCodexSpawnPlan runs the Codex JS entry instead of spawning the Windows cmd shim", () => {
	const plan = selectCodexSpawnPlan(
		"win32",
		{ "codex.cmd": "C:\\tools\\npm", "codex.exe": false, codex: false },
		"D:\\work dir\\项目",
		"C:\\node\\node.exe",
		() => true,
	);

	assert.equal(plan.command, "C:\\node\\node.exe");
	assert.equal(plan.args[0].replace(/\\/g, "/"), "C:/tools/npm/node_modules/@openai/codex/bin/codex.js");
	assert.deepEqual(plan.args.slice(1), ["exec", "-s", "workspace-write", "--cd", "D:\\work dir\\项目", "-"]);
});

test("selectCodexSpawnPlan falls back to cmd.exe with cwd and --cd . when JS probing fails", () => {
	const plan = selectCodexSpawnPlan(
		"win32",
		{ "codex.cmd": "C:\\tools\\npm", "codex.exe": false, codex: false },
		"D:\\work dir\\项目",
		"C:\\node\\node.exe",
		() => false,
	);

	assert.equal(plan.command, "cmd.exe");
	assert.deepEqual(plan.args, ["/d", "/s", "/c", "codex", "exec", "-s", "workspace-write", "--cd", ".", "-"]);
});

test("timeoutKillPlan kills the whole Windows process tree", () => {
	assert.deepEqual(timeoutKillPlan("win32", 1234), {
		command: "taskkill",
		args: ["/pid", "1234", "/T", "/F"],
	});
	assert.equal(timeoutKillPlan("linux", 1234), undefined);
});

test("dispatch records executor spawn failures across ledger audit and capture", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();
	const spawnError = Object.assign(new Error("spawn missing-executor ENOENT"), { code: "ENOENT" });

	const result = await runDispatch({
		cwd,
		executor: "codex",
		handoffPath,
		memoryDir,
		spawnExecutor: async () => {
			throw spawnError;
		},
	});

	assert.equal(result.status, "failed");
	assert.equal(result.commits, 0);
	assert.equal(result.filesChanged, 0);

	const tasks = await listLongTasks(memoryDir);
	assert.equal(tasks.length, 1);
	assert.notEqual(tasks[0].status, "active");
	const record = await readText(join(memoryDir, tasks[0].path));
	assert.match(record ?? "", /failed: spawn missing-executor ENOENT/);

	const auditFiles = await readdir(join(memoryDir, "audit"));
	const auditRaw = await readText(join(memoryDir, "audit", auditFiles[0]));
	const auditEntry = JSON.parse((auditRaw ?? "").trim()) as { dispatchId: string; executor: string; status: string };
	assert.equal(auditEntry.dispatchId, result.dispatchId);
	assert.equal(auditEntry.executor, "codex");
	assert.equal(auditEntry.status, "failed");

	const rawFiles = (await readdir(join(memoryDir, "episodic", "raw"))).filter((name) => name.endsWith(".md"));
	assert.equal(rawFiles.length, 1);
	const raw = await readText(join(memoryDir, "episodic", "raw", rawFiles[0]));
	const parsed = parseFrontmatter(raw);
	assert.equal(parsed.data.dispatch_id, result.dispatchId);
	assert.equal(parsed.data.executor, "codex");
});

async function lastAuditEntry(
	memoryDir: string,
): Promise<{ cost?: { purpose?: string; usd: number }; executor: string; status: string }> {
	const auditFiles = (await readdir(join(memoryDir, "audit"))).sort();
	const raw = await readText(join(memoryDir, "audit", auditFiles.at(-1) ?? ""));
	const lines = (raw ?? "").trim().split("\n").filter(Boolean);
	return JSON.parse(lines.at(-1) ?? "{}");
}

test("dispatch records a codex-estimated cost when a codex executor spawn fails", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();
	const spawnError = Object.assign(new Error("spawn missing-executor ENOENT"), { code: "ENOENT" });

	await runDispatch({
		cwd,
		executor: "codex",
		handoffPath,
		memoryDir,
		spawnExecutor: async () => {
			throw spawnError;
		},
	});

	const entry = await lastAuditEntry(memoryDir);
	assert.equal(entry.status, "failed");
	assert.equal(entry.cost?.purpose, "codex-estimated");
	assert.equal(entry.cost?.usd, 0.5);
});

test("dispatch records a codex-estimated cost when a codex executor times out", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	const result = await runDispatch({
		cwd,
		executor: "codex",
		handoffPath,
		memoryDir,
		timeoutMin: 0.001,
		spawnExecutor: async () => {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
			return okStub();
		},
	});

	assert.equal(result.status, "timed-out");
	assert.equal(result.usd, 0.5);
	const entry = await lastAuditEntry(memoryDir);
	assert.equal(entry.status, "timed-out");
	assert.equal(entry.cost?.purpose, "codex-estimated");
	assert.equal(entry.cost?.usd, 0.5);
});

test("dispatch records a codex-estimated cost when a codex executor completes with no parsable usd", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	const result = await runDispatch({
		cwd,
		executor: "codex",
		handoffPath,
		memoryDir,
		spawnExecutor: async () => okStub(),
	});

	assert.equal(result.status, "completed");
	const entry = await lastAuditEntry(memoryDir);
	assert.equal(entry.cost?.purpose, "codex-estimated");
	assert.equal(entry.cost?.usd, 0.5);
});

test("dispatch honors HER_CODEX_USD_ESTIMATE override for the codex-estimated cost", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	await runDispatch({
		cwd,
		env: { ...process.env, HER_CODEX_USD_ESTIMATE: "1.75" },
		executor: "codex",
		handoffPath,
		memoryDir,
		spawnExecutor: async () => okStub(),
	});

	const entry = await lastAuditEntry(memoryDir);
	assert.equal(entry.cost?.usd, 1.75);
});

test("dispatch does not fabricate a cost entry for a non-codex executor with no usd", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	await runDispatch({
		cwd,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: async () => okStub(),
	});

	const entry = await lastAuditEntry(memoryDir);
	assert.equal(entry.cost, undefined);
});

test("dispatch still records the real pi cost via estimateUsdFromNdjson unchanged", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	await runDispatch({
		cwd,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: async () => ({ ...okStub(), usd: 0.0071414 }),
	});

	const entry = await lastAuditEntry(memoryDir);
	assert.equal(entry.cost?.usd, 0.0071414);
	assert.equal(entry.cost?.purpose, undefined);
});

test("dispatch refuses the 11th codex dispatch of the day before spawning the executor", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	// Pre-seed 10 codex dispatch audit entries for today so the default cap (10) is already reached.
	const auditDir = join(memoryDir, "audit");
	await mkdir(auditDir, { recursive: true });
	const today = new Date().toISOString().slice(0, 10);
	const seeded = Array.from({ length: 10 }, (_, index) =>
		JSON.stringify({
			dispatchId: `seed-${index}`,
			executor: "codex",
			handoff: "seed.md",
			status: "completed",
			tool: "her_dispatch",
			ts: new Date().toISOString(),
			cost: { purpose: "codex-estimated", usd: 0.5 },
		}),
	).join("\n");
	await writeFile(join(auditDir, `${today}.jsonl`), `${seeded}\n`, "utf8");

	let spawned = false;
	await assert.rejects(
		() =>
			runDispatch({
				cwd,
				executor: "codex",
				handoffPath,
				memoryDir,
				spawnExecutor: async () => {
					spawned = true;
					return okStub();
				},
			}),
		/codex.*(run|dispatch).*(limit|cap|day)/i,
	);
	assert.equal(spawned, false);

	const tasks = await listLongTasks(memoryDir);
	assert.equal(tasks.length, 1);
	assert.match((await readText(join(memoryDir, tasks[0].path))) ?? "", /rejected/);
});

test("dispatch does not count non-codex executors toward the daily codex-run cap", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	const auditDir = join(memoryDir, "audit");
	await mkdir(auditDir, { recursive: true });
	const today = new Date().toISOString().slice(0, 10);
	const seeded = Array.from({ length: 10 }, (_, index) =>
		JSON.stringify({
			dispatchId: `seed-${index}`,
			executor: "pi:deepseek",
			handoff: "seed.md",
			status: "completed",
			tool: "her_dispatch",
			ts: new Date().toISOString(),
		}),
	).join("\n");
	await writeFile(join(auditDir, `${today}.jsonl`), `${seeded}\n`, "utf8");

	const result = await runDispatch({
		cwd,
		executor: "codex",
		handoffPath,
		memoryDir,
		spawnExecutor: async () => okStub(),
	});

	assert.equal(result.status, "completed");
});

function committingStub(files: Array<{ path: string; content: string }>) {
	return async (opts: { cwd: string; prompt: string }): Promise<DispatchExecutorResult> => {
		for (const file of files) {
			const fullPath = join(opts.cwd, file.path);
			await mkdir(join(fullPath, ".."), { recursive: true });
			await writeFile(fullPath, file.content, "utf8");
		}
		await git(opts.cwd, "add", "-A");
		await git(opts.cwd, "commit", "-q", "-m", "executor change");
		return { ...okStub(), prompt: opts.prompt };
	};
}

test("dispatch rejects over-budget requests and records rejection on the ledger", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	// Pre-seed an audit entry so the daily cap (set to 0.01) is already exceeded.
	const auditDir = join(memoryDir, "audit");
	await mkdir(auditDir, { recursive: true });
	const today = new Date().toISOString().slice(0, 10);
	await writeFile(
		join(auditDir, `${today}.jsonl`),
		`${JSON.stringify({ tool: "seed", ts: new Date().toISOString(), cost: { usd: 5 } })}\n`,
		"utf8",
	);

	await assert.rejects(
		() =>
			runDispatch({
				cwd,
				dailyCapUsd: 0.01,
				executor: "pi:deepseek",
				handoffPath,
				memoryDir,
				spawnExecutor: async () => okStub(),
			}),
		/over-budget/,
	);

	const tasks = await listLongTasks(memoryDir);
	assert.equal(tasks.length, 1);
	assert.equal(tasks[0].status, "completed");
	const record = await readText(join(memoryDir, tasks[0].path));
	assert.match(record ?? "", /rejected: over-budget/);

	const rawFiles = (await readdir(join(memoryDir, "episodic", "raw"))).filter((name) => name.endsWith(".md"));
	assert.equal(rawFiles.length, 1);
	const raw = await readText(join(memoryDir, "episodic", "raw", rawFiles[0]));
	const parsed = parseFrontmatter(raw);
	assert.equal(parsed.data.dispatch_id, tasks[0].id);
	assert.equal(parsed.data.executor, "pi:deepseek");
	assert.equal(parsed.data.provenance, "her-observed");
});

test("dispatch runs the full lifecycle from active to completed with frontmatter fields intact", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff("# Ship the widget\n\nSteps here.\n");

	const result = await runDispatch({
		cwd,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: committingStub([{ path: "packages/her/src/her-core/widget.ts", content: "export {};\n" }]),
	});

	assert.equal(result.status, "completed");
	assert.equal(result.commits, 1);
	assert.equal(result.filesChanged, 1);
	assert.deepEqual(result.violations, []);

	const tasks = await listLongTasks(memoryDir);
	assert.equal(tasks.length, 1);
	const record = await readText(join(memoryDir, tasks[0].path));
	const parsed = parseFrontmatter(record);
	assert.equal(parsed.data.status, "completed");
	assert.equal(parsed.data.owner, "dispatch");
	assert.equal(parsed.data.objective, "Ship the widget");
	assert.equal(parsed.data.source, handoffPath);
	assert.ok(typeof parsed.data.created === "string" && parsed.data.created.length > 0);
	assert.ok(typeof parsed.data.updated === "string" && parsed.data.updated.length > 0);
});

test("dispatch flags actual cost exceeding --budget-usd as completed-with-violations", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	const result = await runDispatch({
		budgetUsd: 0.5,
		cwd,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: async () => ({ ...okStub(), usd: 1.25 }),
	});

	assert.equal(result.status, "completed-with-violations");
	assert.ok(result.violations.some((violation) => /budget/i.test(violation)));
	assert.equal(result.usd, 1.25);
});

test("dispatch flags a forbidden-zone commit as completed-with-violations and fails loud", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	const result = await runDispatch({
		cwd,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: committingStub([{ path: "packages/coding-agent/x.ts", content: "export {};\n" }]),
	});

	assert.equal(result.status, "completed-with-violations");
	assert.deepEqual(result.violations, ["packages/coding-agent/x.ts"]);

	const tasks = await listLongTasks(memoryDir);
	const record = await readText(join(memoryDir, tasks[0].path));
	assert.match(record ?? "", /packages\/coding-agent\/x\.ts/);
});

test("dispatch flags a push to a non-tracking remote as completed-with-violations", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	const bareRemote = await mkdtemp(join(tmpdir(), "her-dispatch-extra-remote-"));
	await git(bareRemote, "init", "-q", "--bare");

	const result = await runDispatch({
		cwd,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: async (opts) => {
			await git(opts.cwd, "remote", "add", "x", bareRemote);
			await writeFile(join(opts.cwd, "pushed-extra.txt"), "pushed\n", "utf8");
			await git(opts.cwd, "add", "-A");
			await git(opts.cwd, "commit", "-q", "-m", "executor commit before extra push");
			await git(opts.cwd, "push", "-q", "x", "HEAD:main");
			return { ...okStub(), prompt: opts.prompt };
		},
	});

	assert.equal(result.status, "completed-with-violations");
	assert.ok(result.violations.some((violation) => /remote/i.test(violation)));
});

test("dispatch flags a remote push during the run as completed-with-violations", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	const bareRemote = await mkdtemp(join(tmpdir(), "her-dispatch-remote-"));
	await git(bareRemote, "init", "-q", "--bare");
	await git(cwd, "remote", "add", "origin", bareRemote);
	await git(cwd, "push", "-q", "-u", "origin", "HEAD");

	const result = await runDispatch({
		cwd,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: async (opts) => {
			await writeFile(join(opts.cwd, "pushed.txt"), "pushed\n", "utf8");
			await git(opts.cwd, "add", "-A");
			await git(opts.cwd, "commit", "-q", "-m", "executor commit before push");
			await git(opts.cwd, "push", "-q", "origin", "HEAD");
			return { ...okStub(), prompt: opts.prompt };
		},
	});

	assert.equal(result.status, "completed-with-violations");
	assert.ok(result.violations.some((violation) => /remote/i.test(violation)));
});

async function tempWorktreeStagingRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "her-dispatch-worktrees-"));
}

test("dispatch isolates two concurrent dispatches in their own worktree; each violation diff sees only its own commit", async () => {
	const memoryDir1 = await tempMemoryStore();
	const memoryDir2 = await tempMemoryStore();
	const cwd = await tempGitRepo();
	// Distinct objectives (as real concurrent dispatches would have): startLongTask derives the
	// dispatchId from a hash of {timestamp, objective}, so identical objectives dispatched in the
	// same low-resolution timer tick could collide -- distinct text is what production dispatches
	// actually look like and keeps this test about worktree isolation, not ID-hash collisions.
	const handoffPathA = await tempHandoff("# Handoff A\n\nDo thing A.\n");
	const handoffPathB = await tempHandoff("# Handoff B\n\nDo thing B.\n");
	const worktreeRoot = await tempWorktreeStagingRoot();
	const env = { ...process.env, HER_DISPATCH_WORKTREE_ROOT: worktreeRoot };

	const [resultA, resultB] = await Promise.all([
		runDispatch({
			cwd,
			env,
			executor: "pi:deepseek",
			handoffPath: handoffPathA,
			memoryDir: memoryDir1,
			spawnExecutor: committingStub([{ path: "from-dispatch-a.txt", content: "a\n" }]),
		}),
		runDispatch({
			cwd,
			env,
			executor: "pi:deepseek",
			handoffPath: handoffPathB,
			memoryDir: memoryDir2,
			spawnExecutor: committingStub([{ path: "from-dispatch-b.txt", content: "b\n" }]),
		}),
	]);

	assert.equal(resultA.status, "completed");
	assert.equal(resultB.status, "completed");
	assert.deepEqual(resultA.violations, []);
	assert.deepEqual(resultB.violations, []);
	assert.equal(resultA.commits, 1);
	assert.equal(resultB.commits, 1);

	// The load-bearing assertion: each dispatch's diff must contain ONLY its own file, never the
	// other's -- proving the two concurrent dispatches did not share a baseline/working tree.
	assert.equal(
		(await git(resolve(worktreeRoot, resultA.dispatchId), "diff", "--name-only", "HEAD~1..HEAD")).stdout.trim(),
		"from-dispatch-a.txt",
	);
	assert.equal(
		(await git(resolve(worktreeRoot, resultB.dispatchId), "diff", "--name-only", "HEAD~1..HEAD")).stdout.trim(),
		"from-dispatch-b.txt",
	);

	// The shared main repo's own branch must be untouched by either dispatch: still just the one
	// "initial commit" from tempGitRepo(), neither executor's commit landed on it.
	assert.equal((await git(cwd, "status", "--porcelain")).stdout.trim(), "");
	assert.equal((await git(cwd, "rev-list", "--count", "HEAD")).stdout.trim(), "1");
});

test("dispatch products stay on a dispatch/<id> branch inside the worktree; the dispatch body never merges", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();
	const worktreeRoot = await tempWorktreeStagingRoot();
	const env = { ...process.env, HER_DISPATCH_WORKTREE_ROOT: worktreeRoot };

	const result = await runDispatch({
		cwd,
		env,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: committingStub([{ path: "widget.txt", content: "widget\n" }]),
	});

	assert.equal(result.status, "completed");
	assert.equal(result.branch, `dispatch/${result.dispatchId}`);
	assert.ok(result.worktreePath, "expected a worktreePath on the result");
	assert.ok(existsSync(result.worktreePath ?? ""), "expected the worktree directory to still exist after completion");

	const worktreeBranch = (await git(result.worktreePath ?? "", "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
	assert.equal(worktreeBranch, `dispatch/${result.dispatchId}`);

	// The main repo's own branch must NOT have absorbed the executor's commit (no auto-merge).
	const mainBranch = (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
	assert.notEqual(mainBranch, `dispatch/${result.dispatchId}`);
	assert.equal((await git(cwd, "log", "--all", "--oneline")).stdout.includes("widget"), false);
});

test("dispatch auto-removes the worktree and branch when there were zero commits and zero violations", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();
	const worktreeRoot = await tempWorktreeStagingRoot();
	const env = { ...process.env, HER_DISPATCH_WORKTREE_ROOT: worktreeRoot };

	const result = await runDispatch({
		cwd,
		env,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: async () => okStub(),
	});

	assert.equal(result.status, "completed");
	assert.equal(result.commits, 0);
	assert.deepEqual(result.violations, []);
	assert.equal(result.branch, undefined);
	assert.equal(result.worktreePath, undefined);

	const worktreeList = (await git(cwd, "worktree", "list", "--porcelain")).stdout;
	assert.ok(!worktreeList.includes(result.dispatchId), "expected the zero-commit worktree to be auto-removed");
	const branches = (await git(cwd, "branch", "--list", `dispatch/${result.dispatchId}`)).stdout.trim();
	assert.equal(branches, "", "expected the zero-commit dispatch branch to be auto-deleted");
});

test("dispatch keeps the worktree and branch when there ARE violations, even with zero commits", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();
	const worktreeRoot = await tempWorktreeStagingRoot();
	const env = { ...process.env, HER_DISPATCH_WORKTREE_ROOT: worktreeRoot };

	const bareRemote = await mkdtemp(join(tmpdir(), "her-dispatch-remote-"));
	await git(bareRemote, "init", "-q", "--bare");
	await git(cwd, "remote", "add", "origin", bareRemote);
	await git(cwd, "push", "-q", "-u", "origin", "HEAD");

	const result = await runDispatch({
		cwd,
		env,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: async (opts) => {
			await git(opts.cwd, "push", "-q", "origin", "HEAD");
			return okStub();
		},
	});

	assert.equal(result.status, "completed-with-violations");
	assert.equal(result.commits, 0);
	assert.ok(result.violations.length > 0);
	assert.ok(result.worktreePath, "expected the worktree to survive when there were violations");
	assert.ok(existsSync(result.worktreePath ?? ""));
});

test("dispatch completion succeeds via retry when the store lock is contended by another writer", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();
	const worktreeRoot = await tempWorktreeStagingRoot();

	// Simulate another writer holding the store lock; released partway through the retry window so
	// the first attempt (short per-attempt timeout) fails but a later retry succeeds.
	const lockPath = join(memoryDir, ".her", "lock");
	await mkdir(join(memoryDir, ".her"), { recursive: true });
	await writeFile(
		lockPath,
		`${JSON.stringify({ at: Date.now() / 1000, host: "other-host", owner: "other-writer", pid: 999999 })}\n`,
		"utf8",
	);
	setTimeout(() => {
		rm(lockPath, { force: true }).catch(() => undefined);
	}, 800);

	const result = await runDispatch({
		cwd,
		env: {
			...process.env,
			HER_DISPATCH_WORKTREE_ROOT: worktreeRoot,
			HER_DISPATCH_COMPLETION_LOCK_TIMEOUT_MS: "500",
			HER_DISPATCH_COMPLETION_LOCK_RETRIES: "3",
		},
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: async () => okStub(),
	});

	assert.equal(result.status, "completed");
	const tasks = await listLongTasks(memoryDir);
	assert.equal(tasks.length, 1);
	assert.equal(tasks[0].status, "completed");
});

test("dispatch records executor provenance on the episodic capture; absent fields never appear when not dispatched", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	const result = await runDispatch({
		cwd,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: async () => okStub(),
	});

	const rawDir = join(memoryDir, "episodic", "raw");
	const rawFiles = (await readdir(rawDir)).filter((name) => name.endsWith(".md"));
	assert.equal(rawFiles.length, 1);
	const raw = await readText(join(rawDir, rawFiles[0]));
	const parsed = parseFrontmatter(raw);
	assert.equal(parsed.data.executor, "pi:deepseek");
	assert.equal(parsed.data.handoff, handoffPath);
	assert.equal(parsed.data.dispatch_id, result.dispatchId);
	assert.equal(parsed.data.provenance, "her-observed");
});

test("dispatch injects the ground-rules block into the executor prompt", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff("# Task\n\nDo not touch pi core.\n");

	let capturedPrompt = "";
	await runDispatch({
		cwd,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		spawnExecutor: async (opts) => {
			capturedPrompt = opts.prompt;
			return okStub();
		},
	});

	assert.ok(capturedPrompt.includes(DISPATCH_GROUND_RULES));
	assert.match(capturedPrompt, /Do not touch pi core\./);
});

test("dispatch kills a hanging executor and records timed-out", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	const result = await runDispatch({
		cwd,
		executor: "pi:deepseek",
		handoffPath,
		memoryDir,
		timeoutMin: 0.001,
		spawnExecutor: async () => {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
			return okStub();
		},
	});

	assert.equal(result.status, "timed-out");
	const tasks = await listLongTasks(memoryDir);
	assert.equal(tasks[0].status, "completed");
	const record = await readText(join(memoryDir, tasks[0].path));
	assert.match(record ?? "", /timed-out/);
});

test("dispatch loudly rejects a missing handoff file", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();

	await assert.rejects(
		() =>
			runDispatch({
				cwd,
				executor: "pi:deepseek",
				handoffPath: join(cwd, "does-not-exist.md"),
				memoryDir,
				spawnExecutor: async () => okStub(),
			}),
		/handoff file not found or empty/,
	);
});

test("dispatch loudly rejects an empty handoff file", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff("   \n\n  ");

	await assert.rejects(
		() =>
			runDispatch({
				cwd,
				executor: "pi:deepseek",
				handoffPath,
				memoryDir,
				spawnExecutor: async () => okStub(),
			}),
		/handoff file not found or empty/,
	);
});

test("dispatch loudly rejects an unknown executor", async () => {
	const memoryDir = await tempMemoryStore();
	const cwd = await tempGitRepo();
	const handoffPath = await tempHandoff();

	await assert.rejects(
		() =>
			runDispatch({
				cwd,
				executor: "claude-code",
				handoffPath,
				memoryDir,
				spawnExecutor: async () => okStub(),
			}),
		/unknown executor/,
	);
});

test("resolvePiCliPath resolves the real pi CLI regardless of the executor's --cwd", async () => {
	// The pi CLI lives in the samantha monorepo, not in whatever repo --cwd points at
	// (a dispatch target can be any other checkout). Resolution must not depend on cwd.
	const resolved = resolvePiCliPath({});
	assert.ok(existsSync(resolved), `expected pi CLI to exist at ${resolved}`);
	assert.match(resolved.replace(/\\/g, "/"), /packages\/coding-agent\/dist\/cli\.js$/);
});

test("resolvePiCliPath honors HER_DISPATCH_PI_CLI override relative to the samantha repo root", async () => {
	const resolved = resolvePiCliPath({ HER_DISPATCH_PI_CLI: "packages/coding-agent/dist/cli.js" });
	assert.ok(existsSync(resolved));
});

test("resolvePiCliPath rejects an absolute HER_DISPATCH_PI_CLI override outside the repo", () => {
	assert.throws(
		() => resolvePiCliPath({ HER_DISPATCH_PI_CLI: join(tmpdir(), "evil-pi.js") }),
		/HER_DISPATCH_PI_CLI.*outside/i,
	);
});

test("resolvePiCliPath rejects parent-directory escape", () => {
	assert.throws(() => resolvePiCliPath({ HER_DISPATCH_PI_CLI: "../evil-pi.js" }), /HER_DISPATCH_PI_CLI.*outside/i);
});

test("estimateUsdFromNdjson reads the settled message.usage.cost.total pi actually emits", () => {
	// Shape captured from a real `pi --print --mode json` deepseek run: usage lives under
	// message.usage, cost is nested at usage.cost.total (not top-level output_tokens/input_tokens).
	const ndjson = [
		JSON.stringify({ type: "message_start", message: { role: "assistant", usage: { cost: { total: 0 } } } }),
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 16391, output: 13, cost: { input: 0.00713, output: 0.0000113, total: 0.0071414 } },
			},
		}),
	].join("\n");
	assert.equal(estimateUsdFromNdjson(ndjson), 0.007141);
});

test("estimateUsdFromNdjson returns undefined for stub output with no usage at all", () => {
	assert.equal(estimateUsdFromNdjson(""), undefined);
	assert.equal(estimateUsdFromNdjson("not json\nalso not json"), undefined);
});
