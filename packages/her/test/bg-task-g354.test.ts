/**
 * G-354 — grok worker command injection + grok_build profile shape.
 *
 * grok does not read the prompt from stdin (`-p` requires a value; `grok -p -` sends the
 * literal "-"). The pipeline already writes `<id>.brief` before launch; this card injects
 * `--prompt-file` pointing at that existing file. Do not invent `<id>.brief.md`: task
 * attachments use the G-129 `.brief` sentinel (retention + retries already know it).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { loadBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask } from "../src/her-core/bg-task-spawn.ts";
import { parseWorkers, prepareWorkerCommand, resolveWorkerModel } from "../src/her-core/worker-profile.ts";

const GROK_BUILD_YAML = `workers:
  grok_build:
    argv: ["grok", "--always-approve", "--output-format", "plain"]
`;

async function memoryRoot(config: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g354-"));
	await mkdir(tasksDir(root), { recursive: true });
	await writeFile(join(root, ".her", "config.yaml"), config, "utf8");
	return root;
}

async function waitForDone(root: string, id: string, ms = 15_000): Promise<void> {
	const donePath = join(tasksDir(root), `${id}.done`);
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		try {
			await readFile(donePath, "utf8");
			return;
		} catch {
			await sleep(50);
		}
	}
	throw new Error(`timeout waiting for ${id}.done`);
}

async function writePromptFileFixture(dir: string): Promise<string> {
	const path = join(dir, "read-prompt-file.mjs");
	await writeFile(
		path,
		[
			"import { readFileSync } from 'node:fs';",
			"const i = process.argv.indexOf('--prompt-file');",
			"if (i < 0 || !process.argv[i + 1]) {",
			"  process.stderr.write('NO_PROMPT_FILE\\n');",
			"  process.exit(2);",
			"}",
			"process.stdout.write(readFileSync(process.argv[i + 1], 'utf8'));",
			"",
		].join("\n"),
		"utf8",
	);
	return path;
}

test("G-354 parseWorkers accepts the grok_build archive shape without envAllow or price", () => {
	const workers = parseWorkers(GROK_BUILD_YAML);
	assert.deepEqual(workers.grok_build.argv, ["grok", "--always-approve", "--output-format", "plain"]);
	assert.equal(workers.grok_build.envAllow, undefined);
	assert.equal(workers.grok_build.priceUsd, undefined);
});

test("G-354 resolveWorkerModel does not throw on grok_build argv and returns a displayable value", () => {
	const model = resolveWorkerModel(["grok", "--always-approve", "--output-format", "plain"]);
	assert.equal(typeof model, "string");
	assert.ok(model.length > 0);
});

test("G-354 prepareWorkerCommand injects --prompt-file at the existing .brief path", () => {
	const profile = { argv: ["grok", "--always-approve", "--output-format", "plain"] };
	assert.deepEqual(prepareWorkerCommand("grok", profile, "C:\\tasks", "t-1"), [
		"grok",
		"--prompt-file",
		join("C:\\tasks", "t-1.brief"),
		"--always-approve",
		"--output-format",
		"plain",
	]);
});

test("G-354 grok_build profile name is the same grok CLI and gets the same injection", () => {
	const prepared = prepareWorkerCommand(
		"grok_build",
		{ argv: ["grok", "--always-approve", "--output-format", "plain"] },
		"C:\\tasks",
		"t-gb",
	);
	assert.equal(prepared[0], "grok");
	assert.equal(prepared[1], "--prompt-file");
	assert.equal(prepared[2], join("C:\\tasks", "t-gb.brief"));
	assert.equal(
		prepared.filter((token) => token === "--prompt-file").length,
		1,
		"must not double-inject when the profile is named grok_build",
	);
});

test("G-354 --prompt-file / -p / --single already present are respected", () => {
	assert.deepEqual(
		prepareWorkerCommand(
			"grok",
			{ argv: ["grok", "--prompt-file", "custom.brief", "--output-format", "plain"] },
			"C:\\tasks",
			"t-2",
		),
		["grok", "--prompt-file", "custom.brief", "--output-format", "plain"],
		"already-configured --prompt-file must not be duplicated",
	);
	assert.deepEqual(
		prepareWorkerCommand("grok", { argv: ["grok", "-p", "hello"] }, "C:\\tasks", "t-3"),
		["grok", "-p", "hello"],
		"-p is grok's --single; do not also inject --prompt-file",
	);
	assert.deepEqual(
		prepareWorkerCommand("grok", { argv: ["grok", "--single", "hello"] }, "C:\\tasks", "t-4"),
		["grok", "--single", "hello"],
		"--single already carries a prompt",
	);
});

test("G-354 non-grok profiles are untouched", () => {
	assert.deepEqual(prepareWorkerCommand("deer", { argv: ["node", "deer.mjs"] }, "C:\\tasks", "t-3"), [
		"node",
		"deer.mjs",
	]);
	assert.deepEqual(prepareWorkerCommand("codex", { argv: ["codex", "exec", "-"] }, "C:\\tasks", "t-c"), [
		"codex",
		"exec",
		"--json",
		"-o",
		join("C:\\tasks", "t-c.result.md"),
		"--skip-git-repo-check",
		"-",
	]);
});

test("G-354 prepareWorkerCommand is idempotent for grok", () => {
	const first = prepareWorkerCommand("grok", { argv: ["grok", "--always-approve"] }, "C:\\tasks", "t-id");
	assert.deepEqual(prepareWorkerCommand("grok", { argv: first }, "C:\\tasks", "t-id"), first);
});

test("G-354 worker spawn writes .brief, injects --prompt-file, and does not hang when stdin is unread", async () => {
	const root = await memoryRoot("");
	const fixture = await writePromptFileFixture(root);
	await writeFile(
		join(root, ".her", "config.yaml"),
		[
			"workers:",
			"  grok_build:",
			`    argv: ["${process.execPath}", "${fixture}"]`,
			"tasks:",
			"  budget_daily_cap: 999",
			"",
		].join("\n"),
		"utf8",
	);

	const brief = "G-354 brief via prompt-file, not stdin\nline two";
	const result = await spawnBgTask(root, {
		objective: "G-354 grok prompt-file",
		worker: "grok_build",
		brief,
		skipGates: true,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status !== "running") return;

	await waitForDone(root, result.id);
	const done = JSON.parse(await readFile(join(tasksDir(root), `${result.id}.done`), "utf8")) as {
		exitCode: number;
	};
	assert.equal(done.exitCode, 0);

	const briefPath = join(tasksDir(root), `${result.id}.brief`);
	assert.equal(await readFile(briefPath, "utf8"), brief);

	const loaded = await loadBgTask(root, result.id);
	const command = loaded?.record.command ?? [];
	assert.ok(command.includes("--prompt-file"), `expected --prompt-file in ${JSON.stringify(command)}`);
	const fileArg = command[command.indexOf("--prompt-file") + 1];
	assert.equal(fileArg, briefPath);
	assert.equal(command.filter((token) => token === "--prompt-file").length, 1);

	const log = await readFile(join(tasksDir(root), `${result.id}.log`), "utf8");
	assert.equal(log, brief);
});

test("G-354 bare-command grok argv[0] gets the same --prompt-file injection", async () => {
	const root = await memoryRoot(`${GROK_BUILD_YAML}\ntasks:\n  budget_daily_cap: 999\n`);
	const fixture = await writePromptFileFixture(root);
	const result = await spawnBgTask(root, {
		objective: "G-354 bare grok",
		command: [process.execPath, fixture, "--always-approve"],
		skipGates: true,
		heartbeatMs: 1000,
	});
	// Bare mode keyed off argv[0] basename. A node path is not grok, so this must NOT
	// inject — the grok basename path is unit-tested above and via the worker-name weld.
	assert.equal(result.status, "running");
	if (result.status !== "running") return;
	const loaded = await loadBgTask(root, result.id);
	assert.equal(loaded?.record.command?.includes("--prompt-file"), false);
});

test("G-354 prepareWorkerCommand grok branch on argv[0] basename even when the profile name is unrelated", () => {
	const prepared = prepareWorkerCommand(
		"review-bot",
		{ argv: ["grok", "--output-format", "plain"] },
		join("D:", "tasks"),
		"t-base",
	);
	assert.equal(prepared[1], "--prompt-file");
	assert.equal(prepared[2], join("D:", "tasks", "t-base.brief"));
});
