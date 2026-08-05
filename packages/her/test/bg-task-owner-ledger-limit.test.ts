import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadExternalDeliveries } from "../src/her-core/bg-task-owner.ts";
import { runsEventsPath, runsWakeLedgerPath } from "../src/her-core/runs.ts";

test("S5-9 external delivery matching scans beyond the 200-run presentation cap", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-g185-s5-limit-"));
	await mkdir(join(root, "runs"), { recursive: true });
	const base = Date.parse("2026-08-02T00:00:00.000Z");
	const events = Array.from({ length: 201 }, (_, index) => {
		const runId = index === 0 ? "old-run" : `run-${index}`;
		return JSON.stringify({
			type: "run",
			runId,
			status: "done",
			kind: "workflow",
			source: "deer-workflow",
			title: runId,
			at: new Date(base + index * 1000).toISOString(),
			bgTaskId: index === 0 ? "old-task" : `task-${index}`,
		});
	}).join("\n");
	await writeFile(runsEventsPath(root), `${events}\n`, "utf8");
	await writeFile(
		runsWakeLedgerPath(root),
		`${JSON.stringify({
			wakeId: "old-run",
			terminalStatus: "done",
			deliveredAt: new Date(base).toISOString(),
			deliveredBy: "server-watcher",
			runId: "old-run",
		})}\n`,
		"utf8",
	);

	const delivered = await loadExternalDeliveries(root);
	assert.equal(delivered.has("old-task"), true, "old delivered runs must not fall out of the dedupe index");
});
