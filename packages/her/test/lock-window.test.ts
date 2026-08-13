import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { promisify } from "node:util";
import { initStore, Memory, readJson, readText, writeJson, writeText } from "../src/her-core/index.ts";

const execFileAsync = promisify(execFile);

function storeLockPath(root: string): string {
	return join(root, ".her", "lock");
}

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-lock-window-"));
	await initStore(root);
	return root;
}

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

async function gitInitStore(store: string): Promise<void> {
	await git(store, "init");
	await git(store, "config", "user.name", "Her Lock Window Test");
	await git(store, "config", "user.email", "her-lock-window@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: fixtures");
}

async function writeRawEpisode(store: string, ts: string, id: string, body: string): Promise<void> {
	await writeText(
		join(store, "episodic", "raw", `${ts}--${id}.md`),
		["---", `id: ${id}`, `timestamp: ${ts}`, "project: her", "---", "", body, ""].join("\n"),
	);
}

/** Poll `.her/lock` on the immediate queue so a later write-phase acquire is visible. */
function startLockPoll(lockPath: string): { stop: () => boolean } {
	let seenHeld = false;
	let running = true;
	const tick = (): void => {
		if (!running) return;
		if (existsSync(lockPath)) seenHeld = true;
		setImmediate(tick);
	};
	setImmediate(tick);
	return {
		stop: () => {
			running = false;
			return seenHeld;
		},
	};
}

interface LockProbe {
	heldDuringComplete: boolean[];
	heldDuringWrite: boolean;
}

function probingModel(
	lockPath: string,
	replyFor: (prompt: string, call: number) => string | Promise<string>,
): { model: { complete(prompt: string): Promise<string> }; probe: LockProbe; stop: () => void } {
	const heldDuringComplete: boolean[] = [];
	let poll: { stop: () => boolean } | undefined;
	let call = 0;
	const model = {
		async complete(prompt: string): Promise<string> {
			heldDuringComplete.push(existsSync(lockPath));
			poll ??= startLockPoll(lockPath);
			call += 1;
			return await replyFor(prompt, call);
		},
	};
	return {
		model,
		probe: {
			get heldDuringComplete() {
				return heldDuringComplete;
			},
			get heldDuringWrite() {
				return poll?.stop() ?? false;
			},
		},
		stop: () => {
			poll?.stop();
		},
	};
}

test("consolidate does not hold the store lock during model.complete and re-acquires it to write", async () => {
	const store = await tempStore();
	const lockPath = storeLockPath(store);
	try {
		await writeRawEpisode(store, "2026-06-03T1200", "episode-1", "Verified the real state before reporting.");
		const { model, probe, stop } = probingModel(lockPath, () =>
			JSON.stringify({
				notes: [
					{
						key: "lock-window-consolidate",
						type: "opinion",
						tier: "summarizable",
						content: "Fei trusts machine truth more than soothing summaries.",
						sources: ["episode-1"],
					},
				],
				moments: [],
			}),
		);
		try {
			const result = await new Memory(store, model).consolidate();
			assert.deepEqual(result, { episodes: 1, notesTouched: 1, moments: 0 });
			assert.ok(probe.heldDuringComplete.length >= 1, "distill must call the model");
			assert.deepEqual(
				probe.heldDuringComplete,
				probe.heldDuringComplete.map(() => false),
				"store lock file must be absent during every consolidate model call",
			);
			assert.equal(probe.heldDuringWrite, true, "store lock must be held while the semantic write runs");
			assert.match((await readText(join(store, "semantic", "lock-window-consolidate.md"))) ?? "", /machine truth/);
		} finally {
			stop();
		}
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("reflect (generation surface) does not hold the store lock during model.complete", async () => {
	const store = await tempStore();
	const lockPath = storeLockPath(store);
	try {
		await gitInitStore(store);
		await writeRawEpisode(store, "2026-07-01T0900", "ep1", "Fei rewrote the same paragraph five times.");
		const { model, probe, stop } = probingModel(
			lockPath,
			() => "You rewrite until the words feel inevitable, not until they are merely correct.",
		);
		try {
			const result = await new Memory(store, model).reflect();
			assert.equal(result.ran, true);
			assert.ok(result.id);
			assert.ok(probe.heldDuringComplete.length >= 1);
			assert.deepEqual(
				probe.heldDuringComplete,
				probe.heldDuringComplete.map(() => false),
				"store lock file must be absent during reflect's model call",
			);
			assert.equal(probe.heldDuringWrite, true, "store lock must be held while the recognition is written");
		} finally {
			stop();
		}
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("buildTopicMaps does not hold the store lock during model.complete", async () => {
	const store = await tempStore();
	const lockPath = storeLockPath(store);
	try {
		await writeText(
			join(store, "semantic", "verification.md"),
			"---\ntype: opinion\n---\n# Verification\n\nMachine truth first.\n",
		);
		const { model, probe, stop } = probingModel(lockPath, () =>
			JSON.stringify({
				maps: [
					{
						theme: "Verification Practice",
						summary: "Machine truth before closure.",
						members: ["verification"],
					},
				],
			}),
		);
		try {
			assert.deepEqual(await new Memory(store, model).buildTopicMaps(), ["verification-practice"]);
			assert.ok(probe.heldDuringComplete.length >= 1);
			assert.deepEqual(
				probe.heldDuringComplete,
				probe.heldDuringComplete.map(() => false),
				"store lock file must be absent during topic-maps model calls",
			);
			assert.equal(probe.heldDuringWrite, true, "store lock must be held while topic files are written");
			assert.match((await readText(join(store, "topics", "verification-practice.md"))) ?? "", /Machine truth/);
		} finally {
			stop();
		}
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("consolidate discards the batch when the cursor moves during the model call", async () => {
	const store = await tempStore();
	const lockPath = storeLockPath(store);
	const warn = mock.method(console, "warn");
	try {
		await writeRawEpisode(store, "2026-06-03T1200", "episode-1", "A session that should not be double-distilled.");
		const concurrentCursor = { ts: "2099-01-01T0000", done_ids: ["concurrent-writer"] };
		const { model, stop } = probingModel(lockPath, async () => {
			const state = await readJson<Record<string, unknown>>(join(store, ".her", "state.json"), {});
			await writeJson(join(store, ".her", "state.json"), { ...state, cursor: concurrentCursor });
			return JSON.stringify({
				notes: [
					{
						key: "stale-batch",
						type: "note",
						content: "STALE DISTILL that must not land.",
						sources: ["episode-1"],
					},
				],
			});
		});
		try {
			const result = await new Memory(store, model).consolidate();
			assert.equal(result.notesTouched, 0, "moved cursor must not apply the stale distill");
			assert.equal(await readText(join(store, "semantic", "stale-batch.md")), undefined);
			const state = await readJson<{ cursor?: { ts?: string; done_ids?: string[] } }>(
				join(store, ".her", "state.json"),
				{},
			);
			assert.equal(
				state.cursor?.ts,
				concurrentCursor.ts,
				"cursor must not be double-advanced over the concurrent write",
			);
			assert.deepEqual(state.cursor?.done_ids, concurrentCursor.done_ids);
			const audit = (await readText(join(store, "audit", "consolidate-skips.jsonl"))) ?? "";
			assert.match(audit, /premise-moved/);
			assert.ok(
				warn.mock.calls.some((call) =>
					call.arguments.some((arg) => typeof arg === "string" && /cursor moved/i.test(arg)),
				),
				"skip must be logged",
			);
		} finally {
			stop();
		}
	} finally {
		warn.mock.restore();
		await rm(store, { recursive: true, force: true });
	}
});

test("upsert skips a stale merge when the target note changes during the model call", async () => {
	const store = await tempStore();
	const lockPath = storeLockPath(store);
	const warn = mock.method(console, "warn");
	try {
		await writeText(
			join(store, "semantic", "compiled-fact.md"),
			[
				"---",
				"key: compiled-fact",
				"type: concept",
				"tier: summarizable",
				"created: 2026-08-01",
				"updated: 2026-08-01",
				"---",
				"",
				"# compiled-fact",
				"",
				"OLD KNOWLEDGE: Fei prefers neutral palettes.",
				"",
			].join("\n"),
		);
		await writeRawEpisode(store, "2026-08-10T0001", "ep-new", "Fei also mentioned frosted glass.");
		const concurrentBody = "CONCURRENT NEWER BODY that must survive.\n";
		const { model, probe, stop } = probingModel(lockPath, async (prompt) => {
			if (prompt.includes("EXISTING NOTE:")) {
				await writeText(
					join(store, "semantic", "compiled-fact.md"),
					["---", "key: compiled-fact", "type: concept", "---", "", concurrentBody].join("\n"),
				);
				return JSON.stringify({
					content: "STALE MERGE that must not overwrite the newer note.",
					change: "stale merge",
				});
			}
			return JSON.stringify({
				notes: [
					{
						key: "compiled-fact",
						type: "concept",
						content: "RAW-NEW: Fei likes frosted glass.",
						sources: ["ep-new"],
					},
				],
			});
		});
		try {
			await new Memory(store, model).consolidate();
			assert.ok(probe.heldDuringComplete.length >= 2, "distill plus merge must both call the model");
			assert.deepEqual(
				probe.heldDuringComplete,
				probe.heldDuringComplete.map(() => false),
				"store lock file must be absent during distill and merge model calls",
			);
			const body = (await readText(join(store, "semantic", "compiled-fact.md"))) ?? "";
			assert.match(body, /CONCURRENT NEWER BODY that must survive/);
			assert.doesNotMatch(body, /STALE MERGE/);
			const audit = (await readText(join(store, "audit", "consolidate-skips.jsonl"))) ?? "";
			assert.match(audit, /premise-moved/);
			assert.ok(
				warn.mock.calls.some((call) =>
					call.arguments.some((arg) => typeof arg === "string" && /note changed/i.test(arg)),
				),
				"skip must be logged",
			);
		} finally {
			stop();
		}
	} finally {
		warn.mock.restore();
		await rm(store, { recursive: true, force: true });
	}
});
