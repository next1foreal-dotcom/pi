import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initStore, parseFrontmatter } from "../src/her-core/index.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function runCli(args: string[], store: string): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync(process.execPath, ["--import", "tsx", "packages/her/src/cli.ts", ...args], {
		cwd: repoRoot,
		env: { ...process.env, HER_MEMORY_DIR: store },
	});
}

test("voice-task-enqueue queues a voice task in inbox without activating it", async () => {
	const store = await mkdtemp(join(tmpdir(), "her-voice-task-"));
	await initStore(store);
	await execFileAsync("git", ["init"], { cwd: store });
	await execFileAsync("git", ["config", "user.name", "Her Voice Test"], { cwd: store });
	await execFileAsync("git", ["config", "user.email", "her-voice-test@example.com"], { cwd: store });
	await execFileAsync("git", ["add", "-A"], { cwd: store });
	await execFileAsync("git", ["commit", "-m", "memory: init"], { cwd: store });

	const result = await runCli(["voice-task-enqueue", "--objective", "check the voice queue", "--json"], store);
	const payload = JSON.parse(result.stdout);

	assert.equal(payload.result.status, "queued");
	assert.equal(payload.result.path.startsWith("tasks/inbox/"), true);
	const text = await readFile(join(store, payload.result.path), "utf8");
	const parsed = parseFrontmatter(text);
	assert.equal(parsed.data.type, "her_voice_inbox");
	assert.equal(parsed.data.source, "voice");
	assert.equal(parsed.data.status, "queued");
	assert.equal(parsed.data.objective, "check the voice queue");
	assert.match(parsed.body, /# Voice Inbox Item/);
	assert.deepEqual(await readdir(join(store, "tasks", "active")), []);
});
