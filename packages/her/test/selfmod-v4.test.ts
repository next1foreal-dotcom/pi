import assert from "node:assert/strict";
import test from "node:test";
import { runSelfMod } from "../src/her-core/selfmod.ts";
import { applySkillLine, destroyFixture, greenHooks, makeFixture, proposalFor } from "./selfmod-harness.ts";

function contention(code: "EPERM" | "EACCES" | "EBUSY"): Error & { code: string } {
	return Object.assign(new Error(code), { code });
}

test("V4: transient EPERM during gate diff read retries, warns, and does not fail the gate", async () => {
	const fx = await makeFixture("v4t");
	const warnings: string[] = [];
	const origWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(String(args[0] ?? ""));
	};
	try {
		let reads = 0;
		const result = await runSelfMod({
			hooks: {
				...greenHooks,
				apply: async ({ worktreePath }) => applySkillLine(worktreePath),
				readDiff: async () => {
					reads += 1;
					if (reads <= 2) throw contention("EPERM");
					return "+# touch\n";
				},
			},
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			retry: { attempts: 5, baseDelayMs: 1 },
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.record.stage, "merge", "transient fs contention must not reject");
		assert.equal(result.record.gate?.encodingScanClean, true);
		assert.ok(
			warnings.some((line) => /succeeded on attempt/i.test(line)),
			`expected retry warn, got: ${warnings.join(" | ")}`,
		);
	} finally {
		console.warn = origWarn;
		await destroyFixture(fx);
	}
});

test("V4: persistent EACCES during gate diff read is an honest gate failure", async () => {
	const fx = await makeFixture("v4p");
	try {
		const result = await runSelfMod({
			hooks: {
				...greenHooks,
				apply: async ({ worktreePath }) => applySkillLine(worktreePath),
				readDiff: async () => {
					throw contention("EACCES");
				},
			},
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			retry: { attempts: 3, baseDelayMs: 1 },
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.record.stage, "rejected");
		assert.equal(result.record.mergeCommit, undefined);
		assert.equal(result.record.gate?.encodingScanClean, false);
	} finally {
		await destroyFixture(fx);
	}
});
