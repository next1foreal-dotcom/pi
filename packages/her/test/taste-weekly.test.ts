import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	appendTasteIntakeLog,
	clusterTasteCards,
	FakeModel,
	initStore,
	NEW_BOARD_THRESHOLD,
	proposeNewBoards,
	readTasteCards,
	readTasteProposalsSidecar,
	reconcileTasteIntake,
	runTasteWeekly,
	StorePaths,
} from "../src/her-core/index.ts";

async function tempStore(): Promise<StorePaths> {
	const root = await mkdtemp(join(tmpdir(), "her-taste-weekly-"));
	await initStore(root);
	return new StorePaths(root);
}

async function writeTasteCard(
	paths: StorePaths,
	stem: string,
	overrides: { id?: string; title?: string; boards?: string[]; body?: string } = {},
): Promise<void> {
	const id = overrides.id ?? stem;
	const boardsBlock =
		overrides.boards && overrides.boards.length > 0
			? [`boards:`, ...overrides.boards.map((board) => `  - ${board}`)].join("\n")
			: "boards: []";
	const text = [
		"---",
		`id: ${id}`,
		`title: ${overrides.title ?? stem}`,
		"source_type: taste-card",
		boardsBlock,
		"---",
		"",
		overrides.body ?? `Notes about ${stem}.`,
		"",
	].join("\n");
	await writeFile(join(paths.world, `${stem}.md`), text, "utf8");
}

async function writeOrdinaryWorldNote(paths: StorePaths, stem: string): Promise<void> {
	const text = [
		"---",
		`id: ${stem}`,
		`title: ${stem}`,
		"source_type: article",
		"---",
		"",
		"Not a taste card.",
		"",
	].join("\n");
	await writeFile(join(paths.world, `${stem}.md`), text, "utf8");
}

test("reconcileTasteIntake: 5 log entries + 4 cards -> dropped 5 / found 4 / lost 1, naming the lost source", async () => {
	const paths = await tempStore();
	for (let i = 1; i <= 4; i++) await writeTasteCard(paths, `card-${i}`);
	const now = "2026-07-15T10:00:00.000Z";
	for (let i = 1; i <= 4; i++) {
		await appendTasteIntakeLog(paths, { ts: now, source: `source-${i}`, result: "success", noteId: `card-${i}` });
	}
	await appendTasteIntakeLog(paths, {
		ts: now,
		source: "https://x.com/broken/status/1",
		result: "error",
		error: "HTTP 403",
	});

	const cards = await readTasteCards(paths);
	const reconciliation = await reconcileTasteIntake(paths, cards, "2026-07-01T00:00:00.000Z");

	assert.equal(reconciliation.dropped, 5);
	assert.equal(reconciliation.cardsFound, 4);
	assert.equal(reconciliation.lost.length, 1);
	assert.equal(reconciliation.lost[0]?.source, "https://x.com/broken/status/1");
});

test("clusterTasteCards + proposeNewBoards: 8 cards, 6 share a theme with no common board -> cluster + proposal, no card mutation", async () => {
	const paths = await tempStore();
	// palate P2-1: no common existing tag across the cluster members is the trigger for a proposal
	// (spec 2.c) — each cluster member gets its own distinct board so the intersection is empty.
	for (let i = 1; i <= 6; i++) await writeTasteCard(paths, `slow-entrance-${i}`, { boards: [`existing-tag-${i}`] });
	await writeTasteCard(paths, "unrelated-1", { boards: ["misc"] });
	await writeTasteCard(paths, "unrelated-2", { boards: ["misc"] });

	const cards = await readTasteCards(paths);
	const clusterMembers = cards.filter((card) => card.stem.startsWith("slow-entrance")).map((card) => card.stem);
	const beforeTexts = new Map<string, string>();
	for (const stem of clusterMembers) beforeTexts.set(stem, await readFile(join(paths.world, `${stem}.md`), "utf8"));
	const model = new FakeModel(
		JSON.stringify({
			clusters: [{ name: "慢出场", members: clusterMembers, reason: "都在说出场要慢" }],
		}),
	);

	const clustering = await clusterTasteCards(cards, model);
	assert.equal(clustering.status, "ok");
	assert.equal(clustering.clusters.length, 1);
	assert.equal(clustering.clusters[0]?.members.length, 6);

	const proposals = proposeNewBoards(clustering.clusters, cards, "2026-W29");
	assert.equal(proposals.length, 1);
	assert.equal(proposals[0]?.board, "慢出场");
	assert.deepEqual(proposals[0]?.members, clusterMembers);

	// proposing is a pure read + compute — no card file is touched.
	for (const stem of clusterMembers) {
		const text = await readFile(join(paths.world, `${stem}.md`), "utf8");
		assert.equal(text, beforeTexts.get(stem));
	}
});

test("proposeNewBoards skips a cluster that already shares a board tag", async () => {
	const paths = await tempStore();
	for (let i = 1; i <= NEW_BOARD_THRESHOLD; i++)
		await writeTasteCard(paths, `shared-${i}`, { boards: ["already-a-board"] });
	const cards = await readTasteCards(paths);
	const members = cards.map((card) => card.stem);
	const proposals = proposeNewBoards([{ name: "shared theme", members, reason: "x" }], cards, "2026-W29");
	assert.deepEqual(proposals, []);
});

test("runTasteWeekly with 2 cards: insufficient sample, no proposals, model not called", async () => {
	const paths = await tempStore();
	await writeTasteCard(paths, "only-one");
	await writeTasteCard(paths, "only-two");
	const model = new FakeModel();

	const result = await runTasteWeekly(paths, model, { now: "2026-07-20T09:00:00.000Z" });

	assert.equal(result.clusterStatus, "insufficient-sample");
	assert.deepEqual(result.clusters, []);
	assert.deepEqual(result.proposals, []);
	assert.equal(model.calls.length, 0);
	assert.match(result.reportMarkdown, /样本不足/);

	const onDisk = await readFile(result.reportPath, "utf8");
	assert.equal(onDisk, result.reportMarkdown);
});

test("runTasteWeekly still writes the report and exits gracefully when the model throws", async () => {
	const paths = await tempStore();
	for (let i = 1; i <= 3; i++) await writeTasteCard(paths, `card-${i}`);
	const model = new FakeModel(undefined, true);

	const result = await runTasteWeekly(paths, model, { now: "2026-07-20T09:00:00.000Z" });

	assert.equal(result.clusterStatus, "model-unavailable");
	assert.match(result.reportMarkdown, /模型不可用/);
	const onDisk = await readFile(result.reportPath, "utf8");
	assert.equal(onDisk, result.reportMarkdown);
});

test("intake-taste log records one success row and one error row with complete fields", async () => {
	const paths = await tempStore();
	await appendTasteIntakeLog(paths, {
		ts: "2026-07-15T10:00:00.000Z",
		source: "https://good.example/1",
		result: "success",
		noteId: "note-1",
	});
	await appendTasteIntakeLog(paths, {
		ts: "2026-07-15T10:05:00.000Z",
		source: "https://bad.example/2",
		result: "error",
		error: "blocked private URL host",
	});

	const raw = await readFile(join(paths.herDir, "taste-intake-log.jsonl"), "utf8");
	const lines = raw
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(lines.length, 2);
	assert.deepEqual(
		[lines[0].source, lines[0].result, lines[0].noteId],
		["https://good.example/1", "success", "note-1"],
	);
	assert.deepEqual(
		[lines[1].source, lines[1].result, lines[1].error],
		["https://bad.example/2", "error", "blocked private URL host"],
	);
});

test("runTasteWeekly reruns for the same week overwrite the report file instead of duplicating it", async () => {
	const paths = await tempStore();
	for (let i = 1; i <= 3; i++) await writeTasteCard(paths, `card-${i}`);
	const model = new FakeModel(JSON.stringify({ clusters: [] }));

	const first = await runTasteWeekly(paths, model, { now: "2026-07-15T09:00:00.000Z" });
	await writeTasteCard(paths, "card-4");
	const second = await runTasteWeekly(paths, model, { now: "2026-07-16T09:00:00.000Z" });

	assert.equal(first.reportPath, second.reportPath);
	assert.equal(first.week, second.week);
	const onDisk = await readFile(second.reportPath, "utf8");
	assert.equal(onDisk, second.reportMarkdown);
	assert.notEqual(onDisk, first.reportMarkdown);
});

test("readTasteCards ignores non-taste-card world notes", async () => {
	const paths = await tempStore();
	await writeTasteCard(paths, "a-taste-card");
	await writeOrdinaryWorldNote(paths, "an-article");
	const cards = await readTasteCards(paths);
	assert.deepEqual(
		cards.map((card) => card.stem),
		["a-taste-card"],
	);
});

test("taste-proposals.json sidecar matches the frozen schema and is empty-but-present when there are no proposals", async () => {
	const paths = await tempStore();
	await writeTasteCard(paths, "only-one");
	await writeTasteCard(paths, "only-two");
	await runTasteWeekly(paths, new FakeModel(), { now: "2026-07-20T09:00:00.000Z" });

	const sidecar = await readTasteProposalsSidecar(paths);
	assert.ok(sidecar);
	assert.equal(sidecar?.week, "2026-W30");
	assert.deepEqual(sidecar?.proposals, []);
	assert.equal(typeof sidecar?.generatedAt, "string");
});
