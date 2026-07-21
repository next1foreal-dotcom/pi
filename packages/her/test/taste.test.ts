import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { runHerCli } from "../src/cli.ts";
import { initStore, parseFrontmatter } from "../src/her-core/index.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

async function gitBackedTasteStore(): Promise<{ store: string }> {
	const store = await mkdtemp(join(tmpdir(), "her-taste-cli-"));
	const remote = await mkdtemp(join(tmpdir(), "her-taste-cli-remote-"));
	await initStore(store);
	await git(remote, "init", "--bare");
	await git(store, "init");
	await git(store, "config", "user.name", "Her Taste CLI Test");
	await git(store, "config", "user.email", "her-taste-cli-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await git(store, "branch", "-M", "master");
	await git(store, "remote", "add", "origin", remote);
	await git(store, "push", "-u", "origin", "master");
	return { store };
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

async function runTasteCli(
	args: string[],
	store: string,
	options: { stdinText?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const stdout = stringWritable();
	const stderr = stringWritable();
	const stdin = options.stdinText !== undefined ? Readable.from([options.stdinText]) : undefined;
	const code = await runHerCli(args, { ...process.env, HER_MEMORY_DIR: store }, store, {
		stdout: stdout.stream,
		stderr: stderr.stream,
		...(stdin ? { stdin } : {}),
	});
	return { code, stdout: stdout.read(), stderr: stderr.read() };
}

test("CLI intake-taste creates a taste card from a local path with fei and boards", async () => {
	const { store } = await gitBackedTasteStore();
	const sourceRoot = await mkdtemp(join(tmpdir(), "her-taste-source-"));
	const source = join(sourceRoot, "own-design-tool.md");
	await writeFile(source, "# Own Design Tool\n\nA reference on building your own design tool.\n", "utf8");

	const result = await runTasteCli(
		["intake-taste", source, "--fei", "好东西", "--boards", "design,agent", "--json"],
		store,
	);
	assert.equal(result.code, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.match(payload.result.noteId, /^[0-9a-f]{8}$/);
	assert.deepEqual(payload.result.boards, ["design", "agent"]);
	assert.equal(payload.result.fei, "好东西");

	const world = await readFile(join(store, "world", "own-design-tool.md"), "utf8");
	const parsed = parseFrontmatter(world);
	assert.equal(parsed.data.source_type, "taste-card");
	assert.deepEqual(parsed.data.boards, ["design", "agent"]);
	assert.equal(parsed.data.fei, "好东西");
	assert.ok(parsed.data.snapshot);
	const snapshot = parsed.data.snapshot as { text: string; screenshot: unknown; media: unknown[] };
	assert.match(snapshot.text, /^world\/_snapshots\//);
	assert.equal(snapshot.screenshot, null);
	assert.deepEqual(snapshot.media, []);

	const seen = JSON.parse(await readFile(join(store, ".her", "seen.json"), "utf8"));
	assert.ok(Object.values(seen).includes(parsed.data.id));

	const snapshotText = await readFile(join(store, snapshot.text), "utf8");
	assert.match(snapshotText, /building your own design tool/);
});

test("CLI intake-taste on a repeat contentHash merges boards and keeps fei", async () => {
	const { store } = await gitBackedTasteStore();
	const sourceRoot = await mkdtemp(join(tmpdir(), "her-taste-source-2-"));
	const source = join(sourceRoot, "repeat-card.md");
	await writeFile(source, "# Repeat Card\n\nSame content both times.\n", "utf8");

	const first = await runTasteCli(
		["intake-taste", source, "--fei", "keep me", "--boards", "design,agent", "--json"],
		store,
	);
	assert.equal(first.code, 0, first.stderr);
	const firstPayload = JSON.parse(first.stdout);

	const second = await runTasteCli(["intake-taste", source, "--boards", "motion", "--json"], store);
	assert.equal(second.code, 0, second.stderr);
	const secondPayload = JSON.parse(second.stdout);

	assert.equal(secondPayload.result.noteId, firstPayload.result.noteId);

	const worldFiles = (await readdir(join(store, "world"))).filter((entry) => entry.endsWith(".md"));
	assert.deepEqual(worldFiles, ["repeat-card.md"]);

	const world = await readFile(join(store, "world", "repeat-card.md"), "utf8");
	const parsed = parseFrontmatter(world);
	assert.deepEqual([...(parsed.data.boards as string[])].sort(), ["agent", "design", "motion"]);
	assert.equal(parsed.data.fei, "keep me");
});

test("CLI intake-taste reads stdin text as a taste card", async () => {
	const { store } = await gitBackedTasteStore();
	const result = await runTasteCli(["intake-taste", "-", "--boards", "quote", "--json"], store, {
		stdinText: "A perfect quote about slow mornings and good coffee.",
	});
	assert.equal(result.code, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.result.boards, ["quote"]);

	const worldFiles = (await readdir(join(store, "world"))).filter((entry) => entry.endsWith(".md"));
	assert.equal(worldFiles.length, 1);
	const world = await readFile(join(store, "world", worldFiles[0]), "utf8");
	const parsed = parseFrontmatter(world);
	assert.equal(parsed.data.source_type, "taste-card");
	assert.equal(parsed.data.source_url, "text");
	assert.match(world, /A perfect quote about slow mornings/);
});

test("CLI intake-taste rejects an internal URL under SSRF protection", async () => {
	const { store } = await gitBackedTasteStore();
	await assert.rejects(
		() => runTasteCli(["intake-taste", "http://127.0.0.1/x", "--json"], store),
		/blocked (private|local) URL host/,
	);
});
