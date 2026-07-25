import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
