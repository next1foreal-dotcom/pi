import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initStore, Memory, readJson, readText, writeText } from "../src/her-core/index.ts";
import { FinishReasonLengthError } from "../src/her-core/model.ts";
import { detectOrphanBrackets, withOpBracket } from "../src/her-core/op-brackets.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g262-"));
	await initStore(root);
	return root;
}

async function writeRawEpisode(store: string, ts: string, id: string, body: string): Promise<void> {
	await writeText(
		join(store, "episodic", "raw", `${ts}--${id}.md`),
		["---", `id: ${id}`, `timestamp: ${ts}`, "project: her", "---", "", body, ""].join("\n"),
	);
}

async function readOpsLines(store: string): Promise<Array<Record<string, unknown>>> {
	const raw = (await readText(join(store, "audit", "ops.jsonl"))) ?? "";
	return raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("op bracket writes end after a thrown error with ok:false", async () => {
	const store = await tempStore();
	await assert.rejects(
		() =>
			withOpBracket(store, "synthesize", async () => {
				throw new Error("boom for bracket");
			}),
		/boom for bracket/,
	);
	const records = await readOpsLines(store);
	assert.equal(records.length, 2, "start then end");
	assert.equal(records[0].phase, "start");
	assert.equal(records[1].phase, "end");
	assert.equal(records[1].ok, false);
	assert.equal(records[1].opId, records[0].opId);
	assert.equal(records[0].op, "synthesize");
	const error = records[1].error as { name?: string; messageHead?: string };
	assert.equal(error.name, "Error");
	assert.match(error.messageHead ?? "", /boom for bracket/);
});

test("detectOrphanBrackets returns start-without-end past timeout", () => {
	const now = Date.parse("2026-08-13T12:00:00.000Z");
	const timeoutMs = 5 * 60 * 1000;
	const lines = [
		JSON.stringify({ op: "synthesize", opId: "old", phase: "start", ts: "2026-08-13T11:00:00.000Z" }),
		JSON.stringify({ op: "consolidate", opId: "done", phase: "start", ts: "2026-08-13T11:00:00.000Z" }),
		JSON.stringify({
			op: "consolidate",
			opId: "done",
			phase: "end",
			ts: "2026-08-13T11:01:00.000Z",
			ok: true,
		}),
		JSON.stringify({ op: "reingest", opId: "fresh", phase: "start", ts: "2026-08-13T11:59:30.000Z" }),
		"not-json",
		JSON.stringify({ phase: "start" }),
		"",
	];
	assert.deepEqual(detectOrphanBrackets(lines, now, timeoutMs), ["old"]);
	assert.deepEqual(detectOrphanBrackets(lines, now, 2 * 60 * 60 * 1000), []);
});

test("synthesize finish_reason=length fails loud with zero writes", async () => {
	const store = await tempStore();
	const contextBefore = await readText(join(store, "narrative", "CONTEXT.md"));
	const proposalsBefore = await readdir(join(store, "proposals"));
	const draft = "# CONTEXT\n\nFei values verified execution.\n";
	const memory = new Memory(store, {
		complete() {
			return draft;
		},
		completeWithMeta() {
			return {
				text: draft,
				finishReason: "length",
				usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
			};
		},
	});

	await assert.rejects(
		() => memory.synthesize(),
		(error: unknown) => {
			assert.ok(error instanceof FinishReasonLengthError);
			assert.equal(error.finishReason, "length");
			assert.match(error.message, /finish_reason=length/);
			assert.match(error.message, /bytes/);
			return true;
		},
	);

	assert.deepEqual(await readdir(join(store, "proposals")), proposalsBefore, "no proposal may be written");
	const state = await readJson<{ last_synthesize?: string | null }>(join(store, ".her", "state.json"), {});
	assert.ok(!state.last_synthesize, "last_synthesize must not advance on a failed synthesize");
	assert.equal(await readText(join(store, "narrative", "CONTEXT.md")), contextBefore, "CONTEXT.md must be untouched");

	const records = await readOpsLines(store);
	assert.equal(records[0]?.phase, "start");
	assert.equal(records.at(-1)?.phase, "end");
	assert.equal(records.at(-1)?.ok, false);
	assert.equal((records.at(-1)?.error as { name?: string }).name, "FinishReasonLengthError");
});

test("consolidate finish_reason=length routes into existing batch-shrink handling", async () => {
	const store = await tempStore();
	for (let i = 1; i <= 4; i++) {
		await writeRawEpisode(store, `2026-06-21T000${i}`, `shrink-${i}`, `Episode ${i} body.`);
	}
	const batchSizes: number[] = [];
	const script = {
		completeWithMeta(prompt: string) {
			const episodeCount = [...prompt.matchAll(/\[shrink-\d\]/g)].length;
			batchSizes.push(episodeCount);
			const text = JSON.stringify({ notes: [], moments: [] });
			if (episodeCount > 2) return { text, finishReason: "length" };
			return { text, finishReason: "stop" };
		},
		complete(prompt: string) {
			return script.completeWithMeta(prompt).text;
		},
	};
	const memory = new Memory(store, script);

	const first = await memory.consolidate(4);
	assert.equal(first.episodes, 2, "4 -> finish_reason=length -> halved to 2 -> fits");
	assert.deepEqual(batchSizes, [4, 2]);

	const second = await memory.consolidate(4);
	assert.equal(second.episodes, 2);
	const third = await memory.consolidate(4);
	assert.equal(third.episodes, 0);

	const records = await readOpsLines(store);
	assert.ok(records.some((row) => row.op === "consolidate" && row.phase === "start"));
	assert.ok(records.some((row) => row.op === "consolidate" && row.phase === "end" && row.ok === true));
});
