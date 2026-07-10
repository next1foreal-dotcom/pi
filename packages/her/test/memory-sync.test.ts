import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { initStore, StorePaths } from "../src/her-core/index.ts";
import { syncMemory } from "../src/her-core/memory-maintenance.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout.trim();
}

async function configRepo(dir: string, name: string, email: string): Promise<void> {
	await git(dir, "config", "user.name", name);
	await git(dir, "config", "user.email", email);
	await git(dir, "config", "commit.gpgsign", "false");
}

// A her-memory store wired to a bare origin, standing in for one machine.
async function gitBackedStore(): Promise<{ store: string; remote: string }> {
	const store = await mkdtemp(join(tmpdir(), "her-sync-"));
	const remote = await mkdtemp(join(tmpdir(), "her-sync-remote-"));
	await initStore(store);
	await git(remote, "init", "--bare");
	await git(store, "init");
	await configRepo(store, "Her Sync Test", "her-sync-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await git(store, "branch", "-M", "master");
	await git(store, "remote", "add", "origin", remote);
	await git(store, "push", "-u", "origin", "master");
	await git(remote, "symbolic-ref", "HEAD", "refs/heads/master");
	return { store, remote };
}

// A second working clone of the same origin, standing in for the other machine.
async function otherClone(remote: string): Promise<string> {
	const parent = await mkdtemp(join(tmpdir(), "her-sync-other-"));
	const clone = join(parent, "clone");
	await git(parent, "clone", "--branch", "master", remote, "clone");
	await configRepo(clone, "Other Machine", "other@example.com");
	return clone;
}

async function writeCapture(dir: string, sub: string, name: string, body: string): Promise<void> {
	await mkdir(join(dir, sub), { recursive: true });
	await writeFile(join(dir, sub, name), body, "utf8");
}

async function pushFrom(dir: string, sub: string, name: string, message: string): Promise<void> {
	await writeCapture(dir, sub, name, `# ${name}\n`);
	await git(dir, "add", "-A");
	await git(dir, "commit", "-m", message);
	await git(dir, "push", "origin", "master");
}

test("syncMemory pushes when only the local side advanced", async () => {
	const { store, remote } = await gitBackedStore();
	await writeCapture(store, "episodic", "2026-07-10.md", "# local capture\n");

	const result = await syncMemory(new StorePaths(store), "memory(sync): local ahead");

	assert.equal(result.status, "pushed");
	assert.ok(result.commit);
	assert.equal(await git(store, "rev-parse", "HEAD"), await git(remote, "rev-parse", "HEAD"));
});

test("syncMemory fast-forwards when only the remote advanced", async () => {
	const { store, remote } = await gitBackedStore();
	const other = await otherClone(remote);
	await pushFrom(other, "episodic", "2026-07-11.md", "memory: other machine capture");

	const result = await syncMemory(new StorePaths(store), "memory(sync): nothing local");

	assert.equal(result.status, "fast-forwarded");
	assert.equal(result.behind, 1);
	assert.equal(await git(store, "rev-parse", "HEAD"), await git(remote, "rev-parse", "HEAD"));
	// Fast-forward, never a merge commit.
	assert.equal(await git(store, "rev-list", "--count", "--merges", "HEAD"), "0");
});

test("syncMemory refuses to touch history when both sides diverged", async () => {
	const { store, remote } = await gitBackedStore();
	const other = await otherClone(remote);
	await pushFrom(other, "episodic", "remote.md", "memory: remote branch");

	// Local advances independently (unpushed) — now ahead and behind.
	await writeCapture(store, "episodic", "local.md", "# local branch\n");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: local branch");
	const before = await git(store, "rev-parse", "HEAD");

	await assert.rejects(() => syncMemory(new StorePaths(store), "memory(sync): should refuse"), /diverged/);

	// Fail loud without overwriting: local HEAD, remote HEAD, and merge state untouched.
	assert.equal(await git(store, "rev-parse", "HEAD"), before);
	assert.equal(await git(remote, "rev-parse", "HEAD"), await git(other, "rev-parse", "HEAD"));
	await assert.rejects(() => git(store, "rev-parse", "MERGE_HEAD"));
});

test("syncMemory fast-forwards remote work then pushes local growth cleanly", async () => {
	const { store, remote } = await gitBackedStore();
	const other = await otherClone(remote);
	await pushFrom(other, "episodic", "remote.md", "memory: other machine capture");

	// Local has fresh growth while the remote is ahead: ff down, commit on top,
	// push — a routine capture must never manufacture a divergence.
	await writeCapture(store, "semantic", "growth.md", "# local growth\n");

	const result = await syncMemory(new StorePaths(store), "memory(sync): growth");

	assert.equal(result.status, "pushed");
	assert.equal(await git(store, "rev-parse", "HEAD"), await git(remote, "rev-parse", "HEAD"));
	assert.equal(await git(store, "rev-list", "--count", "--merges", "HEAD"), "0");
	const log = await git(store, "log", "--oneline");
	assert.ok(log.includes("other machine capture") && log.includes("growth"));
});

test("syncMemory reports clean when nothing changed on either side", async () => {
	const { store } = await gitBackedStore();

	const result = await syncMemory(new StorePaths(store), "memory(sync): clean");

	assert.equal(result.status, "clean");
});
