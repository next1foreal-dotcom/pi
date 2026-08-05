import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	acceptanceRunFilename,
	EVIDENCE_GATE_NAME,
	evaluateTaskAcceptance,
	gatePlanFilename,
} from "../src/her-core/bg-task-acceptance.ts";
import { spawnBgTask, stopBgTask } from "../src/her-core/bg-task-spawn.ts";
import { loadBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { resolveWorkerModel } from "../src/her-core/worker-profile.ts";

async function memoryRoot(config = ""): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g225-model-"));
	await mkdir(tasksDir(root), { recursive: true });
	await writeFile(join(root, ".her", "config.yaml"), config, "utf8");
	return root;
}

test("G-225 resolveWorkerModel records declared model ids", () => {
	assert.equal(resolveWorkerModel(["codex", "exec", "-m", "gpt-5.6-terra", "-"]), "gpt-5.6-terra");
	assert.equal(resolveWorkerModel(["claude", "-p", "--permission-mode", "acceptEdits"]), "unknown");
	assert.equal(resolveWorkerModel(["worker", "--model=gpt-5.6-luna"]), "gpt-5.6-luna");
	assert.equal(resolveWorkerModel(["worker", "--model", "gpt-5.6-luna"]), "gpt-5.6-luna");
});

test("G-225 malformed -m followed by a flag is unknown", () => {
	assert.equal(resolveWorkerModel(["codex", "exec", "-m", "--sandbox", "workspace-write"]), "unknown");
});

test("G-225 spawn persists model states and envelope values", async () => {
	const root = await memoryRoot(
		["workers:", "  fake:", `    argv: ["${process.execPath}", "-e", "setTimeout(()=>{})"]`, "tasks:", "  budget_daily_cap: 999", ""].join("\n"),
	);
	const worker = await spawnBgTask(root, { objective: "worker model", worker: "fake", brief: "x", skipGates: true });
	assert.equal(worker.status, "running");
	if (worker.status !== "running") return;
	assert.equal((await loadBgTask(root, worker.id))?.record.model, "unknown");
	await stopBgTask(root, worker.id);

	const command = await spawnBgTask(root, {
		objective: "command model",
		command: [process.execPath, "-e", "setTimeout(()=>{})"],
		skipGates: true,
	});
	assert.equal(command.status, "running");
	if (command.status !== "running") return;
	assert.equal((await loadBgTask(root, command.id))?.record.model, null);
	const envelope = (await readFile(join(root, "runs", "events.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { bgTaskId?: string; model?: string | null });
	assert.equal(envelope.find((event) => event.bgTaskId === worker.id)?.model, "unknown");
	assert.equal(envelope.find((event) => event.bgTaskId === command.id)?.model, null);
	await stopBgTask(root, command.id);
});

test("G-225 result.md read failure is rejected and not treated as missing", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-g225-read-failure-"));
	const taskId = "t-g225-read-failure";
	const command = [process.execPath, "-e", "0"];
	await writeFile(
		join(root, gatePlanFilename(taskId)),
		JSON.stringify({ source: "task", gates: [{ name: EVIDENCE_GATE_NAME, type: "evidence-verified", command }] }),
		"utf8",
	);
	await writeFile(
		join(root, acceptanceRunFilename(taskId)),
		JSON.stringify({
			gates: [{ name: EVIDENCE_GATE_NAME, command, exitCode: 0, outputDigest: "sha256:evidence", outputBytes: 0, outputHead: "", logPath: `${taskId}.log`, durationMs: 1 }],
			startedAt: "2026-08-05T00:00:00.000Z",
			endedAt: "2026-08-05T00:00:01.000Z",
		}),
		"utf8",
	);
	await mkdir(join(root, `${taskId}.result.md`));
	const outcome = await evaluateTaskAcceptance({ taskDir: root, taskId, workerCwd: root });
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	const detail = outcome.reasons.map((reason) => reason.detail).join("\n");
	assert.match(detail, /read failed/i);
	assert.doesNotMatch(detail, /result file is absent/i);
});