import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { runHerCli } from "../src/cli.ts";
import { initStore, Memory, readText, writeText } from "../src/her-core/index.ts";
import { StorePaths } from "../src/her-core/paths.ts";
import { appendTriggerEvent, readTriggerStats, recordTriggerOutcome } from "../src/her-core/trigger-log.ts";

const execFileAsync = promisify(execFile);

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-trigger-log-"));
	await initStore(root);
	return root;
}

async function tempGitStore(): Promise<string> {
	const store = await tempStore();
	await execFileAsync("git", ["init"], { cwd: store });
	await execFileAsync("git", ["config", "user.name", "Her Trigger Log Test"], { cwd: store });
	await execFileAsync("git", ["config", "user.email", "her-trigger-log-test@example.com"], { cwd: store });
	await execFileAsync("git", ["add", "-A"], { cwd: store });
	await execFileAsync("git", ["commit", "-m", "memory: fixtures"], { cwd: store });
	return store;
}

async function readLog(store: string): Promise<string> {
	return (await readText(join(store, ".her", "trigger-log.jsonl"))) ?? "";
}

function stringWritable(): { read: () => string; stream: NodeJS.WritableStream } {
	let output = "";
	return {
		read: () => output,
		stream: new Writable({
			write(chunk, _encoding, callback) {
				output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
				callback();
			},
		}),
	};
}

async function runTriggerStatsCli(
	args: string[],
	store: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const stdout = stringWritable();
	const stderr = stringWritable();
	const code = await runHerCli(args, { ...process.env, HER_MEMORY_DIR: store }, store, {
		stdout: stdout.stream,
		stderr: stderr.stream,
	});
	return { code, stdout: stdout.read(), stderr: stderr.read() };
}

test("surface appends surfaced trigger event with the note id", async () => {
	const store = await tempStore();
	await writeText(join(store, "semantic", "mirror.md"), "# Mirror\n\nSurface this note.\n");

	const hit = await new Memory(store).surface({ query: "surface", sessionId: "s1", cooldownMinutes: 0 });
	const [event] = (await readLog(store))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);

	assert.equal(hit?.id, "semantic/mirror");
	assert.equal(event.kind, "trigger");
	assert.equal(event.outcome, "surfaced");
	assert.equal(event.noteId, "semantic/mirror");
	assert.equal(event.sessionId, "s1");
	assert.equal(event.hasQuery, true);
	assert.equal(typeof event.at, "string");
});

test("surface appends cooldown and empty trigger events without note ids", async () => {
	const store = await tempStore();
	await writeText(join(store, "semantic", "mirror.md"), "# Mirror\n\nSurface this note.\n");
	const memory = new Memory(store);

	await memory.surface({ query: "surface", sessionId: "cooldown", cooldownMinutes: 30 });
	await memory.surface({ query: "surface", sessionId: "cooldown", cooldownMinutes: 30 });
	await writeText(join(store, "semantic", "mirror.md"), "");
	await writeText(join(store, "narrative", "CONTEXT.md"), "");
	const empty = await new Memory(store).surface({ sessionId: "empty", cooldownMinutes: 0 });
	const events = (await readLog(store))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);

	assert.equal(empty, undefined);
	assert.equal(events[1].outcome, "cooldown");
	assert.equal(events[1].noteId, undefined);
	assert.equal(events[2].outcome, "empty");
	assert.equal(events[2].noteId, undefined);
});

test("trigger outcomes calculate engagement only for surfaced events", async () => {
	const store = await tempStore();
	const paths = new StorePaths(store);
	await appendTriggerEvent(paths, { sessionId: "s1", outcome: "surfaced", noteId: "semantic/mirror", hasQuery: true });
	await recordTriggerOutcome(paths, { sessionId: "s1", noteId: "semantic/mirror", outcome: "engaged" });

	const stats = await readTriggerStats(paths);
	const lines = (await readLog(store)).trim().split("\n");

	assert.equal(lines.length, 2);
	assert.deepEqual(stats, {
		total: 1,
		byOutcome: { surfaced: 1, cooldown: 0, empty: 0 },
		engagedRate: 1,
		bySession: { s1: 1 },
	});
});

test("trigger stats are empty for a missing log and skip bad JSON lines", async () => {
	const store = await tempStore();
	const paths = new StorePaths(store);

	assert.deepEqual(await readTriggerStats(paths), {
		total: 0,
		byOutcome: { surfaced: 0, cooldown: 0, empty: 0 },
		engagedRate: 0,
		bySession: {},
	});
	await writeFile(
		join(store, ".her", "trigger-log.jsonl"),
		"{bad json\n" +
			JSON.stringify({
				at: "2026-07-11T00:00:00.000Z",
				kind: "trigger",
				sessionId: "s1",
				outcome: "empty",
				hasQuery: false,
			}) +
			"\n",
		"utf8",
	);

	assert.deepEqual(await readTriggerStats(paths), {
		total: 1,
		byOutcome: { surfaced: 0, cooldown: 0, empty: 1 },
		engagedRate: 0,
		bySession: { s1: 1 },
	});
});

test("trigger log never contains surfaced note bodies or query text", async () => {
	const store = await tempStore();
	const body = "private trigger body must never enter the log";
	const query = "private query must never enter the log";
	await writeText(join(store, "semantic", "private.md"), `# Private\n\n${body}\n`);
	const memory = new Memory(store);
	const hit = await memory.surface({ query, sessionId: "redline", cooldownMinutes: 0 });
	await recordTriggerOutcome(new StorePaths(store), {
		sessionId: "redline",
		noteId: hit?.id ?? "",
		outcome: "ignored",
	});
	await appendTriggerEvent(new StorePaths(store), {
		sessionId: "redline",
		outcome: "surfaced",
		noteId: "samantha/wants/private",
		hasQuery: false,
	});
	await recordTriggerOutcome(new StorePaths(store), {
		sessionId: "redline",
		noteId: "samantha/wants/private",
		outcome: "ignored",
	});
	const log = await readFile(join(store, ".her", "trigger-log.jsonl"), "utf8");

	assert.doesNotMatch(log, new RegExp(body));
	assert.doesNotMatch(log, new RegExp(query));
	assert.doesNotMatch(log, /samantha\/wants/);
});

test("her trigger-stats returns JSON and human summaries", async () => {
	const store = await tempGitStore();
	await appendTriggerEvent(new StorePaths(store), {
		sessionId: "s1",
		outcome: "surfaced",
		noteId: "semantic/mirror",
		hasQuery: true,
	});

	const jsonResult = await runTriggerStatsCli(["trigger-stats", "--json"], store);
	assert.equal(jsonResult.code, 0, jsonResult.stderr);
	const payload = JSON.parse(jsonResult.stdout) as { result?: { byOutcome?: { surfaced?: number }; total?: number } };
	assert.equal(payload.result?.total, 1);
	assert.equal(payload.result?.byOutcome?.surfaced, 1);

	const humanResult = await runTriggerStatsCli(["trigger-stats"], store);
	assert.equal(humanResult.code, 0, humanResult.stderr);
	assert.match(humanResult.stdout, /Her trigger stats: 1 trigger\(s\)\./);
});
