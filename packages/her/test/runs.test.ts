import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initStore, startLongTask } from "../src/her-core/index.ts";
import { appendHerRunEvent, listHerRunSnapshots } from "../src/her-core/runs.ts";

test("appendHerRunEvent keeps latest status per runId", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-runs-"));
	await appendHerRunEvent(root, {
		runId: "run-a",
		status: "queued",
		kind: "build",
		source: "studio",
		title: "make a button",
		at: "2026-07-25T10:00:00.000Z",
		piSessionId: "ws-1",
	});
	await appendHerRunEvent(root, {
		runId: "run-a",
		status: "running",
		kind: "build",
		source: "studio",
		title: "make a button",
		at: "2026-07-25T10:00:01.000Z",
		piSessionId: "ws-1",
	});
	await appendHerRunEvent(root, {
		runId: "run-b",
		status: "running",
		kind: "longtask",
		source: "voice",
		title: "write countdown",
		at: "2026-07-25T10:01:00.000Z",
		goalId: "goal-1",
	});
	const snaps = await listHerRunSnapshots(root);
	assert.equal(snaps.length, 2);
	const a = snaps.find((s) => s.runId === "run-a");
	assert.equal(a?.status, "running");
	assert.equal(a?.startedAt, "2026-07-25T10:00:00.000Z");
	const raw = await readFile(join(root, "runs", "events.jsonl"), "utf8");
	assert.equal(raw.trim().split("\n").length, 3);
});

test("startLongTask run envelope includes parentRunId from HER_ORCHESTRATOR_RUN_ID", async () => {
	const prevParent = process.env.HER_ORCHESTRATOR_RUN_ID;
	const prevSource = process.env.HER_RUN_SOURCE;
	process.env.HER_ORCHESTRATOR_RUN_ID = "voice-orchestrator-parent";
	process.env.HER_RUN_SOURCE = "voice";
	try {
		const root = await mkdtemp(join(tmpdir(), "her-runs-parent-"));
		await initStore(root);
		await startLongTask(root, { objective: "link parent run", source: "voice" });
		const snaps = await listHerRunSnapshots(root);
		assert.equal(snaps.length, 1);
		assert.equal(snaps[0]?.parentRunId, "voice-orchestrator-parent");
		assert.equal(snaps[0]?.source, "voice");
	} finally {
		if (prevParent === undefined) delete process.env.HER_ORCHESTRATOR_RUN_ID;
		else process.env.HER_ORCHESTRATOR_RUN_ID = prevParent;
		if (prevSource === undefined) delete process.env.HER_RUN_SOURCE;
		else process.env.HER_RUN_SOURCE = prevSource;
	}
});
