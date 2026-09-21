import assert from "node:assert/strict";
import test from "node:test";
import { createTaskContextSnapshot, taskContextSnapshotTokens } from "../src/her-core/task-context-snapshot.ts";
import { evaluateTaskRoute } from "../src/her-core/task-route.ts";
import { parseWorkers } from "../src/her-core/worker-profile.ts";

test("route accounts for reload cost, cache affinity, and privacy boundary", () => {
	const snapshot = createTaskContextSnapshot({ objective: "review", brief: "same frozen input", privacy: "private" });
	const tokens = taskContextSnapshotTokens(snapshot);
	const cold = evaluateTaskRoute({
		worker: "remote",
		model: "m1",
		privacy: snapshot.privacy,
		contextSnapshotTokens: tokens,
	});
	assert.equal(cold.allowed, false);
	assert.equal(cold.cacheAffinity, "cold");
	assert.equal(cold.contextReloadTokens, tokens);

	const warm = evaluateTaskRoute({
		worker: "local",
		model: "m1",
		privacy: snapshot.privacy,
		privacyBoundary: "local",
		contextSnapshotTokens: tokens,
		parentWorker: "local",
	});
	assert.equal(warm.allowed, true);
	assert.equal(warm.cacheAffinity, "warm");
	assert.ok(warm.contextReloadTokens < cold.contextReloadTokens);
});

test("worker privacy boundary is explicit and invalid values fail loud", () => {
	const parsed = parseWorkers('workers:\n  local:\n    argv: ["node"]\n    privacy_boundary: local\n');
	assert.equal(parsed.local?.privacyBoundary, "local");
	assert.throws(
		() => parseWorkers('workers:\n  bad:\n    argv: ["node"]\n    privacy_boundary: trusted-ish\n'),
		/privacy_boundary/,
	);
});
