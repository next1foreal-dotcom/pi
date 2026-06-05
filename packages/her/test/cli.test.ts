import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initStore, Memory } from "../src/her-core/index.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

async function gitBackedStore(): Promise<{ store: string; remote: string }> {
	const store = await mkdtemp(join(tmpdir(), "her-cli-"));
	const remote = await mkdtemp(join(tmpdir(), "her-cli-remote-"));
	await initStore(store);
	await git(remote, "init", "--bare");
	await git(store, "init");
	await git(store, "config", "user.name", "Her CLI Test");
	await git(store, "config", "user.email", "her-cli-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await git(store, "branch", "-M", "master");
	await git(store, "remote", "add", "origin", remote);
	await git(store, "push", "-u", "origin", "master");
	return { store, remote };
}

async function runCli(args: string[], store: string): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync(
		process.execPath,
		["--import", "tsx", "packages/her/src/cli.ts", ...args],
		{
			cwd: repoRoot,
			env: { ...process.env, HER_MEMORY_DIR: store },
		},
	);
	return { stdout, stderr };
}

test("CLI reports Her memory sync status as JSON", async () => {
	const { store } = await gitBackedStore();

	let result = await runCli(["sync", "--status", "--json"], store);
	let payload = JSON.parse(result.stdout);
	assert.equal(payload.memoryDir, store);
	assert.equal(payload.status.status, "synced");
	assert.equal(payload.status.pending, 0);
	assert.equal(payload.status.branch, "master");
	assert.match(payload.lastSyncedAt, /^\d{4}-\d{2}-\d{2}T/);

	await new Memory(store).remember("Pending local memory for the CLI.", "note");
	result = await runCli(["sync", "--status", "--json"], store);
	payload = JSON.parse(result.stdout);
	assert.equal(payload.status.status, "unsynced");
	assert.equal(payload.status.dirtyFiles, 1);
	assert.equal(payload.status.pending, 1);
});

test("CLI sync commits and pushes dirty Her memory", async () => {
	const { store, remote } = await gitBackedStore();
	await new Memory(store).remember("CLI should commit and push this memory.", "note");

	const result = await runCli(["sync", "--message", "memory(sync): cli test", "--json"], store);
	const payload = JSON.parse(result.stdout);

	assert.equal(payload.result.status, "pushed");
	assert.match(payload.result.commit, /^[0-9a-f]{7,40}$/);
	assert.equal(payload.status.status, "synced");
	assert.equal(payload.status.pending, 0);
	assert.equal((await git(store, "status", "--porcelain")).stdout.trim(), "");
	assert.match((await git(remote, "log", "--oneline", "-1")).stdout, /memory\(sync\): cli test/);
});

test("CLI runs governed archive sweep as JSON", async () => {
	const { store } = await gitBackedStore();
	await writeFile(
		join(store, "semantic", "old-noise.md"),
		"---\ntier: decay\nupdated: 2020-01-01\n---\n# Old noise\n\nStale low-value memory.\n",
		"utf8",
	);
	await writeFile(
		join(store, "semantic", "identity.md"),
		"---\ntier: exact\nupdated: 2020-01-01\n---\n# Identity\n\nNever archive exact memory.\n",
		"utf8",
	);

	const result = await runCli(["decay", "--older-than-days", "30", "--now", "2026-06-05", "--json"], store);
	const payload = JSON.parse(result.stdout);

	assert.equal(payload.memoryDir, store);
	assert.deepEqual(payload.result.archivedKeys, ["old-noise"]);
	assert.equal(payload.result.archived, 1);
	assert.match(await readFile(join(store, "archive", "semantic", "old-noise.md"), "utf8"), /archived_at: 2026-06-05/);
	assert.match(await readFile(join(store, "semantic", "identity.md"), "utf8"), /Never archive exact memory/);
	assert.equal(payload.status.status, "unsynced");
	assert.ok(payload.status.dirtyFiles >= 1);
});

test("CLI restores an archived semantic note as JSON", async () => {
	const { store } = await gitBackedStore();
	await writeFile(
		join(store, "archive", "semantic", "old-noise.md"),
		"---\ntier: archive\npre_archive_tier: decay\narchived_at: 2026-06-05\n---\n# Old noise\n\nRestore this memory.\n",
		"utf8",
	);

	const result = await runCli(["restore", "--semantic", "old-noise", "--now", "2026-06-06", "--json"], store);
	const payload = JSON.parse(result.stdout);

	assert.equal(payload.memoryDir, store);
	assert.deepEqual(payload.result, { key: "old-noise", restored: true });
	assert.match(await readFile(join(store, "semantic", "old-noise.md"), "utf8"), /restored_at: 2026-06-06/);
	assert.equal(payload.status.status, "unsynced");
	assert.ok(payload.status.dirtyFiles >= 1);
});
