import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { acceptanceRunFilename } from "../src/her-core/bg-task-acceptance.ts";
import type { BgTaskRecord } from "../src/her-core/bg-task-record.ts";
import { loadBgTask, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask } from "../src/her-core/bg-task-spawn.ts";
import {
	appendTaskEvidenceSnapshot,
	loadOrCreateTaskEvidenceSnapshot,
	shareTaskEvidenceSnapshot,
	taskEvidenceSnapshotPath,
} from "../src/her-core/task-evidence-snapshot.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execFileAsync("git", args, { cwd });
}

test("completed worktree evidence is immutable, shared, and rejected when stale", async () => {
	const memory = await mkdtemp(join(tmpdir(), "her-evidence-memory-"));
	const worktree = await mkdtemp(join(tmpdir(), "her-evidence-worktree-"));
	await mkdir(tasksDir(memory), { recursive: true });
	await git(worktree, "init");
	await git(worktree, "config", "user.name", "Her Test");
	await git(worktree, "config", "user.email", "her-test@example.com");
	await writeFile(join(worktree, "source.ts"), "export const answer = 1;\n", "utf8");
	await git(worktree, "add", "source.ts");
	await git(worktree, "commit", "-m", "base");
	await writeFile(join(worktree, "source.ts"), "export const answer = 2;\n", "utf8");
	await writeFile(join(worktree, "new.ts"), "export const added = true;\n", "utf8");

	const taskId = "t-evidence-v2";
	await writeFile(
		join(tasksDir(memory), acceptanceRunFilename(taskId)),
		JSON.stringify({
			gates: [
				{
					name: "focused-test",
					command: ["node", "--test"],
					exitCode: 0,
					outputDigest: "sha256:test-pass",
					outputBytes: 12,
					outputHead: "pass",
					logPath: "focused-test.log",
					durationMs: 10,
				},
			],
			startedAt: "2026-09-21T00:00:00.000Z",
			endedAt: "2026-09-21T00:00:01.000Z",
		}),
		"utf8",
	);
	const record = {
		id: taskId,
		status: "completed",
		objective: "implement evidence",
		worker: "codex",
		command: ["codex"],
		mode: "worker",
		created: "2026-09-21T00:00:00.000Z",
		updated: "2026-09-21T00:00:01.000Z",
		endedAt: "2026-09-21T00:00:01.000Z",
		retries: 0,
		host: "test",
		worktree,
	} satisfies BgTaskRecord;

	const snapshot = await loadOrCreateTaskEvidenceSnapshot(memory, record);
	assert.equal(snapshot.version, "task-evidence-v2");
	assert.ok(snapshot.files.some((file) => file.path === "source.ts" && file.digest));
	assert.ok(snapshot.files.some((file) => file.path === "new.ts" && file.digest));
	assert.deepEqual(
		snapshot.tests.map((receipt) => [receipt.name, receipt.exitCode]),
		[["focused-test", 0]],
	);
	assert.match(appendTaskEvidenceSnapshot("review this", snapshot), /sha256:test-pass/);

	await shareTaskEvidenceSnapshot(memory, "t-reviewer", snapshot);
	assert.equal(
		await readFile(taskEvidenceSnapshotPath(memory, taskId), "utf8"),
		await readFile(taskEvidenceSnapshotPath(memory, "t-reviewer"), "utf8"),
	);

	const workerScript = join(memory, "echo-brief.mjs");
	await writeFile(
		workerScript,
		"const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks)));",
		"utf8",
	);
	const workerConfig = `workers:\n  fake:\n    argv: [${JSON.stringify(process.execPath)}, ${JSON.stringify(workerScript)}]\n`;
	await writeFile(join(memory, ".her", "config.yaml"), workerConfig, "utf8");
	await saveBgTask(memory, record, "# completed parent\n");
	const review = await spawnBgTask(memory, {
		objective: "review completed evidence",
		worker: "fake",
		brief: "review the implementation",
		parentTask: taskId,
		skipGates: true,
		heartbeatMs: 1000,
	});
	assert.equal(review.status, "running");
	if (review.status !== "running") return;
	const reviewRecord = await loadBgTask(memory, review.id);
	assert.equal(reviewRecord?.record.evidenceSnapshotId, snapshot.id);
	assert.match(await readFile(join(tasksDir(memory), `${review.id}.brief`), "utf8"), /TASK EVIDENCE SNAPSHOT/);
	assert.equal(
		await readFile(taskEvidenceSnapshotPath(memory, taskId), "utf8"),
		await readFile(taskEvidenceSnapshotPath(memory, review.id), "utf8"),
	);

	await writeFile(join(worktree, "new.ts"), "export const added = false;\n", "utf8");
	await assert.rejects(() => loadOrCreateTaskEvidenceSnapshot(memory, record), /snapshot is stale/);
});
