import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBgTask } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask, stopBgTask } from "../src/her-core/bg-task-spawn.ts";

test("background spawn rejects an identical subgoal on the same revision unless explicitly rerun", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-subgoal-dedupe-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	const input = {
		objective: "Inspect the same route",
		command: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
		skipGates: true,
		heartbeatMs: 1000,
	};

	const first = await spawnBgTask(root, input);
	assert.equal(first.status, "running");
	if (first.status !== "running") return;
	await assert.rejects(() => spawnBgTask(root, input), new RegExp(`duplicate subgoal already exists: ${first.id}`));

	const rerun = await spawnBgTask(root, { ...input, allowDuplicate: true });
	assert.equal(rerun.status, "running");
	if (rerun.status !== "running") return;
	const firstRecord = await loadBgTask(root, first.id);
	const rerunRecord = await loadBgTask(root, rerun.id);
	assert.equal(firstRecord?.record.subgoalKey, rerunRecord?.record.subgoalKey);
	assert.match(String(firstRecord?.record.subgoalRevision), /^(?:[0-9a-f]{40}|unversioned)$/);

	await stopBgTask(root, first.id);
	await stopBgTask(root, rerun.id);
});
