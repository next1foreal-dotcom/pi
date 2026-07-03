import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_STORE_LOCK_STALE_MS, storeLock } from "../src/her-core/store-lock.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-store-lock-"));
	await mkdir(join(root, ".her"), { recursive: true });
	return root;
}

async function lockPayload(root: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(root, ".her", "lock"), "utf8")) as Record<string, unknown>;
}

test("storeLock times out while a fresh shared lock is held", async () => {
	const root = await tempStore();
	await writeFile(
		join(root, ".her", "lock"),
		JSON.stringify({ at: Date.now() / 1000, host: "python", owner: "python-owner", pid: 999999 }),
		"utf8",
	);

	await assert.rejects(
		() => storeLock(root, async () => undefined, { pollMs: 5, timeoutMs: 20 }),
		/store lock held by/,
	);
});
test("storeLock steals stale shared locks by mtime", async () => {
	const root = await tempStore();
	const lock = join(root, ".her", "lock");
	await writeFile(lock, JSON.stringify({ at: 0, host: "dead", owner: "dead-owner", pid: 999999 }), "utf8");
	const old = new Date(Date.now() - DEFAULT_STORE_LOCK_STALE_MS - 10_000);
	await utimes(lock, old, old);

	await storeLock(root, async () => {
		assert.notEqual((await lockPayload(root)).owner, "dead-owner");
	});

	await assert.rejects(() => stat(lock), /ENOENT/);
});

test("storeLock releases only its own owner nonce", async () => {
	const root = await tempStore();
	const lock = join(root, ".her", "lock");

	await storeLock(root, async () => {
		await writeFile(
			lock,
			JSON.stringify({ at: Date.now() / 1000, host: "python", owner: "foreign-owner", pid: process.pid }),
			"utf8",
		);
	});

	assert.equal((await lockPayload(root)).owner, "foreign-owner");
});
