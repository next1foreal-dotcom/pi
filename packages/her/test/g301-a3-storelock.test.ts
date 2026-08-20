import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initStore, Memory, readJson, readText, writeText } from "../src/her-core/index.ts";
import { storeLock } from "../src/her-core/store-lock.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g301-a3-"));
	await initStore(root);
	return root;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function holdForeignLock(store: string): Promise<string> {
	const lock = join(store, ".her", "lock");
	await writeText(lock, JSON.stringify({ at: Date.now() / 1000, host: "python", owner: "python-owner", pid: 999999 }));
	return lock;
}

function worldNote(contentHash: string) {
	return {
		title: "Store Lock World Note",
		sourceUrl: "https://example.com/store-lock",
		sourceType: "article",
		contentHash,
		memoryStatus: "active" as const,
		extracted: "Lock must be held during world note writes.",
		coverage: "Read full article.",
		read: "Write path must wait for the shared store lock.",
		steal: [] as string[],
		connections: [] as string[],
		take: "Fixture for lock coverage.",
		possibleMoves: [] as string[],
	};
}

test("writeIdea waits for the shared store lock before writing", async () => {
	const store = await tempStore();
	try {
		const lock = await holdForeignLock(store);
		let settled = false;
		const pending = new Memory(store)
			.writeIdea({
				title: "Lock the idea write",
				content: "Idea writes must wait for the shared store lock.",
			})
			.finally(() => {
				settled = true;
			});

		await sleep(50);
		assert.equal(settled, false);
		await rm(lock, { force: true });
		const id = await pending;
		assert.ok(id);
		const files = await readdir(join(store, "ideas"));
		assert.equal(files.length, 1);
		assert.match((await readText(join(store, "ideas", files[0]))) ?? "", /Idea writes must wait/);
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("remember waits for the shared store lock before writing", async () => {
	const store = await tempStore();
	try {
		const lock = await holdForeignLock(store);
		let settled = false;
		const pending = new Memory(store)
			.remember("Semantic notes must wait for the shared store lock.", "note")
			.finally(() => {
				settled = true;
			});

		await sleep(50);
		assert.equal(settled, false);
		await rm(lock, { force: true });
		const id = await pending;
		assert.ok(id);
		const files = (await readdir(join(store, "semantic"))).filter((name) => name.endsWith(".md"));
		assert.equal(files.length, 1);
		assert.match((await readText(join(store, "semantic", files[0]))) ?? "", /Semantic notes must wait/);
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("writeWorldNote waits for the shared store lock before writing", async () => {
	const store = await tempStore();
	try {
		const lock = await holdForeignLock(store);
		let settled = false;
		const pending = new Memory(store).writeWorldNote(worldNote("hash-lock-wait")).finally(() => {
			settled = true;
		});

		await sleep(50);
		assert.equal(settled, false);
		await rm(lock, { force: true });
		const id = await pending;
		assert.ok(id);
		const files = (await readdir(join(store, "world"))).filter((name) => name.endsWith(".md"));
		assert.equal(files.length, 1);
		assert.match((await readText(join(store, "world", files[0]))) ?? "", /Lock must be held/);
		assert.deepEqual(await readJson(join(store, ".her", "seen.json"), {}), { "hash-lock-wait": id });
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("writeIdea, remember, and writeWorldNote stay reentrant under an outer storeLock", async () => {
	const store = await tempStore();
	try {
		const memory = new Memory(store);
		const lock = join(store, ".her", "lock");
		await storeLock(store, async () => {
			assert.equal(existsSync(lock), true);
			const ideaId = await memory.writeIdea({
				title: "Reentrant idea",
				content: "Nested writeIdea must not deadlock.",
			});
			const rememberId = await memory.remember("Nested remember must not deadlock.", "note");
			const worldId = await memory.writeWorldNote(worldNote("hash-reentrant"));
			assert.ok(ideaId);
			assert.ok(rememberId);
			assert.ok(worldId);
			assert.equal(existsSync(lock), true);
		});
		assert.equal(existsSync(lock), false);
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});
