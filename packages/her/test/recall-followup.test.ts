import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initStore, Memory, readJson } from "../src/her-core/index.ts";
import type { CorpusDoc, Note, SearchBackend } from "../src/her-core/retrieval.ts";

type RecallOptions = Parameters<Memory["recall"]>[1];

function retentionOptions(options: Record<string, unknown>): RecallOptions {
	return options as unknown as RecallOptions;
}

async function syntheticStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-recall-followup-"));
	await initStore(root);
	const records: Array<[string, string]> = [
		["late", "A formerly low-ranked source supports the original decision."],
		["new-a", "Fresh follow-up evidence resolves the next action."],
		["new-b", "Another fresh source covers a secondary detail."],
		["private-only", "PRIVATE_BODY_MUST_NOT_LEAK"],
		["superseded", "SUPERSEDED_BODY_MUST_NOT_LEAK"],
		["expired", "EXPIRED_BODY_MUST_NOT_LEAK"],
	];
	for (const [id, body] of records) {
		const meta =
			id === "private-only"
				? "privacy: private"
				: id === "superseded"
					? "privacy: shared\nstatus: superseded"
					: id === "expired"
						? "privacy: shared\nvalid_until: 2000-01-01"
						: "privacy: shared";
		await writeFile(join(root, "semantic", `${id}.md`), `---\n${meta}\n---\n${body}\n`);
	}
	return root;
}

function rankedSearch(): SearchBackend {
	return (query: string, docs: CorpusDoc[], k: number): Note[] => {
		const order =
			query === "zxqv987654"
				? ["semantic/new-a", "semantic/new-b", "semantic/late"]
				: ["semantic/late", "semantic/new-a"];
		return order
			.map((id, index) => {
				const doc = docs.find((candidate) => candidate.id === id);
				return doc ? { ...doc, score: 1 / (index + 1) } : undefined;
			})
			.filter((note): note is Note => Boolean(note))
			.slice(0, k);
	};
}

test("a follow-up retains a low-ranked source while admitting new evidence", async () => {
	const root = await syntheticStore();
	const memory = new Memory(root, { semanticSearch: rankedSearch() });
	const baseline = await memory.recall("zxqv987654", { k: 2, recordAccess: false });
	assert.deepEqual(
		baseline.map((note) => note.id),
		["semantic/new-a", "semantic/new-b"],
	);
	const retained = await memory.recall(
		"zxqv987654",
		retentionOptions({ k: 2, recordAccess: false, retainSourceIds: ["semantic/late"] }),
	);
	assert.deepEqual(
		retained.map((note) => note.id),
		["semantic/late", "semantic/new-a"],
	);
	assert.equal(retained[0]?.score, 0, "retention must not manufacture a relevance score");
});

test("retention keeps selected evidence, admits fresh hits, and records only final notes", async () => {
	const root = await syntheticStore();
	const memory = new Memory(root, { semanticSearch: rankedSearch() });
	const notes = await memory.recall(
		"zxqv987654",
		retentionOptions({ k: 2, retainSourceIds: ["semantic/late", "semantic/late"] }),
	);
	assert.deepEqual(
		notes.map((note) => note.id),
		["semantic/late", "semantic/new-a"],
	);
	const state = await readJson<{ access?: Record<string, unknown> }>(join(root, ".her", "state.json"), {});
	assert.deepEqual(Object.keys(state.access ?? {}).sort(), ["semantic/late", "semantic/new-a"]);
});

test("empty retention preserves legacy ordering and invalid retention fails before access mutation", async () => {
	const root = await syntheticStore();
	const memory = new Memory(root, { semanticSearch: rankedSearch() });
	const legacy = await memory.recall("zxqv987654", { k: 2, recordAccess: false });
	const empty = await memory.recall(
		"zxqv987654",
		retentionOptions({ k: 2, recordAccess: false, retainSourceIds: [] }),
	);
	assert.deepEqual(empty, legacy);
	await assert.rejects(
		memory.recall("zxqv987654", retentionOptions({ k: 2, retainSourceIds: ["semantic/late", "semantic/new-a"] })),
		/retainSourceIds.*fewer.*k/i,
	);
	await assert.rejects(
		memory.recall("zxqv987654", retentionOptions({ k: Number.NaN, retainSourceIds: ["semantic/late"] })),
		/positive integer/i,
	);
	await assert.rejects(
		memory.recall("zxqv987654", retentionOptions({ k: 2, retainSourceIds: ["   "] })),
		/source IDs/i,
	);
	const state = await readJson<{ access?: Record<string, unknown> }>(join(root, ".her", "state.json"), {});
	assert.equal(state.access, undefined);
});

test("unavailable, inactive, private, and traversal IDs fail without source text or status leakage", async () => {
	const root = await syntheticStore();
	const memory = new Memory(root, { semanticSearch: rankedSearch() });
	const ids = ["semantic/missing", "semantic/private-only", "semantic/superseded", "semantic/expired", "../../secret"];
	const errors: string[] = [];
	for (const id of ids) {
		await assert.rejects(
			memory.recall("zxqv987654", retentionOptions({ k: 2, retainSourceIds: [id] })),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				errors.push(message);
				assert.doesNotMatch(message, /MUST_NOT_LEAK|private|superseded|expired|secret/i);
				return true;
			},
		);
	}
	assert.equal(new Set(errors).size, 1);
	const state = await readJson<{ access?: Record<string, unknown> }>(join(root, ".her", "state.json"), {});
	assert.equal(state.access, undefined);
	assert.equal(
		await readFile(join(root, "semantic", "late.md"), "utf8").then((text) => text.includes("formerly")),
		true,
	);
});
test("retention re-reads changed content and respects newly restricted visibility", async () => {
	const root = await syntheticStore();
	const memory = new Memory(root, { semanticSearch: rankedSearch() });
	const options = { k: 2, recordAccess: false, retainSourceIds: ["semantic/late"] };
	await memory.recall("zxqv987654", options);
	await writeFile(
		join(root, "semantic", "late.md"),
		"---\nprivacy: shared\n---\nUpdated decision: still pending confirmation.",
	);
	const updated = await memory.recall("zxqv987654", options);
	assert.match(updated[0]?.text ?? "", /still pending confirmation/);
	assert.doesNotMatch(updated[0]?.text ?? "", /formerly/);
	await writeFile(join(root, "semantic", "late.md"), "---\nprivacy: private\n---\nPRIVATE_REVISED_BODY");
	await assert.rejects(memory.recall("zxqv987654", options), /unavailable in the current recall scope/);
	const explicitlyPrivate = await memory.recall("zxqv987654", { ...options, privacy: "private" });
	assert.match(explicitlyPrivate[0]?.text ?? "", /PRIVATE_REVISED_BODY/);
});
