import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { listHerEvents } from "../src/her-core/event-history.ts";
import { readSelfmodRecords, runSelfMod } from "../src/her-core/selfmod.ts";
import { acquireSelfmodLock } from "../src/her-core/selfmod-lock.ts";
import { runSelfmodPickup } from "../src/her-core/selfmod-pickup.ts";
import { destroyFixture, git, greenHooks, makeFixture, proposalFor, SKILL_REL, writeRel } from "./selfmod-harness.ts";

function skillTouchPatch(rel = SKILL_REL): string {
	return [
		`diff --git a/${rel} b/${rel}`,
		`--- a/${rel}`,
		`+++ b/${rel}`,
		"@@ -1,2 +1,3 @@",
		" # fixture",
		" hello",
		"+# touch",
		"",
	].join("\n");
}

async function writeInbox(memoryDir: string, name: string, body: unknown): Promise<string> {
	const inbox = join(memoryDir, "proposals", "selfmod");
	await mkdir(inbox, { recursive: true });
	const path = join(inbox, name);
	await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
	return path;
}

test("patch-carrying proposal applies and merges into the host tree", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("ap-ok");
	try {
		await mkdir(join(fx.memoryDir, "evals"), { recursive: true });
		await writeFile(join(fx.memoryDir, "evals", "fail.md"), "real failure\n");
		const proposal = proposalFor(fx, {
			motivation: { kind: "failure-anchored", evidenceRef: "evals/fail.md" },
			patch: skillTouchPatch(),
		});
		await writeInbox(fx.memoryDir, "alpha.json", proposal);
		const result = await runSelfmodPickup({
			hooks: greenHooks,
			memoryDir: fx.memoryDir,
			now: new Date("2026-08-18T12:00:00.000Z"),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.action, "ran");
		assert.equal(result.outcome, "merged");
		const merged = (await readFile(join(fx.repoRoot, ...SKILL_REL.split("/")), "utf8")).includes("# touch");
		assert.equal(merged, true);
		const tags = (await git(fx.repoRoot, "tag", "-l", `selfmod/${fx.id}`)).stdout.trim();
		assert.notEqual(tags, "");
	} finally {
		await destroyFixture(fx);
	}
});

test(
	"failure-anchored proposal with no patch is invalid and never enters the pipeline",
	{ timeout: 60_000 },
	async () => {
		const fx = await makeFixture("ap-nopatch");
		try {
			await mkdir(join(fx.memoryDir, "evals"), { recursive: true });
			await writeFile(join(fx.memoryDir, "evals", "fail.md"), "real failure\n");
			await writeInbox(
				fx.memoryDir,
				"bare.json",
				proposalFor(fx, { motivation: { kind: "failure-anchored", evidenceRef: "evals/fail.md" } }),
			);
			const notices: string[] = [];
			const result = await runSelfmodPickup({
				hooks: greenHooks,
				memoryDir: fx.memoryDir,
				now: new Date("2026-08-18T12:00:00.000Z"),
				repoRoot: fx.repoRoot,
				sendNotify: async (text) => {
					notices.push(text);
				},
				worktreeRoot: fx.worktreeRoot,
			});
			assert.equal(result.action, "invalid");
			assert.match(result.reason ?? "", /proposal carries no patch/);
			assert.ok(notices.some((text) => /proposal carries no patch/.test(text)));
			const rows = await readSelfmodRecords(fx.memoryDir);
			assert.equal(rows.filter((row) => row.stage === "worktree" || row.stage === "merge").length, 0);
		} finally {
			await destroyFixture(fx);
		}
	},
);

test("malformed patch is rejected with the git error on the ledger", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("ap-bad");
	try {
		const result = await runSelfMod({
			hooks: greenHooks,
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx, { patch: "this is not a unified diff\n" }),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.outcome, "rejected");
		assert.equal(result.record.stage, "rejected");
		assert.equal(result.record.mergeCommit, undefined);
		const events = await listHerEvents(fx.memoryDir, { kind: "selfmod.transition" });
		const rejected = events.find((event) => event.data?.stage === "rejected");
		assert.ok(rejected, "rejected transition must exist");
		assert.match(String(rejected?.data?.error ?? ""), /git|apply|patch|corrupt|error/i);
		const last = (await readSelfmodRecords(fx.memoryDir)).at(-1);
		assert.equal(last?.stage, "rejected");
	} finally {
		await destroyFixture(fx);
	}
});

test("patch touching a non-owned skill is rejected at the gate", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("ap-unowned");
	try {
		const other = "packages/her/pi-package/skills/other-skill/SKILL.md";
		await writeRel(fx.repoRoot, other, "# other\nhello\n");
		await git(fx.repoRoot, "add", other);
		await git(fx.repoRoot, "commit", "-q", "-m", "add other skill");
		const patch = [
			`diff --git a/${other} b/${other}`,
			`--- a/${other}`,
			`+++ b/${other}`,
			"@@ -1,2 +1,3 @@",
			" # other",
			" hello",
			"+# sneak",
			"",
		].join("\n");
		const result = await runSelfMod({
			hooks: greenHooks,
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx, { patch, targetPaths: [SKILL_REL] }),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.outcome, "rejected");
		assert.equal(result.record.stage, "rejected");
		assert.equal(result.record.mergeCommit, undefined);
		assert.equal(result.record.gate?.anchorScanClean, false);
	} finally {
		await destroyFixture(fx);
	}
});

test("patch creating a new skill directory is rejected", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("ap-newdir");
	try {
		const created = "packages/her/pi-package/skills/brand-new/SKILL.md";
		const patch = [
			`diff --git a/${created} b/${created}`,
			"new file mode 100644",
			"--- /dev/null",
			`+++ b/${created}`,
			"@@ -0,0 +1,2 @@",
			"+# brand new",
			"+hello",
			"",
		].join("\n");
		const result = await runSelfMod({
			hooks: greenHooks,
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx, { patch, targetPaths: [SKILL_REL] }),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.outcome, "rejected");
		assert.equal(result.record.stage, "rejected");
		assert.equal(result.record.mergeCommit, undefined);
	} finally {
		await destroyFixture(fx);
	}
});

test("empty diff is rejected and never tagged", { timeout: 60_000 }, async () => {
	const fx = await makeFixture("ap-empty");
	try {
		const result = await runSelfMod({
			hooks: greenHooks,
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.outcome, "rejected");
		assert.equal(result.record.stage, "rejected");
		assert.equal(result.record.mergeCommit, undefined);
		const events = await listHerEvents(fx.memoryDir, { kind: "selfmod.transition" });
		const rejected = events.find((event) => event.data?.stage === "rejected");
		assert.ok(rejected);
		assert.match(String(rejected?.data?.error ?? ""), /empty diff/);
		const tags = (await git(fx.repoRoot, "tag", "-l", `selfmod/${fx.id}`)).stdout.trim();
		assert.equal(tags, "");
	} finally {
		await destroyFixture(fx);
	}
});

test("two overlapping lock acquisitions: exactly one wins", async () => {
	const fx = await makeFixture("ap-lock");
	try {
		const now = new Date("2026-08-18T12:00:00.000Z");
		const [a, b] = await Promise.all([
			acquireSelfmodLock({ by: "a", memoryDir: fx.memoryDir, now }),
			acquireSelfmodLock({ by: "b", memoryDir: fx.memoryDir, now }),
		]);
		const wins = [a, b].filter((row) => row.acquired);
		assert.equal(wins.length, 1);
		assert.equal([a, b].filter((row) => !row.acquired).length, 1);
	} finally {
		await destroyFixture(fx);
	}
});
