import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DISPATCH_GROUND_RULES, type DispatchExecutorResult, runDispatch } from "../src/her-core/dispatch.ts";
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
