import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initStore, startLongTask } from "../src/her-core/index.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-long-task-"));
	await initStore(root);
	return root;
}

test("startLongTask gives two concurrent same-objective calls distinct ids", async () => {
	const store = await tempStore();
	// Reproduce the F-38 T3 race precisely: identical objective AND identical timestamp is exactly
	// what two runDispatch() calls produce when they land in the same low-resolution Windows timer
	// tick (Date.now() ~15.6ms granularity) with the same handoff text. dispatch.ts derives the git
	// worktree path and `dispatch/<id>` branch from this id, so a collision makes the second dispatch's
	// `git worktree add` fail outright. The id must stay unique even for identical-objective calls.
	const now = "2026-07-04T12:00:00.000Z";
	const objective = "Ship the concurrent widget";

	const [a, b] = await Promise.all([
		startLongTask(store, { now, objective }),
		startLongTask(store, { now, objective }),
	]);

	assert.notEqual(a.id, b.id, "concurrent same-objective long tasks must not share a dispatch id");
});
