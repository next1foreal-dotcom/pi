import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	checkMemoryExport,
	classifyMemoryCorpus,
	initStore,
	Memory,
	readText,
	writeText,
} from "../src/her-core/index.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-privacy-"));
	await initStore(root);
	return root;
}

test("privacy classification writes a sidecar ledger without editing legacy raw episodes", async () => {
	const store = await tempStore();
	const rawPath = join(store, "episodic", "raw", "legacy.md");
	const legacyRaw = "# Legacy\n\n朋友说这件事不要外传。\n";
	await writeText(rawPath, legacyRaw);
	await writeText(
		join(store, "world", "public-source.md"),
		[
			"---",
			"id: world-public",
			"source_url: https://example.com/source",
			"provenance: world-ingested",
			"privacy: public",
			"---",
			"# Public Source",
			"",
			"Public material.",
		].join("\n"),
	);

	const result = await classifyMemoryCorpus(store, "2026-06-13T10:00:00.000Z");
	assert.ok(result.total > 0);
	assert.ok(
		result.records.some((record) => record.path === "episodic/raw/legacy.md" && record.privacy === "intimate"),
	);
	assert.ok(
		result.records.some((record) => record.path === "world/public-source.md" && record.source === "frontmatter"),
	);
	assert.equal(await readText(rawPath), legacyRaw);
	assert.match((await readText(join(store, "privacy", "classification.md"))) ?? "", /legacy append-only/i);
});

test("privacy export check blocks private, intimate, and unknown memory refs", async () => {
	const store = await tempStore();
	await writeText(join(store, "episodic", "raw", "legacy.md"), "# Legacy\n\n朋友说这件事不要外传。\n");
	await writeText(
		join(store, "world", "public-source.md"),
		[
			"---",
			"id: world-public",
			"source_url: https://example.com/source",
			"provenance: world-ingested",
			"privacy: public",
			"---",
			"# Public Source",
		].join("\n"),
	);
	await classifyMemoryCorpus(store, "2026-06-13T10:00:00.000Z");

	const blocked = await checkMemoryExport(store, ["episodic/raw/legacy.md"]);
	assert.equal(blocked.allowed, false);
	assert.equal(blocked.blocked[0]?.privacy, "intimate");

	const allowed = await checkMemoryExport(store, ["world/public-source.md"]);
	assert.equal(allowed.allowed, true);

	const unknown = await checkMemoryExport(store, ["missing.md"]);
	assert.equal(unknown.allowed, false);
	assert.deepEqual(unknown.unknown, ["missing.md"]);
});

test("recall defaults to shared and requires an explicit level for sensitive memory", async () => {
	const store = await tempStore();
	await writeText(join(store, "semantic", "shared.md"), "---\nprivacy: shared\n---\n# Boundary\n\nprivacy needle\n");
	await writeText(join(store, "semantic", "private.md"), "---\nprivacy: private\n---\n# Boundary\n\nprivacy needle\n");
	await writeText(
		join(store, "semantic", "intimate.md"),
		"---\nprivacy: intimate\n---\n# Boundary\n\nprivacy needle\n",
	);
	await writeText(join(store, "semantic", "missing.md"), "# Boundary\n\nprivacy needle\n");
	const memory = new Memory(store);

	assert.deepEqual(
		(await memory.recall("privacy needle", { k: 10 })).map((note) => note.id),
		["semantic/shared"],
	);
	const privateHits = new Set(
		(await memory.recall("privacy needle", { k: 10, privacy: "private" })).map((note) => note.id),
	);
	assert.equal(privateHits.has("semantic/shared"), true);
	assert.equal(privateHits.has("semantic/private"), true);
	assert.equal(privateHits.has("semantic/missing"), true);
	assert.equal(privateHits.has("semantic/intimate"), false);
	assert.equal(
		(await memory.recall("privacy needle", { k: 10, privacy: "intimate" })).some(
			(note) => note.id === "semantic/intimate",
		),
		true,
	);
});
