/**
 * G-403 — shadow-git checkpoints + file-scoped rewind (pure I/O).
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/checkpoint.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
	captureCheckpoint,
	defaultGitRunner,
	ensureStore,
	type GitRunner,
	listCheckpoints,
	restoreCheckpoint,
} from "../src/her-core/checkpoint.ts";

function tempPair(t: TestContext): { memoryRoot: string; repoRoot: string } {
	const memoryRoot = mkdtempSync(join(tmpdir(), "her-g403-mem-"));
	const repoRoot = mkdtempSync(join(tmpdir(), "her-g403-repo-"));
	t.after(() => {
		rmSync(memoryRoot, { recursive: true, force: true });
		rmSync(repoRoot, { recursive: true, force: true });
	});
	return { memoryRoot, repoRoot };
}

function posix(path: string): string {
	return path.replaceAll("\\", "/");
}

function recordingRunner(calls: string[][]): GitRunner {
	return (argv) => {
		calls.push(argv);
		return defaultGitRunner(argv);
	};
}

function flagValue(argv: string[], name: string): string | undefined {
	const prefix = `${name}=`;
	const hit = argv.find((arg) => arg.startsWith(prefix));
	return hit?.slice(prefix.length);
}

test("capture then edit then restore puts the file back", (t) => {
	const { memoryRoot, repoRoot } = tempPair(t);
	const file = join(repoRoot, "note.txt");
	writeFileSync(file, "v1\n");
	const first = captureCheckpoint(memoryRoot, repoRoot, { label: "base" });
	assert.equal(first.created, true);
	assert.ok(first.id.length > 0);
	assert.ok(first.changedFiles.some((path) => posix(path) === "note.txt"));

	writeFileSync(file, "v2\n");
	const report = restoreCheckpoint(memoryRoot, repoRoot, first.id);
	assert.ok(report.restored.some((path) => posix(path) === "note.txt"));
	assert.equal(readFileSync(file, "utf8"), "v1\n");
});

test("every git argv carries --git-dir and --work-tree under memoryRoot", (t) => {
	const { memoryRoot, repoRoot } = tempPair(t);
	const calls: string[][] = [];
	const runner = recordingRunner(calls);
	writeFileSync(join(repoRoot, "tracked.txt"), "one\n");
	const gitDir = ensureStore(memoryRoot, repoRoot, runner);
	const first = captureCheckpoint(memoryRoot, repoRoot, { label: "argv" }, runner);
	writeFileSync(join(repoRoot, "tracked.txt"), "two\n");
	restoreCheckpoint(memoryRoot, repoRoot, first.id, { runner });
	listCheckpoints(memoryRoot, repoRoot, 10, runner);

	assert.ok(calls.length > 0, "expected git invocations");
	assert.match(posix(gitDir), /\/\.her\/checkpoints\/[^/]+\.git$/);
	const memoryPrefix = resolve(memoryRoot).toLowerCase();
	assert.ok(
		resolve(gitDir).toLowerCase().startsWith(memoryPrefix),
		`gitDir ${gitDir} is not under memoryRoot ${memoryRoot}`,
	);

	for (const argv of calls) {
		const gitDirFlag = flagValue(argv, "--git-dir");
		const workTreeFlag = flagValue(argv, "--work-tree");
		assert.ok(gitDirFlag, `missing --git-dir in: git ${argv.join(" ")}`);
		assert.ok(workTreeFlag, `missing --work-tree in: git ${argv.join(" ")}`);
		assert.equal(resolve(gitDirFlag).toLowerCase(), resolve(gitDir).toLowerCase());
		assert.equal(resolve(workTreeFlag).toLowerCase(), resolve(repoRoot).toLowerCase());
		assert.ok(resolve(gitDirFlag).toLowerCase().startsWith(memoryPrefix));
		assert.ok(!posix(gitDirFlag).endsWith("/.git"), "shadow gitDir must not be the real repo .git");
	}
});

test("restore always takes a pre-rewind selfie first", (t) => {
	const { memoryRoot, repoRoot } = tempPair(t);
	writeFileSync(join(repoRoot, "page.txt"), "a\n");
	const first = captureCheckpoint(memoryRoot, repoRoot, { label: "base" });
	writeFileSync(join(repoRoot, "page.txt"), "b\n");
	const report = restoreCheckpoint(memoryRoot, repoRoot, first.id);
	const listed = listCheckpoints(memoryRoot, repoRoot, 10);
	assert.ok(listed.length >= 2);
	assert.equal(listed[0]?.label, "pre-rewind");
	assert.equal(report.preRewindCheckpointId, listed[0]?.id);
	assert.notEqual(report.preRewindCheckpointId, first.id);
	assert.equal(readFileSync(join(repoRoot, "page.txt"), "utf8"), "a\n");
});

test("files changed after the pre-rewind snapshot are skipped", (t) => {
	const { memoryRoot, repoRoot } = tempPair(t);
	const file = join(repoRoot, "watched.txt");
	writeFileSync(file, "original\n");
	const first = captureCheckpoint(memoryRoot, repoRoot, { label: "base" });
	writeFileSync(file, "before-rewind\n");

	const runner: GitRunner = (argv) => {
		const result = defaultGitRunner(argv);
		const messageIdx = argv.indexOf("-m");
		const message = messageIdx >= 0 ? argv[messageIdx + 1] : undefined;
		if (typeof message === "string" && message.includes("pre-rewind")) {
			writeFileSync(file, "after-selfie\n");
		}
		return result;
	};

	const report = restoreCheckpoint(memoryRoot, repoRoot, first.id, { runner });
	assert.equal(readFileSync(file, "utf8"), "after-selfie\n");
	assert.ok(
		report.skipped.some((row) => posix(row.path) === "watched.txt"),
		`expected skipped watched.txt, got ${JSON.stringify(report)}`,
	);
	assert.ok(!report.restored.some((path) => posix(path) === "watched.txt"));
});

test("one conflict aborts the whole restore", (t) => {
	const { memoryRoot, repoRoot } = tempPair(t);
	const firstPath = join(repoRoot, "first.txt");
	const secondPath = join(repoRoot, "second.txt");
	writeFileSync(firstPath, "one\n");
	writeFileSync(secondPath, "one\n");
	const base = captureCheckpoint(memoryRoot, repoRoot, { label: "base" });
	writeFileSync(firstPath, "two\n");
	writeFileSync(secondPath, "two\n");

	const runner: GitRunner = (argv) => {
		const result = defaultGitRunner(argv);
		const messageIdx = argv.indexOf("-m");
		if (String(argv[messageIdx + 1]).includes("pre-rewind")) writeFileSync(secondPath, "concurrent\n");
		return result;
	};

	const report = restoreCheckpoint(memoryRoot, repoRoot, base.id, { runner });
	assert.deepEqual(report.restored, []);
	assert.equal(readFileSync(firstPath, "utf8"), "two\n");
	assert.equal(readFileSync(secondPath, "utf8"), "concurrent\n");
});

test("restore handles created, deleted, and renamed files", (t) => {
	const { memoryRoot, repoRoot } = tempPair(t);
	writeFileSync(join(repoRoot, "kept.txt"), "base\n");
	writeFileSync(join(repoRoot, "old-name.txt"), "rename me\n");
	const base = captureCheckpoint(memoryRoot, repoRoot, { label: "base" });

	rmSync(join(repoRoot, "kept.txt"));
	rmSync(join(repoRoot, "old-name.txt"));
	writeFileSync(join(repoRoot, "new-name.txt"), "rename me\n");
	writeFileSync(join(repoRoot, "created.txt"), "later\n");

	const report = restoreCheckpoint(memoryRoot, repoRoot, base.id);
	assert.equal(report.skipped.length, 0);
	assert.equal(readFileSync(join(repoRoot, "kept.txt"), "utf8"), "base\n");
	assert.equal(readFileSync(join(repoRoot, "old-name.txt"), "utf8"), "rename me\n");
	assert.equal(existsSync(join(repoRoot, "new-name.txt")), false);
	assert.equal(existsSync(join(repoRoot, "created.txt")), false);
});

test("capture with no changes returns created:false and does not add a checkpoint", (t) => {
	const { memoryRoot, repoRoot } = tempPair(t);
	writeFileSync(join(repoRoot, "same.txt"), "x\n");
	const first = captureCheckpoint(memoryRoot, repoRoot, { label: "once" });
	assert.equal(first.created, true);
	const second = captureCheckpoint(memoryRoot, repoRoot, { label: "twice" });
	assert.equal(second.created, false);
	assert.equal(second.id, first.id);
	assert.deepEqual(second.changedFiles, []);
	assert.equal(listCheckpoints(memoryRoot, repoRoot, 50).length, 1);
});

test("node_modules is excluded from the snapshot", (t) => {
	const { memoryRoot, repoRoot } = tempPair(t);
	mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
	writeFileSync(join(repoRoot, "node_modules", "x.js"), "secret\n");
	writeFileSync(join(repoRoot, "keep.txt"), "ok\n");
	const captured = captureCheckpoint(memoryRoot, repoRoot, { label: "exclude" });
	assert.equal(captured.created, true);
	assert.ok(captured.changedFiles.some((path) => posix(path) === "keep.txt"));
	assert.ok(!captured.changedFiles.some((path) => posix(path).includes("node_modules")));
});

test("listCheckpoints is newest-first and includes changedCount", (t) => {
	const { memoryRoot, repoRoot } = tempPair(t);
	writeFileSync(join(repoRoot, "a.txt"), "1\n");
	const c1 = captureCheckpoint(memoryRoot, repoRoot, { label: "first", sessionId: "s1" });
	writeFileSync(join(repoRoot, "a.txt"), "2\n");
	writeFileSync(join(repoRoot, "b.txt"), "b\n");
	const c2 = captureCheckpoint(memoryRoot, repoRoot, { label: "second" });
	writeFileSync(join(repoRoot, "a.txt"), "3\n");
	const c3 = captureCheckpoint(memoryRoot, repoRoot, { label: "third" });

	const listed = listCheckpoints(memoryRoot, repoRoot, 50);
	assert.deepEqual(
		listed.map((row) => row.id),
		[c3.id, c2.id, c1.id],
	);
	assert.equal(listed[0]?.label, "third");
	assert.equal(listed[2]?.sessionId, "s1");
	assert.ok((listed[0]?.changedCount ?? 0) >= 1);
	assert.ok((listed[1]?.changedCount ?? 0) >= 2);
	assert.ok((listed[2]?.changedCount ?? 0) >= 1);
});

test("git failure throws and the error includes stderr", (t) => {
	const { memoryRoot, repoRoot } = tempPair(t);
	writeFileSync(join(repoRoot, "x.txt"), "x\n");
	const runner: GitRunner = () => ({
		status: 128,
		stdout: "",
		stderr: "fatal: boom-stderr-marker",
	});
	assert.throws(
		() => captureCheckpoint(memoryRoot, repoRoot, { label: "fail" }, runner),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /boom-stderr-marker/);
			assert.match(error.message, /git /);
			return true;
		},
	);
});
