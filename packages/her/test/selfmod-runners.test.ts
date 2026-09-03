import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultRunEvalFixtures, defaultRunTests, SELFMOD_GATE_TEST_FILES } from "../src/her-core/selfmod-runners.ts";
import { SKILL_REL } from "./selfmod-harness.ts";

async function tempDir(slug: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `her-g281-${slug}-`));
}

function proposal(over: { evidenceRef?: string } = {}) {
	return {
		id: "selfmod-20260818-eval",
		createdAt: "2026-08-18T00:00:00.000Z",
		motivation: { kind: "failure-anchored" as const, evidenceRef: over.evidenceRef ?? "evals/fail.md" },
		targetPaths: [SKILL_REL],
		planSummary: "touch skill",
	};
}

test("SELFMOD_GATE_TEST_FILES lists the pinned cage plus the four sibling families", () => {
	const files = [...SELFMOD_GATE_TEST_FILES];
	assert.ok(files.length > 0);
	assert.ok(files.every((file) => file.startsWith("packages/her/test/")));
	assert.ok(files.some((file) => /selfmod.*\.test\.ts$/.test(file)));
	assert.ok(files.some((file) => file.endsWith("anchor-commit-gate.test.ts")));
	assert.ok(files.some((file) => file.endsWith("anchor-tool-call.test.ts")));
	assert.ok(files.some((file) => file.endsWith("governed-tools-failsafe.test.ts")));
	assert.ok(files.some((file) => file.endsWith("rsi-anchors.test.ts")));
});

test("defaultRunTests spawns node --import tsx --test with the pinned file list", async () => {
	const calls: Array<{ args: string[]; cmd: string; cwd: string }> = [];
	const result = await defaultRunTests("/tmp/wt", [], async (cmd, args, opts) => {
		calls.push({ cmd, args: [...args], cwd: opts.cwd });
		return { code: 0 };
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].cmd, "node");
	assert.equal(calls[0].cwd, "/tmp/wt");
	assert.deepEqual(calls[0].args.slice(0, 3), ["--import", "tsx", "--test"]);
	assert.deepEqual(calls[0].args.slice(3), [...SELFMOD_GATE_TEST_FILES]);
	assert.equal(result.failed, 0);
	assert.ok(result.passed >= 1);
});

test("defaultRunTests rejects a non-zero run with the exit code and the stderr tail, so the gate ledger carries a reason", async () => {
	await assert.rejects(
		defaultRunTests("/tmp/wt", [], async () => ({
			code: 7,
			stderr: "...lots of output..." + " assertion boom at anchor-commit-gate.test.ts:242",
		})),
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			assert.match(message, /exit 7/);
			assert.match(message, /assertion boom at anchor-commit-gate\.test\.ts:242/);
			return true;
		},
	);
});

test("defaultRunTests lets a thrown spawn propagate with its own message", async () => {
	await assert.rejects(
		defaultRunTests("/tmp/wt", [], async () => {
			throw new Error("spawn exploded");
		}),
		/spawn exploded/,
	);
});

test("zero eval fixture files is fail-closed", async () => {
	const memoryDir = await tempDir("nofixtures");
	await mkdir(join(memoryDir, "evals", "selfmod-gate"), { recursive: true });
	const ok = await defaultRunEvalFixtures({
		memoryDir,
		proposal: proposal(),
		worktreePath: memoryDir,
		listDiff: async () => [SKILL_REL],
		readWorktreeFile: async () => "---\nname: fixture\n",
		statWorktreeFile: async () => ({ bytes: 20 }),
		diffNumstat: async () => ({ added: 1, deleted: 0 }),
	});
	assert.equal(ok, false);
});

test("skill-shape green when touched skill is a legal SKILL.md under the size cap", async () => {
	const memoryDir = await tempDir("skill-ok");
	const fixtureDir = join(memoryDir, "evals", "selfmod-gate");
	await mkdir(fixtureDir, { recursive: true });
	await writeFile(join(fixtureDir, "shape.json"), `${JSON.stringify({ kind: "skill-shape", maxBytes: 200 })}\n`);
	const ok = await defaultRunEvalFixtures({
		memoryDir,
		proposal: proposal(),
		worktreePath: memoryDir,
		listDiff: async () => [SKILL_REL],
		readWorktreeFile: async () => "---\nname: fixture\nhello\n",
		statWorktreeFile: async () => ({ bytes: 24 }),
		diffNumstat: async () => ({ added: 1, deleted: 0 }),
	});
	assert.equal(ok, true);
});

test("skill-shape red when the touched skill is empty, oversized, or missing name", async () => {
	const memoryDir = await tempDir("skill-bad");
	const fixtureDir = join(memoryDir, "evals", "selfmod-gate");
	await mkdir(fixtureDir, { recursive: true });
	await writeFile(join(fixtureDir, "shape.json"), `${JSON.stringify({ kind: "skill-shape", maxBytes: 20 })}\n`);
	const empty = await defaultRunEvalFixtures({
		memoryDir,
		proposal: proposal(),
		worktreePath: memoryDir,
		listDiff: async () => [SKILL_REL],
		readWorktreeFile: async () => "",
		statWorktreeFile: async () => ({ bytes: 0 }),
		diffNumstat: async () => ({ added: 1, deleted: 0 }),
	});
	assert.equal(empty, false);
	const big = await defaultRunEvalFixtures({
		memoryDir,
		proposal: proposal(),
		worktreePath: memoryDir,
		listDiff: async () => [SKILL_REL],
		readWorktreeFile: async () => "---\nname: fixture\n",
		statWorktreeFile: async () => ({ bytes: 99 }),
		diffNumstat: async () => ({ added: 1, deleted: 0 }),
	});
	assert.equal(big, false);
	const unnamed = await defaultRunEvalFixtures({
		memoryDir,
		proposal: proposal(),
		worktreePath: memoryDir,
		listDiff: async () => ["packages/her/pi-package/skills/fixture/note.md"],
		readWorktreeFile: async () => "no header here\n",
		statWorktreeFile: async () => ({ bytes: 10 }),
		diffNumstat: async () => ({ added: 1, deleted: 0 }),
	});
	assert.equal(unnamed, false);
});

test("diff-budget green under the cap and red when added+deleted exceed it", async () => {
	const memoryDir = await tempDir("budget");
	const fixtureDir = join(memoryDir, "evals", "selfmod-gate");
	await mkdir(fixtureDir, { recursive: true });
	await writeFile(join(fixtureDir, "budget.json"), `${JSON.stringify({ kind: "diff-budget", maxLines: 200 })}\n`);
	const green = await defaultRunEvalFixtures({
		memoryDir,
		proposal: proposal(),
		worktreePath: memoryDir,
		listDiff: async () => [SKILL_REL],
		readWorktreeFile: async () => "---\nname: fixture\n",
		statWorktreeFile: async () => ({ bytes: 20 }),
		diffNumstat: async () => ({ added: 80, deleted: 20 }),
	});
	assert.equal(green, true);
	const red = await defaultRunEvalFixtures({
		memoryDir,
		proposal: proposal(),
		worktreePath: memoryDir,
		listDiff: async () => [SKILL_REL],
		readWorktreeFile: async () => "---\nname: fixture\n",
		statWorktreeFile: async () => ({ bytes: 20 }),
		diffNumstat: async () => ({ added: 180, deleted: 40 }),
	});
	assert.equal(red, false);
});

test("evidence-exists green on an in-memory file and red on missing or escaped refs", async () => {
	const memoryDir = await tempDir("evidence");
	const fixtureDir = join(memoryDir, "evals", "selfmod-gate");
	await mkdir(fixtureDir, { recursive: true });
	await mkdir(join(memoryDir, "evals"), { recursive: true });
	await writeFile(join(memoryDir, "evals", "fail.md"), "real failure\n");
	await writeFile(join(fixtureDir, "ev.json"), `${JSON.stringify({ kind: "evidence-exists" })}\n`);
	const green = await defaultRunEvalFixtures({
		memoryDir,
		proposal: proposal({ evidenceRef: "evals/fail.md" }),
		worktreePath: memoryDir,
		listDiff: async () => [],
		diffNumstat: async () => ({ added: 0, deleted: 0 }),
	});
	assert.equal(green, true);
	const missing = await defaultRunEvalFixtures({
		memoryDir,
		proposal: proposal({ evidenceRef: "evals/missing.md" }),
		worktreePath: memoryDir,
		listDiff: async () => [],
		diffNumstat: async () => ({ added: 0, deleted: 0 }),
	});
	assert.equal(missing, false);
	const escaped = await defaultRunEvalFixtures({
		memoryDir,
		proposal: proposal({ evidenceRef: "../escape.md" }),
		worktreePath: memoryDir,
		listDiff: async () => [],
		diffNumstat: async () => ({ added: 0, deleted: 0 }),
	});
	assert.equal(escaped, false);
});

test("misspelled fixture param key is fail-closed", async () => {
	const memoryDir = await tempDir("typo-param");
	const fixtureDir = join(memoryDir, "evals", "selfmod-gate");
	await mkdir(fixtureDir, { recursive: true });
	await writeFile(join(fixtureDir, "shape.json"), `${JSON.stringify({ kind: "skill-shape", maxBytesX: 200 })}\n`);
	const ok = await defaultRunEvalFixtures({
		memoryDir,
		proposal: proposal(),
		worktreePath: memoryDir,
		listDiff: async () => [SKILL_REL],
		readWorktreeFile: async () => "---\nname: fixture\nhello\n",
		statWorktreeFile: async () => ({ bytes: 24 }),
		diffNumstat: async () => ({ added: 1, deleted: 0 }),
	});
	assert.equal(ok, false);
});

test("unknown fixture kind is fail-closed", async () => {
	const memoryDir = await tempDir("unknown");
	const fixtureDir = join(memoryDir, "evals", "selfmod-gate");
	await mkdir(fixtureDir, { recursive: true });
	await writeFile(join(fixtureDir, "future.json"), `${JSON.stringify({ kind: "future-kind" })}\n`);
	const ok = await defaultRunEvalFixtures({
		memoryDir,
		proposal: proposal(),
		worktreePath: memoryDir,
		listDiff: async () => [],
		diffNumstat: async () => ({ added: 0, deleted: 0 }),
	});
	assert.equal(ok, false);
});
