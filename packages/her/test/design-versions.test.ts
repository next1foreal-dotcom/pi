/**
 * G-434 — named design checkpoints on refs/notes/her-design.
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/design-versions.test.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	listCheckpoints,
	NOTES_REF,
	nameCheckpoint,
	registerDesignVersionTools,
} from "../src/design-versions/index.ts";

const GIT_TIMEOUT_MS = 15_000;

function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_COMMON_DIR",
		"GIT_NOTES_REF",
	]) {
		delete env[key];
	}
	return env;
}

function git(repo: string, args: string[]): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], {
		encoding: "utf8",
		env: gitEnv(),
		timeout: GIT_TIMEOUT_MS,
		windowsHide: true,
	});
	const extra = result.error ? result.error.message : "";
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: `${result.stderr ?? ""}${extra}`,
	};
}

async function tempDir(t: test.TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "her-design-cp-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function initRepo(t: test.TestContext, subjects: string[]): Promise<{ repo: string; oids: string[] }> {
	const repo = await tempDir(t);
	const inited = git(repo, ["init", "-b", "main", "--quiet"]);
	assert.equal(inited.status, 0, inited.stderr);
	assert.equal(git(repo, ["config", "user.name", "her-test"]).status, 0);
	assert.equal(git(repo, ["config", "user.email", "her-test@example.com"]).status, 0);
	assert.equal(git(repo, ["config", "core.quotepath", "false"]).status, 0);
	for (const subject of subjects) {
		const committed = git(repo, ["commit", "--allow-empty", "--no-verify", "-m", subject]);
		assert.equal(committed.status, 0, committed.stderr);
	}
	const logged = git(repo, ["log", "--reverse", "--format=%H"]);
	assert.equal(logged.status, 0, logged.stderr);
	const oids = logged.stdout.split(/\r?\n/).filter((line) => line.length > 0);
	assert.equal(oids.length, subjects.length);
	return { repo, oids };
}

function harness(repoRoot: string, extra: { gitBin?: string } = {}): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerDesignVersionTools(pi, { repoRoot, ...extra });
	return tools;
}

async function run(
	tool: ToolDefinition | undefined,
	params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> }> {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
}

test("NOTES_REF is the dedicated her-design notes ref", () => {
	assert.equal(NOTES_REF, "refs/notes/her-design");
});

test("naming a commit shows up on listCheckpoints", async (t) => {
	const { repo, oids } = await initRepo(t, ["one", "two", "three"]);
	const head = oids[2];
	assert.ok(head);
	const named = nameCheckpoint(head, "three columns + generous whitespace", { repoRoot: repo });
	assert.equal(named.ok, true, named.error);
	const listed = listCheckpoints({ repoRoot: repo, limit: 10 });
	const row = listed.find((item) => item.oid === head);
	assert.ok(row);
	assert.equal(row.name, "three columns + generous whitespace");
	assert.equal(row.subject, "three");
	assert.ok(row.at.length > 0);
});

test("renaming with add -f overwrites the name and leaves the commit hash unchanged", async (t) => {
	const { repo, oids } = await initRepo(t, ["one", "two", "three"]);
	const head = oids[2];
	assert.ok(head);
	const first = nameCheckpoint(head, "editorial layout", { repoRoot: repo });
	assert.equal(first.ok, true, first.error);
	const second = nameCheckpoint(head, "three columns + generous whitespace", { repoRoot: repo });
	assert.equal(second.ok, true, second.error);
	const listed = listCheckpoints({ repoRoot: repo, limit: 10 });
	const matches = listed.filter((item) => item.oid === head);
	assert.equal(matches.length, 1);
	assert.equal(matches[0]?.name, "three columns + generous whitespace");
	assert.equal(matches[0]?.oid, head);
	const parsed = git(repo, ["rev-parse", "HEAD"]);
	assert.equal(parsed.status, 0, parsed.stderr);
	assert.equal(parsed.stdout.trim(), head);
});

test("names with quotes, newlines, and Chinese round-trip", async (t) => {
	const { repo, oids } = await initRepo(t, ["one", "two", "three"]);
	const head = oids[2];
	assert.ok(head);
	const fancy = '三栏 + "大留白"\n编辑式';
	const named = nameCheckpoint(head, fancy, { repoRoot: repo });
	assert.equal(named.ok, true, named.error);
	const listed = listCheckpoints({ repoRoot: repo, limit: 10 });
	assert.equal(listed.find((item) => item.oid === head)?.name, fancy);
});

test("names longer than 80 characters are truncated and the return says so", async (t) => {
	const { repo, oids } = await initRepo(t, ["one"]);
	const head = oids[0];
	assert.ok(head);
	const long = "x".repeat(81);
	const named = nameCheckpoint(head, long, { repoRoot: repo });
	assert.equal(named.ok, true, named.error);
	assert.equal(named.truncated, true);
	assert.equal(named.name, "x".repeat(80));
	const listed = listCheckpoints({ repoRoot: repo, limit: 5 });
	assert.equal(listed[0]?.name, "x".repeat(80));
	assert.equal(listed[0]?.name?.length, 80);
});

test("a non-git directory returns structured failure and does not throw", async (t) => {
	const dir = await tempDir(t);
	assert.doesNotThrow(() => nameCheckpoint("HEAD", "editorial", { repoRoot: dir }));
	const named = nameCheckpoint("HEAD", "editorial", { repoRoot: dir });
	assert.equal(named.ok, false);
	assert.ok(named.error && named.error.length > 0);
	assert.doesNotThrow(() => listCheckpoints({ repoRoot: dir }));
	const listed = listCheckpoints({ repoRoot: dir });
	assert.deepEqual(listed, []);
});

test("unnamed commits have name null, not an empty string", async (t) => {
	const { repo, oids } = await initRepo(t, ["one", "two"]);
	const listed = listCheckpoints({ repoRoot: repo, limit: 10 });
	assert.equal(listed.length, 2);
	for (const row of listed) {
		assert.equal(row.name, null);
		assert.notEqual(row.name, "");
		assert.ok(oids.includes(row.oid));
	}
});

test("named checkpoints are listed first", async (t) => {
	const { repo, oids } = await initRepo(t, ["one", "two", "three"]);
	assert.ok(oids[0] && oids[2]);
	assert.equal(nameCheckpoint(oids[0], "oldest-named", { repoRoot: repo }).ok, true);
	assert.equal(nameCheckpoint(oids[2], "newest-named", { repoRoot: repo }).ok, true);
	const listed = listCheckpoints({ repoRoot: repo, limit: 10 });
	assert.deepEqual(
		listed.map((row) => row.subject),
		["three", "one", "two"],
	);
	assert.equal(listed[0]?.name, "newest-named");
	assert.equal(listed[1]?.name, "oldest-named");
	assert.equal(listed[2]?.name, null);
});

test("the name is stored on refs/notes/her-design, not the default notes ref", async (t) => {
	const { repo, oids } = await initRepo(t, ["one"]);
	const head = oids[0];
	assert.ok(head);
	assert.equal(nameCheckpoint(head, "editorial layout", { repoRoot: repo }).ok, true);
	const dedicated = git(repo, ["notes", `--ref=${NOTES_REF}`, "show", head]);
	assert.equal(dedicated.status, 0, dedicated.stderr);
	assert.equal(dedicated.stdout.replace(/\r?\n$/, ""), "editorial layout");
	const defaults = git(repo, ["notes", "show", head]);
	assert.notEqual(defaults.status, 0);
});

test("missing git binary returns structured failure and does not throw", async (t) => {
	const { repo } = await initRepo(t, ["one"]);
	const missing = join(repo, "no-such-git");
	assert.doesNotThrow(() => nameCheckpoint("HEAD", "editorial", { repoRoot: repo, gitBin: missing }));
	const named = nameCheckpoint("HEAD", "editorial", { repoRoot: repo, gitBin: missing });
	assert.equal(named.ok, false);
	assert.ok(named.error && named.error.length > 0);
});

test("registerDesignVersionTools exposes name, list, and show", async (t) => {
	const { repo, oids } = await initRepo(t, ["one", "two"]);
	const tools = harness(repo);
	assert.equal(tools.has("design_version_name"), true);
	assert.equal(tools.has("design_version_list"), true);
	assert.equal(tools.has("design_version_show"), true);

	const nameTool = tools.get("design_version_name");
	assert.match(nameTool?.description ?? "", /three columns|whitespace|v2|improved/i);
	assert.match(nameTool?.description ?? "", /HEAD/);

	const showTool = tools.get("design_version_show");
	assert.match(showTool?.description ?? "", /read-only|does not restore|will not restore/i);
	assert.match(showTool?.description ?? "", /git switch --detach/);

	const named = await run(nameTool, { name: "three columns + generous whitespace" });
	assert.equal(named.details.ok, true);
	const listed = await run(tools.get("design_version_list"), { limit: 10 });
	assert.equal(listed.details.ok, true);
	assert.match(listed.text, /three columns \+ generous whitespace/);
	const shown = await run(tools.get("design_version_show"), { oid: oids[1] });
	assert.equal(shown.details.ok, true);
	assert.match(shown.text, /three columns \+ generous whitespace/);
	assert.match(shown.text, /two/);
});

test("design_version_list reports failure in a non-git directory", async (t) => {
	const dir = await tempDir(t);
	const listed = await run(harness(dir).get("design_version_list"), {});
	assert.equal(listed.details.ok, false);
	assert.ok(String(listed.details.error ?? listed.text).length > 0);
});
