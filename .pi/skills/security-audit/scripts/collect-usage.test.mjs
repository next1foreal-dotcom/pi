import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { artifactsDir, collectUsage, sessionSlug } from "./collect-usage.mjs";

// The slug rule is not documented anywhere — it was read off the real session
// directories. So the test targets those real names: if pi ever changes the
// rule, this fails here instead of surfacing as "no artifacts dir" in the
// middle of a run's accounting.
test("slugs a project path the way pi's own session directories are named", () => {
	assert.equal(sessionSlug(String.raw`C:\Users\Admin`), "--C--Users-Admin--");
	assert.equal(sessionSlug(String.raw`D:\@Her\Her-repo\samantha`), "--D--@Her-Her-repo-samantha--");
});

test("the derived artifacts directory is the one that actually exists", () => {
	const dir = artifactsDir(String.raw`D:\@Her\Her-repo\samantha`);
	if (!existsSync(join(homedir(), ".pi", "agent", "sessions"))) {
		console.log("no pi sessions on this machine — path derivation unverified against reality");
		return;
	}
	assert.ok(existsSync(dir), `derived path should exist: ${dir}`);
});

test("reads real subagent meta files and totals their usage", () => {
	const result = collectUsage(String.raw`D:\@Her\Her-repo\samantha`);
	if (!result.available) {
		console.log(`artifacts dir unavailable (${result.reason}) — collector unverified against real records`);
		return;
	}
	assert.ok(result.agents > 0, "found at least one child record");
	assert.ok(result.withUsage > 0, "at least one record carries usage");
	// A collector that returns records but zero cost has silently lost the
	// column the ledger exists for.
	assert.ok(result.totals.input > 0, "input tokens summed");
	assert.ok(result.totals.cost > 0, "cost summed");
	for (const record of result.records) {
		if (record.unreadable) continue;
		assert.equal(typeof record.agent, "string");
		assert.equal(typeof record.durationMs, "number");
	}
});

test("a missing directory reports why instead of returning an empty run", () => {
	const result = collectUsage(String.raw`D:\no\such\project\anywhere`);
	assert.equal(result.available, false);
	assert.match(result.reason, /ENOENT/);
	assert.deepEqual(result.records, []);
});
