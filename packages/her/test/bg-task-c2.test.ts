import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { herTaskOutput } from "../src/her-core/bg-task-output.ts";
import { parseCodexSessionId, reconcileBgTasks } from "../src/her-core/bg-task-reconcile.ts";
import { type BgTaskRecord, loadBgTask, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { continueBgTask } from "../src/her-core/bg-task-spawn.ts";
import { prepareWorkerCommand, type WorkerProfile } from "../src/her-core/worker-profile.ts";

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

test("C2 worker command adds --json and -o once, without changing non-Codex profiles", () => {
	const profile: WorkerProfile = { argv: ["codex", "exec", "-"] };
	assert.deepEqual(prepareWorkerCommand("codex", profile, "C:\\tasks", "t-1"), [
		"codex",
		"exec",
		"-",
		"--json",
		"-o",
		join("C:\\tasks", "t-1.result.md"),
	]);
	assert.deepEqual(
		prepareWorkerCommand("codex", { argv: ["codex", "exec", "--json", "-o", "custom.md", "-"] }, "C:\\tasks", "t-2"),
		["codex", "exec", "--json", "-o", "custom.md", "-"],
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
		assert.deepEqual(child?.record.command, ["codex", "exec", "resume", sessionId, "remember «REDACTED:secret»"]);
	} finally {
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
	}
});
