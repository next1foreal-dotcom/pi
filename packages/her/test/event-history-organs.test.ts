import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readEventHistory } from "../src/her-core/event-history.ts";
import { initStore, StorePaths } from "../src/her-core/index.ts";
import { syncMemory } from "../src/her-core/memory-maintenance.ts";
import { withOpBracket } from "../src/her-core/op-brackets.ts";

const execFileAsync = promisify(execFile);

async function tempMemory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g270-organs-"));
	await initStore(root);
	return root;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout.trim();
}

test("withOpBracket writes organ.round start/end on success and error", async () => {
	const store = await tempMemory();
	await withOpBracket(store, "consolidate", async () => "ok");
	await assert.rejects(
		() =>
			withOpBracket(store, "consolidate", async () => {
				throw new Error("round boom");
			}),
		/round boom/,
	);
	const { events } = await readEventHistory(store);
	const rounds = events.filter((event) => event.kind.startsWith("organ.round."));
	assert.equal(rounds.length, 4);
	assert.equal(rounds[0].kind, "organ.round.start");
	assert.equal(rounds[0].actor, "consolidate");
	assert.equal(rounds[1].kind, "organ.round.end");
	assert.equal((rounds[1].data as { ok: boolean }).ok, true);
	assert.equal(rounds[2].kind, "organ.round.start");
	assert.equal(rounds[3].kind, "organ.round.end");
	assert.equal((rounds[3].data as { ok: boolean }).ok, false);
	assert.match(String((rounds[3].data as { error?: string }).error), /round boom/);
	assert.equal((rounds[0].data as { runId: string }).runId, (rounds[1].data as { runId: string }).runId);
});

test("syncMemory writes organ.sync start/end around a git-backed round", async () => {
	const store = await mkdtemp(join(tmpdir(), "her-g270-sync-"));
	const remote = await mkdtemp(join(tmpdir(), "her-g270-sync-remote-"));
	await initStore(store);
	await git(remote, "init", "--bare");
	await git(store, "init");
	await git(store, "config", "user.name", "Her Sync Event");
	await git(store, "config", "user.email", "her-sync-event@example.com");
	await git(store, "config", "commit.gpgsign", "false");
	await git(store, "add", "-A", "--", ".", ":(exclude).her");
	await git(store, "commit", "-m", "memory: init");
	await git(store, "branch", "-M", "master");
	await git(store, "remote", "add", "origin", remote);
	await git(store, "push", "-u", "origin", "master");
	await mkdir(join(store, "episodic"), { recursive: true });
	await writeFile(join(store, "episodic", "2026-08-17.md"), "# local\n", "utf8");

	const result = await syncMemory(new StorePaths(store), "memory(sync): g270");
	assert.equal(result.status, "pushed");
	const { events } = await readEventHistory(store);
	const syncs = events.filter((event) => event.kind.startsWith("organ.sync."));
	assert.equal(syncs.length, 2);
	assert.equal(syncs[0].kind, "organ.sync.start");
	assert.equal(syncs[0].actor, "sync");
	assert.equal(syncs[1].kind, "organ.sync.end");
	assert.equal((syncs[1].data as { ok: boolean }).ok, true);
	assert.equal((syncs[0].data as { runId: string }).runId, (syncs[1].data as { runId: string }).runId);
});
