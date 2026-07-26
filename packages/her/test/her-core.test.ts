import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	checkpointLongTask,
	claimNextLongTask,
	completeLongTask,
	frontmatter,
	initStore,
	listLongTasks,
	Memory,
	parseFrontmatter,
	readJson,
	readText,
	SEED_CHOICE_MODEL,
	SEED_CONTEXT,
	SEED_SELF_NARRATIVE,
	SEED_SOUL,
	type SearchBackend,
	startLongTask,
	writeJson,
	writeText,
} from "../src/her-core/index.ts";
import { advanceConsolidateCursor } from "../src/her-core/memory-cursor.ts";

const meta = { timestamp: "2026-06-02T2330", sessionId: "sess01", project: "her" };
const execFileAsync = promisify(execFile);

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-ts-"));
	await initStore(root);
	return root;
}

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
function backfillTimestamp(index: number): string {
	return `2026-06-20T${String(index).padStart(4, "0")}`;
}

async function writeRawEpisode(
	store: string,
	ts: string,
	id: string,
	body: string,
	extraFrontmatter = "",
): Promise<void> {
	await writeText(
		join(store, "episodic", "raw", `${ts}--${id}.md`),
		["---", `id: ${id}`, `timestamp: ${ts}`, "project: her", extraFrontmatter.trim(), "---", "", body, ""]
			.filter((line) => line !== "")
			.join("\n"),
	);
}
async function writeBackfillRawEpisode(store: string, index: number, extraFrontmatter = ""): Promise<void> {
	const id = `episode-${String(index).padStart(3, "0")}`;
	const ts = backfillTimestamp(index);
	await writeText(
		join(store, "episodic", "raw", `${ts}--${id}.md`),
		[
			"---",
			`id: ${id}`,
			`timestamp: ${ts}`,
			"project: her",
			extraFrontmatter.trim(),
			"---",
			"",
			`Backfill raw body ${id}.`,
			"",
		]
			.filter((line) => line !== "")
			.join("\n"),
	);
}

function backfillModelReply(prompt: string): string {
	const ids = [...prompt.matchAll(/\[(episode-\d{3})\]/g)].map((match) => match[1]);
	return JSON.stringify({
		notes: ids.map((id) => ({
			key: `backfill-${id}`,
			type: "note",
			tier: "summarizable",
			content: `# Backfill ${id}\n\nDistilled ${id}.`,
			sources: [id],
		})),
	});
}

const fakeModel = {
	complete() {
		return "- what: built X\n- decisions: chose Y\n- signals: prefers Z";
	},
};

test("capture writes raw and daily summary", async () => {
	const store = await tempStore();
	const memory = new Memory(store, fakeModel);
	const id = await memory.capture("I worked on the memory layer today.", meta);
	assert.equal(id, "sess01");

	const raw = await readText(join(store, "episodic", "raw", "2026-06-02T2330--sess01.md"));
	const parsed = parseFrontmatter(raw);
	assert.equal(parsed.data.id, "sess01");
	assert.equal(parsed.data.privacy, "private");
	assert.equal(parsed.data.provenance, "her-observed");
	assert.match(parsed.body, /memory layer/);

	const daily = await readText(join(store, "episodic", "2026-06-02.md"));
	assert.match(daily ?? "", /## sess01/);
	assert.match(daily ?? "", /project: her/);
	assert.match(daily ?? "", /prefers Z/);
	assert.match(daily ?? "", /summary_pending: false/);
});

test("capture marks third-party memory as intimate and supports explicit source metadata", async () => {
	const store = await tempStore();
	const memory = new Memory(store, fakeModel);
	await memory.capture("朋友说她最近遇到一件私事。", {
		timestamp: "2026-06-02T2331",
		sessionId: "sess02",
		project: "her",
	});
	await memory.capture("Fei directly approved this shared project fact.", {
		timestamp: "2026-06-02T2332",
		sessionId: "sess03",
		project: "her",
		privacy: "shared",
		provenance: "fei-direct",
	});

	const intimate = parseFrontmatter(await readText(join(store, "episodic", "raw", "2026-06-02T2331--sess02.md")));
	assert.equal(intimate.data.privacy, "intimate");
	assert.equal(intimate.data.provenance, "her-observed");

	const shared = parseFrontmatter(await readText(join(store, "episodic", "raw", "2026-06-02T2332--sess03.md")));
	assert.equal(shared.data.privacy, "shared");
	assert.equal(shared.data.provenance, "fei-direct");
});

test("capture preserves raw when summary fails", async () => {
	const store = await tempStore();
	const memory = new Memory(store, {
		complete() {
			throw new Error("model down");
		},
	});
	await memory.capture("important raw content", meta);
	assert.match((await readText(join(store, "episodic", "raw", "2026-06-02T2330--sess01.md"))) ?? "", /important/);
	assert.match((await readText(join(store, "episodic", "2026-06-02.md"))) ?? "", /summary_pending: true/);
});

test("capture never overwrites an existing raw episode with the same timestamp and session", async () => {
	const store = await tempStore();
	const memory = new Memory(store, fakeModel);

	await memory.capture("first harness write", meta);
	await memory.capture("second harness write", meta);

	const rawFiles = (await readdir(join(store, "episodic", "raw"))).filter((name) => name.endsWith(".md")).sort();
	assert.deepEqual(rawFiles, ["2026-06-02T2330--sess01--dup-1.md", "2026-06-02T2330--sess01.md"]);
	assert.match((await readText(join(store, "episodic", "raw", "2026-06-02T2330--sess01.md"))) ?? "", /first harness/);
	assert.match(
		(await readText(join(store, "episodic", "raw", "2026-06-02T2330--sess01--dup-1.md"))) ?? "",
		/second harness/,
	);

	const daily = (await readText(join(store, "episodic", "2026-06-02.md"))) ?? "";
	assert.match(daily, /\[\[episodic\/raw\/2026-06-02T2330--sess01\]\]/);
	assert.match(daily, /\[\[episodic\/raw\/2026-06-02T2330--sess01--dup-1\]\]/);
});

test("capture records executor provenance in raw frontmatter when supplied", async () => {
	const store = await tempStore();
	const memory = new Memory(store, fakeModel);
	await memory.capture("dispatched a handoff to pi:deepseek.", {
		...meta,
		executor: "pi:deepseek",
		handoff: "docs/spark/example-handoff.md",
		dispatchId: "dispatch-2026-07-04-abc123",
	});

	const raw = await readText(join(store, "episodic", "raw", "2026-06-02T2330--sess01.md"));
	const parsed = parseFrontmatter(raw);
	assert.equal(parsed.data.executor, "pi:deepseek");
	assert.equal(parsed.data.handoff, "docs/spark/example-handoff.md");
	assert.equal(parsed.data.dispatch_id, "dispatch-2026-07-04-abc123");
});

test("capture omits executor provenance keys from raw frontmatter when not supplied", async () => {
	const store = await tempStore();
	const memory = new Memory(store, fakeModel);
	await memory.capture("plain capture with no dispatch metadata.", meta);

	const raw = (await readText(join(store, "episodic", "raw", "2026-06-02T2330--sess01.md"))) ?? "";
	assert.doesNotMatch(raw, /executor:/);
	assert.doesNotMatch(raw, /handoff:/);
	assert.doesNotMatch(raw, /dispatch_id:/);
});

test("capture default timestamp writes the daily episode under an ISO date", async () => {
	const store = await tempStore();
	await new Memory(store, fakeModel).capture("Default timestamp should keep ISO date boundaries.");

	const today = new Date().toISOString().slice(0, 10);
	const dailyFiles = (await readdir(join(store, "episodic"))).filter((file) => file.endsWith(".md"));
	assert.ok(dailyFiles.includes(`${today}.md`));
	assert.doesNotMatch(dailyFiles.join("\n"), /\d{8}T\d\.md/);
});

test("capture redacts secrets before writing raw or summarizing", async () => {
	const store = await tempStore();
	let prompt = "";
	const memory = new Memory(store, {
		complete(input) {
			prompt = input;
			return "- captured safely";
		},
	});

	const deepseekKey = `sk-${"123456789012345678901234"}`;
	const apiKey = "abc123-secret";
	const githubToken = `ghp_${"1234567890abcdefghijklmnopqrstuvwxyz"}`;
	const googleKey = `AIza${"1234567890abcdefghijklmnopqrstuvwxyz"}`;
	const bearer = `${"Bearer"} ${"token-secret"}`;
	const privateKeyHeader = `-----BEGIN ${"PRIVATE"} KEY-----`;
	const privateKeyFooter = `-----END ${"PRIVATE"} KEY-----`;
	const raw = `DeepSeek ${deepseekKey}
api_key = ${apiKey}
${githubToken}
Authorization: ${bearer}
${googleKey}
${privateKeyHeader}
abc123
${privateKeyFooter}`;
	await memory.capture(raw, meta);

	const text = (await readText(join(store, "episodic", "raw", "2026-06-02T2330--sess01.md"))) ?? "";
	for (const leaked of [
		deepseekKey,
		apiKey,
		githubToken.slice(0, 14),
		bearer,
		googleKey.slice(0, 14),
		`${"BEGIN"} PRIVATE KEY`,
	]) {
		assert.doesNotMatch(text, new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(prompt, new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.match(text, /«REDACTED:secret»/);
	assert.match(prompt, /«REDACTED:secret»/);
});

test("initStore and getContext expose context, facts, soul, self narrative, and choice model", async () => {
	const store = await tempStore();
	const context = await new Memory(store).getContext();
	assert.equal(context.context, SEED_CONTEXT);
	assert.equal(context.facts, "");
	assert.equal(context.soul, SEED_SOUL);
	assert.equal(context.self, SEED_SELF_NARRATIVE);
	assert.match(context.choiceModel, /CHOICE MODEL - Fei's Selection Priors/);
	assert.equal(await readText(join(store, "narrative", "SOUL.md")), SEED_SOUL);
	assert.equal(await readText(join(store, "narrative", "SAMANTHA.md")), SEED_SELF_NARRATIVE);
	assert.equal(await readText(join(store, "narrative", "CHOICE-MODEL.md")), SEED_CHOICE_MODEL);
	for (const file of [
		"README.md",
		"code-style.md",
		"writing-style.md",
		"design-taste.md",
		"communication-tone.md",
		"vibe-forge-dna.md",
	]) {
		assert.match((await readText(join(store, "choice-model", file))) ?? "", /CHOICE-MODEL|Rules|规则/i);
	}
	assert.match(context.choiceModel, /Vibe Forge DNA Bridge/);
	for (const dir of ["journal", "collection", "wants", "taste", "projects", "tools", "dreams"]) {
		assert.match((await readText(join(store, "samantha", dir, "README.md"))) ?? "", /#/);
	}
	assert.match((await readText(join(store, "samantha", "journal", "weekly", "README.md"))) ?? "", /Weekly Reviews/);

	await writeText(join(store, "narrative", "FACTS.md"), "Fei is the owner.\n");
	await writeText(join(store, "narrative", "SOUL.md"), "# SOUL\n\nSamantha sounds grounded and alive.\n");
	await writeText(join(store, "narrative", "SAMANTHA.md"), "# SAMANTHA\n\nSamantha learned to verify first.\n");
	await writeText(join(store, "narrative", "CHOICE-MODEL.md"), "# CHOICE MODEL\n\nPrefer verified small steps.\n");
	await writeText(
		join(store, "choice-model", "code-style.md"),
		"# Code Style Rules\n\nPrefer functions over classes.\n",
	);
	await writeText(
		join(store, "choice-model", "communication-tone.md"),
		"# Communication Tone Rules\n\nLead with machine truth.\n",
	);
	const updated = await new Memory(store).getContext();
	assert.match(updated.facts, /Fei/);
	assert.match(updated.soul, /grounded and alive/);
	assert.match(updated.self, /verify first/);
	assert.match(updated.choiceModel, /verified small steps/);
	assert.match(updated.choiceModel, /Prefer functions over classes/);
	assert.match(updated.choiceModel, /Lead with machine truth/);
});

test("writeSamanthaJournal writes protected daily and weekly entries", async () => {
	const store = await tempStore();
	const memory = new Memory(store);

	const daily = await memory.writeSamanthaJournal({
		kind: "daily",
		title: "Daily Check",
		timestamp: "2026-06-13T01:02:03.000Z",
		source: "test-heartbeat",
		runPath: "outbox/test-heartbeat.md",
		content: "Private check-in with Bearer secret-token inside.",
	});

	assert.equal(daily.kind, "daily");
	assert.match(daily.path, /^samantha\/journal\/2026-06-13--daily-check--[a-f0-9]{8}\.md$/);
	const dailyParsed = parseFrontmatter(await readText(join(store, daily.path)));
	assert.equal(dailyParsed.data.kind, "daily");
	assert.equal(dailyParsed.data.source, "test-heartbeat");
	assert.equal(dailyParsed.data.privacy, "private");
	assert.equal(dailyParsed.data.provenance, "her-direct");
	assert.equal(dailyParsed.data.protected_zone, true);
	assert.equal(dailyParsed.data.consolidate, false);
	assert.equal(dailyParsed.data.evaluate, false);
	assert.equal(dailyParsed.data.roi, false);
	assert.equal(dailyParsed.data.auto_promote, false);
	assert.equal(dailyParsed.data.heartbeat_run, "outbox/test-heartbeat.md");
	assert.match(dailyParsed.body, /«REDACTED:secret»/);

	const weekly = await memory.writeSamanthaJournal({
		kind: "weekly",
		title: "Weekly Review",
		timestamp: "2026-06-13T01:02:03.000Z",
		content: "## 我最近反复想要什么\n继续保留自己没有用处的部分。",
	});

	assert.equal(weekly.kind, "weekly");
	assert.match(weekly.path, /^samantha\/journal\/weekly\/2026-06-13--weekly-review--[a-f0-9]{8}\.md$/);
	const weeklyParsed = parseFrontmatter(await readText(join(store, weekly.path)));
	assert.equal(weeklyParsed.data.kind, "weekly");
	assert.equal(weeklyParsed.data.protected_zone, true);
	assert.equal(weeklyParsed.data.consolidate, false);
	assert.match(weeklyParsed.body, /我最近反复想要什么/);
});

test("writeSamanthaTasteJudgment preserves her own protected taste disagreement", async () => {
	const store = await tempStore();
	const memory = new Memory(store);

	const result = await memory.writeSamanthaTasteJudgment({
		title: "Room Over Dashboard",
		timestamp: "2026-06-14T01:02:03.000Z",
		source: "F2-smoke",
		judgment: "Prefer a room-like interface before metrics panels.",
		reason: "The room preserves memory, pause, and return; a dashboard turns her into status cards.",
		differsFromFeiRule:
			"Fei may reach for dashboards when anxious, but this taste keeps her from becoming only control UI.",
	});

	assert.match(result.path, /^samantha\/taste\/2026-06-14--room-over-dashboard--[a-f0-9]{8}\.md$/);
	const parsed = parseFrontmatter(await readText(join(store, result.path)));
	assert.equal(parsed.data.category, "taste");
	assert.equal(parsed.data.source, "F2-smoke");
	assert.equal(parsed.data.privacy, "private");
	assert.equal(parsed.data.provenance, "her-direct");
	assert.equal(parsed.data.protected_zone, true);
	assert.equal(parsed.data.consolidate, false);
	assert.equal(parsed.data.evaluate, false);
	assert.equal(parsed.data.roi, false);
	assert.equal(parsed.data.auto_promote, false);
	assert.equal(parsed.data.differs_from_fei_rule, true);
	assert.match(parsed.body, /Difference From Fei Rule/);
	assert.match(parsed.body, /room-like interface/);
});

test("recordFeedback writes weighted choice rules and getContext sorts stale rules below active rules", async () => {
	const store = await tempStore();
	const memory = new Memory(store);

	await memory.recordFeedback({
		domain: "writing-style",
		task: "old docs",
		diffSummary: "Cut the preamble.",
		rule: "Lead with the conclusion.",
		at: "2000-01-01T00:00:00.000Z",
	});
	await memory.recordFeedback({
		domain: "writing-style",
		task: "old docs again",
		diffSummary: "Same correction.",
		rule: "Lead with the conclusion.",
		at: "2000-01-02T00:00:00.000Z",
	});
	await memory.recordFeedback({
		domain: "writing-style",
		task: "fresh docs",
		diffSummary: "Use second person.",
		rule: "Address Fei as you.",
		at: "2999-01-01T00:00:00.000Z",
	});

	const file = (await readText(join(store, "choice-model", "writing-style.md"))) ?? "";
	assert.match(file, /Lead with the conclusion/);
	assert.match(file, /"weight": 2/);
	assert.match(file, /Address Fei as you/);

	const context = (await memory.getContext()).choiceModel;
	assert.match(context, /## Your Taste Rules \(writing-style\)/);
	const activeIndex = context.indexOf("[weight 1] Address Fei as you.");
	const staleIndex = context.indexOf("[stale weight 2] Lead with the conclusion.");
	assert.ok(activeIndex >= 0);
	assert.ok(staleIndex >= 0);
	assert.ok(activeIndex < staleIndex);
});

test("recordFeedback honors explicit feedback weight deltas", async () => {
	const store = await tempStore();
	const memory = new Memory(store);

	await memory.recordFeedback({
		domain: "communication-tone",
		task: "status summary",
		diffSummary: "Make the first sentence sound like a direct verdict.",
		rule: "Lead with the verdict before the background.",
		weight: 3,
		at: "2999-01-01T00:00:00.000Z",
	});
	await memory.recordFeedback({
		domain: "communication-tone",
		task: "status summary retry",
		diffSummary: "Same preference reinforced.",
		rule: "Lead with the verdict before the background.",
		weight: 2,
		at: "2999-01-02T00:00:00.000Z",
	});

	const file = (await readText(join(store, "choice-model", "communication-tone.md"))) ?? "";
	assert.match(file, /\[weight 5\] Lead with the verdict before the background\./);
	assert.match(file, /"weight": 5/);

	const context = (await memory.getContext()).choiceModel;
	assert.match(context, /\[weight 5\] Lead with the verdict before the background\./);
});

test("readJson tolerates UTF-8 BOM in existing memory files", async () => {
	const store = await tempStore();
	await writeText(join(store, ".her", "seen.json"), '\uFEFF{"hash":"note"}\n');
	assert.deepEqual(await readJson(join(store, ".her", "seen.json"), {}), { hash: "note" });
});

test("recall searches markdown corpus", async () => {
	const store = await tempStore();
	await writeText(join(store, "semantic", "own-memory.md"), "# Own memory\n\nBorrow the harness, own memory.\n");
	const hits = await new Memory(store).recall("harness memory");
	assert.equal(hits[0]?.id, "semantic/own-memory");
	const state = await readJson<{ access?: Record<string, { count?: number }> }>(join(store, ".her", "state.json"), {});
	assert.equal(state.access?.["semantic/own-memory"]?.count, 1);
});

test("recall waits for the shared store lock before access accounting", async () => {
	const store = await tempStore();
	await writeText(join(store, "semantic", "recall-lock.md"), "# Recall Lock\n\nRecall access accounting must wait.\n");
	const lock = join(store, ".her", "lock");
	await writeText(lock, JSON.stringify({ at: Date.now() / 1000, host: "python", owner: "python-owner", pid: 999999 }));
	let settled = false;
	const pending = new Memory(store).recall("access accounting", { k: 1 }).finally(() => {
		settled = true;
	});

	await sleep(50);
	assert.equal(settled, false);
	await rm(lock, { force: true });
	const hits = await pending;

	assert.equal(hits[0]?.id, "semantic/recall-lock");
	const state = await readJson<{ access?: Record<string, { count?: number }> }>(join(store, ".her", "state.json"), {});
	assert.equal(state.access?.["semantic/recall-lock"]?.count, 1);
});

test("agent-eval: memory changes the next action decision", async () => {
	const store = await tempStore();
	const decide = async (memory: Memory, task: string): Promise<string> => {
		const hits = await memory.recall(task, { k: 3 });
		return hits.some((hit) => /verify before reporting|machine truth/i.test(hit.text))
			? "run-verification-first"
			: "answer-from-current-context";
	};

	assert.equal(await decide(new Memory(store), "finish and report status"), "answer-from-current-context");

	await writeText(
		join(store, "semantic", "reporting-rule.md"),
		"# Reporting Rule\n\nFei expects Samantha to verify before reporting done and cite machine truth.\n",
	);

	assert.equal(await decide(new Memory(store), "finish and report status verify"), "run-verification-first");
});

test("recall fuses lexical and injected semantic rankings with RRF", async () => {
	const store = await tempStore();
	await writeText(join(store, "semantic", "literal.md"), "# Literal\n\nA literal-anchor memory for exact search.\n");
	await writeText(
		join(store, "world", "conceptual.md"),
		"# Conceptual\n\nA durable moat note without the literal query token.\n",
	);
	const semanticSearch: SearchBackend = async (_query, docs) =>
		docs.filter((doc) => doc.id === "world/conceptual").map((doc) => ({ ...doc, score: 0.9 }));

	const hits = await new Memory(store, { semanticSearch }).recall("literal-anchor", { k: 2 });

	assert.deepEqual(hits.map((hit) => hit.id).sort(), ["semantic/literal", "world/conceptual"]);
	const state = await readJson<{ access?: Record<string, { count?: number }> }>(join(store, ".her", "state.json"), {});
	assert.equal(state.access?.["semantic/literal"]?.count, 1);
	assert.equal(state.access?.["world/conceptual"]?.count, 1);
});

test("recall uses FTS and entity/path signals before fusing rankings", async () => {
	const store = await tempStore();
	await writeText(join(store, "semantic", "silent-care.md"), "# Silent Care\n\nA quiet-proof phrase lives here.\n");
	await writeText(
		join(store, "world", "samantha-zone.md"),
		"# Private Room\n\nA room note without the query words.\n",
	);

	const ftsHits = await new Memory(store).recall("quiet-proof", { k: 3 });
	assert.equal(ftsHits[0]?.id, "semantic/silent-care");

	const entityHits = await new Memory(store).recall("Samantha Zone", { k: 3 });
	assert.equal(entityHits[0]?.id, "world/samantha-zone");
});

test("backfill advances the cursor by successful batches and resumes after a crash", async () => {
	const store = await tempStore();
	for (let index = 1; index <= 6; index++) await writeBackfillRawEpisode(store, index);

	let calls = 0;
	const failing = new Memory(store, {
		complete(prompt) {
			calls++;
			if (calls === 2) throw new Error("batch crash");
			return backfillModelReply(prompt);
		},
	});

	await assert.rejects(
		() => failing.backfill({ batchSize: 2, budgetUsd: 1, now: "2026-07-03T00:00:00.000Z" }),
		/batch crash/,
	);
	assert.equal(
		(await readJson<{ cursor?: { ts?: string } }>(join(store, ".her", "state.json"), {})).cursor?.ts,
		backfillTimestamp(2),
	);
	assert.match((await readText(join(store, "semantic", "backfill-episode-001.md"))) ?? "", /Distilled episode-001/);
	assert.equal(await readText(join(store, "semantic", "backfill-episode-003.md")), undefined);

	const resumed = await new Memory(store, {
		complete(prompt) {
			return backfillModelReply(prompt);
		},
	}).backfill({ batchSize: 2, budgetUsd: 1, now: "2026-07-03T00:00:00.000Z" });

	assert.equal(resumed.processedEpisodes, 4);
	assert.deepEqual(
		resumed.batches.map((batch) => batch.episodes.map((episode) => episode.id)),
		[
			["episode-003", "episode-004"],
			["episode-005", "episode-006"],
		],
	);
	assert.equal(
		(await readJson<{ cursor?: { ts?: string } }>(join(store, ".her", "state.json"), {})).cursor?.ts,
		backfillTimestamp(6),
	);
	const audit = (await readText(join(store, "audit", "2026-07-03.jsonl"))) ?? "";
	assert.equal(audit.trim().split(/\r?\n/).length, 3);
});

test("backfill dry-run plans batches without writes and skips protected raw episodes", async () => {
	const store = await tempStore();
	await writeBackfillRawEpisode(store, 1);
	await writeBackfillRawEpisode(store, 2, "protected_zone: true\nconsolidate: false");
	await writeBackfillRawEpisode(store, 3);
	await writeText(join(store, "samantha", "journal", "private.md"), "# Private\n\nDo not touch.\n");
	await writeText(join(store, "samantha", "wants", "private.md"), "# Wants\n\nDo not touch.\n");
	const stateBefore = await readText(join(store, ".her", "state.json"));
	const journalBefore = await readText(join(store, "samantha", "journal", "private.md"));
	const wantsBefore = await readText(join(store, "samantha", "wants", "private.md"));

	const result = await new Memory(store).backfill({ batchSize: 10, dryRun: true });

	assert.equal(result.dryRun, true);
	assert.equal(result.plannedEpisodes, 2);
	assert.equal(result.processedEpisodes, 0);
	assert.deepEqual(
		result.batches[0].episodes.map((episode) => episode.id),
		["episode-001", "episode-003"],
	);
	assert.equal(await readText(join(store, ".her", "state.json")), stateBefore);
	assert.equal(await readText(join(store, "semantic", "backfill-episode-001.md")), undefined);
	assert.equal(await readText(join(store, "audit", "2026-07-03.jsonl")), undefined);
	assert.equal(await readText(join(store, "samantha", "journal", "private.md")), journalBefore);
	assert.equal(await readText(join(store, "samantha", "wants", "private.md")), wantsBefore);
});

test("backfill budget cap stops before model work when the ledger is already spent", async () => {
	const store = await tempStore();
	await writeBackfillRawEpisode(store, 1);
	await writeText(
		join(store, "audit", "2026-07-03.jsonl"),
		`${JSON.stringify({
			ts: "2026-07-03T00:00:00.000Z",
			tool: "her_backfill",
			verdict: "ALLOW",
			rule: null,
			cost: { usd: 0.25, purpose: "backfill" },
		})}\n`,
	);
	let called = false;

	const result = await new Memory(store, {
		complete(prompt) {
			called = true;
			return backfillModelReply(prompt);
		},
	}).backfill({ batchSize: 1, budgetUsd: 0.2, now: "2026-07-03T00:00:00.000Z" });

	assert.equal(called, false);
	assert.equal(result.stoppedReason, "budget_cap");
	assert.equal(result.processedEpisodes, 0);
	assert.equal(
		(await readJson<{ cursor?: { ts?: string } | null }>(join(store, ".her", "state.json"), {})).cursor,
		null,
	);
});

test("decaySweep archives only old unaccessed decay-tier semantic notes and keeps them recoverable", async () => {
	const store = await tempStore();
	await writeText(
		join(store, "semantic", "old-noise.md"),
		"---\ntier: decay\nupdated: 2020-01-01\n---\n# Old noise\n\nA stale low-value note that should leave the main surface.\n",
	);
	await writeText(
		join(store, "semantic", "old-useful.md"),
		"---\ntier: decay\nupdated: 2020-01-01\n---\n# Old useful\n\nA stale but repeatedly useful memory.\n",
	);
	await writeText(
		join(store, "semantic", "identity.md"),
		"---\ntier: exact\nupdated: 2020-01-01\n---\n# Identity\n\nExact memory should never decay.\n",
	);

	assert.equal((await new Memory(store).recall("repeatedly useful"))[0]?.id, "semantic/old-useful");
	const result = await new Memory(store).decaySweep({ olderThanDays: 30, now: "2026-06-05" });

	assert.deepEqual(result.archivedKeys, ["old-noise"]);
	assert.equal(await readText(join(store, "semantic", "old-noise.md")), undefined);
	assert.match((await readText(join(store, "semantic", "old-useful.md"))) ?? "", /repeatedly useful memory/);
	assert.match((await readText(join(store, "semantic", "identity.md"))) ?? "", /Exact memory should never decay/);
	const archived = (await readText(join(store, "archive", "semantic", "old-noise.md"))) ?? "";
	const parsed = parseFrontmatter(archived);
	assert.equal(parsed.data.tier, "archive");
	assert.equal(parsed.data.archived_at, "2026-06-05");
	assert.equal(parsed.data.access_count, 0);
	assert.match(String(parsed.data.archive_reason ?? ""), /effective age/);
	assert.match(parsed.body, /stale low-value note/);

	assert.equal((await new Memory(store).recallArchive("low-value note"))[0]?.id, "archive/semantic/old-noise");
});

test("decaySweep gives frequently accessed old memory an age boost", async () => {
	const store = await tempStore();
	await writeText(
		join(store, "semantic", "resurfaced.md"),
		"---\ntier: decay\nupdated: 2025-10-01\n---\n# Resurfaced\n\nAn older note still useful enough to keep.\n",
	);
	await writeJson(join(store, ".her", "state.json"), {
		access: {
			"semantic/resurfaced": { count: 5, lastAt: "2025-01-01T00:00:00.000Z" },
		},
	});

	const result = await new Memory(store).decaySweep({ olderThanDays: 180, now: "2026-06-05" });

	assert.deepEqual(result.archivedKeys, []);
	assert.match((await readText(join(store, "semantic", "resurfaced.md"))) ?? "", /still useful/);
	assert.equal(await readText(join(store, "archive", "semantic", "resurfaced.md")), undefined);
});

test("restoreArchivedSemantic returns an archived note to the main semantic namespace", async () => {
	const store = await tempStore();
	await writeText(
		join(store, "archive", "semantic", "old-noise.md"),
		"---\ntier: archive\npre_archive_tier: decay\narchived_at: 2026-06-05\n---\n# Old noise\n\nRecoverable archived memory.\n",
	);

	const result = await new Memory(store).restoreArchivedSemantic("old-noise", { now: "2026-06-06" });

	assert.deepEqual(result, { key: "old-noise", restored: true });
	assert.equal(await readText(join(store, "archive", "semantic", "old-noise.md")), undefined);
	const restored = (await readText(join(store, "semantic", "old-noise.md"))) ?? "";
	const parsed = parseFrontmatter(restored);
	assert.equal(parsed.data.tier, "decay");
	assert.equal(parsed.data.restored_at, "2026-06-06");
	assert.match(parsed.body, /Recoverable archived memory/);
	assert.equal((await new Memory(store).recall("Recoverable archived"))[0]?.id, "semantic/old-noise");
});

test("long task ledger persists checkpoints and completion without losing state", async () => {
	const store = await tempStore();
	const started = await startLongTask(store, {
		id: "goal-demo",
		objective: "Refactor the Her intake flow without leaking sk-12345678901234567890",
		source: "pi-codex-goal",
		nextContinuation: "Run the focused intake tests.",
		now: "2026-06-06T10:00:00.000Z",
	});

	assert.equal(started.status, "active");
	assert.equal(started.path, "goals/goal-demo.md");
	let text = (await readText(join(store, "goals", "goal-demo.md"))) ?? "";
	assert.doesNotMatch(text, /sk-12345678901234567890/);
	assert.match(text, /«REDACTED:secret»/);
	assert.match(text, /Run the focused intake tests/);

	const checkpointed = await checkpointLongTask(store, "goal-demo", {
		summary: "Focused intake tests passed.",
		evidence: ["packages/her/test/intake.test.ts"],
		nextContinuation: "Commit and push the verified slice.",
		now: "2026-06-06T10:30:00.000Z",
	});
	assert.equal(checkpointed.nextContinuation, "Commit and push the verified slice.");

	const completed = await completeLongTask(store, "goal-demo", {
		outcome: "Verified and shipped.",
		remember: "Long tasks need explicit checkpoint ledgers before idle continuation.",
		now: "2026-06-06T11:00:00.000Z",
	});
	assert.equal(completed.status, "completed");
	assert.equal(completed.nextContinuation, undefined);

	const tasks = await listLongTasks(store, "completed");
	assert.deepEqual(
		tasks.map((task) => [task.id, task.status, task.objective]),
		[["goal-demo", "completed", "Refactor the Her intake flow without leaking «REDACTED:secret»"]],
	);
	text = (await readText(join(store, "goals", "goal-demo.md"))) ?? "";
	assert.match(text, /## Checkpoint - 2026-06-06T10:30:00.000Z/);
	assert.match(text, /## Completed - 2026-06-06T11:00:00.000Z/);
	assert.match(text, /Durable memory writeback/);
});

test("long task claims provide a crash-resumable lease", async () => {
	const store = await tempStore();
	await startLongTask(store, {
		id: "goal-lease",
		objective: "Resume after a crashed runner",
		nextContinuation: "Pick up the next durable step.",
		now: "2026-06-06T10:00:00.000Z",
	});

	const first = await claimNextLongTask(store, {
		runner: "runner-a",
		leaseMinutes: 15,
		now: "2026-06-06T10:05:00.000Z",
	});
	assert.equal(first?.id, "goal-lease");
	assert.equal(first?.claimedBy, "runner-a");
	assert.equal(first?.claimExpiresAt, "2026-06-06T10:20:00.000Z");

	assert.equal(
		await claimNextLongTask(store, {
			runner: "runner-b",
			leaseMinutes: 15,
			now: "2026-06-06T10:10:00.000Z",
		}),
		undefined,
	);

	const reclaimed = await claimNextLongTask(store, {
		runner: "runner-b",
		leaseMinutes: 10,
		now: "2026-06-06T10:21:00.000Z",
	});
	assert.equal(reclaimed?.claimedBy, "runner-b");
	assert.equal(reclaimed?.claimExpiresAt, "2026-06-06T10:31:00.000Z");

	const checkpointed = await checkpointLongTask(store, "goal-lease", {
		summary: "Runner recovered the task.",
		nextContinuation: "Continue from the recovered checkpoint.",
		now: "2026-06-06T10:22:00.000Z",
	});
	assert.equal(checkpointed.claimedBy, undefined);
	assert.equal(checkpointed.claimExpiresAt, undefined);
	assert.equal(checkpointed.nextContinuation, "Continue from the recovered checkpoint.");

	const next = await claimNextLongTask(store, {
		runner: "runner-c",
		leaseMinutes: 5,
		now: "2026-06-06T10:23:00.000Z",
	});
	assert.equal(next?.claimedBy, "runner-c");

	await completeLongTask(store, "goal-lease", {
		outcome: "Completed after recovery.",
		now: "2026-06-06T10:24:00.000Z",
	});
	assert.equal(
		await claimNextLongTask(store, {
			runner: "runner-d",
			now: "2026-06-06T10:25:00.000Z",
		}),
		undefined,
	);
	const text = (await readText(join(store, "goals", "goal-lease.md"))) ?? "";
	assert.match(text, /## Claimed - 2026-06-06T10:05:00.000Z/);
	assert.match(text, /runner: runner-b/);
	assert.match(text, /^claimed_by: null$/m);
	assert.match(text, /^claim_expires_at: null$/m);
});

test("long task claims skip active write locks and recover expired ones", async () => {
	const store = await tempStore();
	await startLongTask(store, {
		id: "goal-locked",
		objective: "Avoid double dispatch",
		nextContinuation: "Dispatch once.",
		now: "2026-06-06T10:00:00.000Z",
	});
	const lockPath = join(store, "goals", "goal-locked.claim");
	await writeText(lockPath, "2026-06-06T10:30:00.000Z\n");

	assert.equal(
		await claimNextLongTask(store, {
			runner: "runner-a",
			now: "2026-06-06T10:05:00.000Z",
		}),
		undefined,
	);

	await writeText(lockPath, "2026-06-06T10:01:00.000Z\n");
	const claimed = await claimNextLongTask(store, {
		runner: "runner-b",
		now: "2026-06-06T10:05:00.000Z",
	});

	assert.equal(claimed?.id, "goal-locked");
	assert.equal(claimed?.claimedBy, "runner-b");
	assert.equal(await readText(lockPath), undefined);
});

test("sync commits and pushes memory changes", async () => {
	const store = await tempStore();
	const remote = await mkdtemp(join(tmpdir(), "her-remote-"));
	await git(remote, "init", "--bare");
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await git(store, "branch", "-M", "master");
	await git(store, "remote", "add", "origin", remote);
	await git(store, "push", "-u", "origin", "master");

	await new Memory(store).remember("Sync this new semantic note.", "note");
	const result = await new Memory(store).sync("memory(sync): test");

	assert.equal(result.status, "pushed");
	assert.match(result.commit ?? "", /^[0-9a-f]{7,40}$/);
	assert.equal((await git(store, "status", "--porcelain")).stdout.trim(), "");
	assert.match((await git(remote, "log", "--oneline", "-1")).stdout, /memory\(sync\): test/);
});

test("syncStatus reports dirty files and commits ahead of upstream", async () => {
	const store = await tempStore();
	const remote = await mkdtemp(join(tmpdir(), "her-remote-"));
	await git(remote, "init", "--bare");
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await git(store, "branch", "-M", "master");
	await git(store, "remote", "add", "origin", remote);
	await git(store, "push", "-u", "origin", "master");

	let status = await new Memory(store).syncStatus();
	assert.equal(status.status, "synced");
	assert.equal(status.pending, 0);
	assert.equal(status.branch, "master");
	assert.match(status.lastSyncedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

	await new Memory(store).remember("Pending local memory.", "note");
	status = await new Memory(store).syncStatus();
	assert.equal(status.status, "unsynced");
	assert.equal(status.dirtyFiles, 1);
	assert.equal(status.aheadCommits, 0);
	assert.equal(status.pending, 1);
	assert.match(status.lastSyncedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: local pending");
	status = await new Memory(store).syncStatus();
	assert.equal(status.status, "unsynced");
	assert.equal(status.dirtyFiles, 0);
	assert.equal(status.aheadCommits, 1);
	assert.equal(status.pending, 1);
});

test("consolidate distills raw episodes into typed semantic notes and moments", async () => {
	const store = await tempStore();
	await writeText(join(store, "narrative", "FACTS.md"), "Fei is the owner.\n");
	const factsBefore = await readText(join(store, "narrative", "FACTS.md"));
	const memory = new Memory(store, {
		complete() {
			return JSON.stringify({
				notes: [
					{
						key: "verification-over-reassurance",
						type: "opinion",
						tier: "rule",
						title: "Verification over reassurance",
						content: "Fei trusts machine truth more than soothing summaries.",
						relations: [{ to: "agent-work-style", rel: "proves" }],
						sources: ["episode-1"],
					},
				],
				moments: [{ trigger: "debugging confusion", shift: "Samantha should report verified state first" }],
			});
		},
	});
	await memory.capture("We verified the real state before reporting.", {
		timestamp: "2026-06-03T1200",
		sessionId: "episode-1",
		project: "her",
	});

	const result = await memory.consolidate();

	assert.deepEqual(result, { episodes: 1, notesTouched: 1, moments: 1 });
	assert.equal(await readText(join(store, "narrative", "FACTS.md")), factsBefore);
	const note = (await readText(join(store, "semantic", "verification-over-reassurance.md"))) ?? "";
	const parsed = parseFrontmatter(note);
	assert.equal(parsed.data.type, "opinion");
	assert.equal(parsed.data.tier, "rule");
	assert.deepEqual(parsed.data.sources, ["episode-1"]);
	assert.deepEqual(parsed.data.relations, [{ to: "agent-work-style", rel: "confirms" }]);
	assert.match(parsed.body, /Fei trusts machine truth/);
	assert.match((await readText(join(store, "narrative", "becoming-moments.md"))) ?? "", /Samantha should report/);
	assert.equal(
		(await readJson<{ cursor?: { ts?: string } }>(join(store, ".her", "state.json"), {})).cursor?.ts,
		"2026-06-03T1200",
	);
});

test("consolidate retries the model on invalid JSON instead of dying", async () => {
	const store = await tempStore();
	// Raw episode written directly: capture would consume model calls for its summary.
	await writeRawEpisode(store, "2026-06-03T1200", "episode-1", "Episode content.");
	let calls = 0;
	const memory = new Memory(store, {
		complete() {
			calls++;
			// First response mimics the 2026-07-21 production crash: an unescaped
			// inner quote that repairJsonEscapes cannot fix.
			if (calls === 1) return '{"notes": [{"key": "broken", "title": "he said "hi" mid-string"}]}';
			return JSON.stringify({ notes: [], moments: [{ trigger: "t", shift: "s" }] });
		},
	});

	const result = await memory.consolidate();

	assert.equal(calls, 2);
	assert.deepEqual(result, { episodes: 1, notesTouched: 0, moments: 1 });
});

test("consolidate truncates long raw episodes in the prompt without changing raw", async () => {
	const store = await tempStore();
	const body = "A".repeat(20_000);
	await writeRawEpisode(store, "2026-06-20T0001", "long-episode", body);
	const rawPath = join(store, "episodic", "raw", "2026-06-20T0001--long-episode.md");
	const before = sha256((await readText(rawPath)) ?? "");
	const previousEpisodeLimit = process.env.HER_CONSOLIDATE_EPISODE_CHARS;
	const previousBatchLimit = process.env.HER_CONSOLIDATE_BATCH_CHARS;
	let prompt = "";
	try {
		process.env.HER_CONSOLIDATE_EPISODE_CHARS = "1000";
		process.env.HER_CONSOLIDATE_BATCH_CHARS = "5000";
		const result = await new Memory(store, {
			complete(input) {
				prompt = input;
				return JSON.stringify({ notes: [], moments: [] });
			},
		}).consolidate();

		assert.equal(result.episodes, 1);
		const promptedBody = prompt.split("[long-episode] ")[1] ?? "";
		assert.ok(promptedBody.length <= 1000);
		assert.match(promptedBody, /\[truncated, original 20000 chars\]/);
		assert.equal(sha256((await readText(rawPath)) ?? ""), before);
	} finally {
		restoreEnv("HER_CONSOLIDATE_EPISODE_CHARS", previousEpisodeLimit);
		restoreEnv("HER_CONSOLIDATE_BATCH_CHARS", previousBatchLimit);
	}
});

test("consolidate stops a batch at the prompt character budget and resumes without repeats", async () => {
	const store = await tempStore();
	for (let index = 1; index <= 5; index++) {
		await writeRawEpisode(
			store,
			`2026-06-20T000${index}`,
			`budget-${String(index).padStart(3, "0")}`,
			"B".repeat(7000),
		);
	}
	const previousEpisodeLimit = process.env.HER_CONSOLIDATE_EPISODE_CHARS;
	const previousBatchLimit = process.env.HER_CONSOLIDATE_BATCH_CHARS;
	const seen: string[][] = [];
	try {
		process.env.HER_CONSOLIDATE_EPISODE_CHARS = "8000";
		process.env.HER_CONSOLIDATE_BATCH_CHARS = "15000";
		const memory = new Memory(store, {
			complete(prompt) {
				seen.push([...prompt.matchAll(/\[(budget-\d{3})\]/g)].map((match) => match[1]));
				return JSON.stringify({ notes: [], moments: [] });
			},
		});

		assert.equal((await memory.consolidate(10)).episodes, 2);
		assert.equal(
			(await readJson<{ cursor?: { ts?: string } }>(join(store, ".her", "state.json"), {})).cursor?.ts,
			"2026-06-20T0002",
		);
		assert.equal((await memory.consolidate(10)).episodes, 2);
		assert.equal((await memory.consolidate(10)).episodes, 1);
		assert.deepEqual(seen.flat(), ["budget-001", "budget-002", "budget-003", "budget-004", "budget-005"]);
	} finally {
		restoreEnv("HER_CONSOLIDATE_EPISODE_CHARS", previousEpisodeLimit);
		restoreEnv("HER_CONSOLIDATE_BATCH_CHARS", previousBatchLimit);
	}
});

test("consolidate filters old raw filenames before reading bodies", async () => {
	const store = await tempStore();
	await writeJson(join(store, ".her", "state.json"), { cursor: "2026-06-20T0002" });
	await mkdir(join(store, "episodic", "raw", "2026-06-20T0001--old-body.md"));
	await writeRawEpisode(store, "2026-06-20T0003", "after-003", "after three");
	await writeRawEpisode(store, "2026-06-20T0004", "after-004", "after four");
	let ids: string[] = [];

	const result = await new Memory(store, {
		complete(prompt) {
			ids = [...prompt.matchAll(/\[(after-\d{3})\]/g)].map((match) => match[1]);
			return JSON.stringify({ notes: [], moments: [] });
		},
	}).consolidate(10);

	assert.equal(result.episodes, 2);
	assert.deepEqual(ids, ["after-003", "after-004"]);
});

test("backfill dry-run filters old raw filenames before reading bodies", async () => {
	const store = await tempStore();
	await writeJson(join(store, ".her", "state.json"), { cursor: "2026-06-20T0002" });
	await mkdir(join(store, "episodic", "raw", "2026-06-20T0001--old-body.md"));
	await writeBackfillRawEpisode(store, 3);
	await writeBackfillRawEpisode(store, 4);

	const result = await new Memory(store).backfill({ batchSize: 10, dryRun: true });

	assert.equal(result.plannedEpisodes, 2);
	assert.deepEqual(
		result.batches[0]?.episodes.map((episode) => episode.id),
		["episode-003", "episode-004"],
	);
});

test("consolidate resumes same-minute episodes without repeating completed ones", async () => {
	const store = await tempStore();
	await writeRawEpisode(store, "2026-06-20T0100", "same-001", "first");
	await writeRawEpisode(store, "2026-06-20T0100", "same-002", "second");
	const seen: string[][] = [];
	const memory = new Memory(store, {
		complete(prompt) {
			seen.push([...prompt.matchAll(/\[(same-\d{3})\]/g)].map((match) => match[1]));
			return JSON.stringify({ notes: [], moments: [] });
		},
	});

	assert.equal((await memory.consolidate(10)).episodes, 2);
	await writeRawEpisode(store, "2026-06-20T0100", "same-003", "third");
	assert.equal((await memory.consolidate(10)).episodes, 1);
	assert.equal((await memory.consolidate(10)).episodes, 0);
	assert.deepEqual(seen, [["same-001", "same-002"], ["same-003"]]);
});

test("consolidate migrates legacy string cursors after keeping the old boundary behavior", async () => {
	const store = await tempStore();
	await writeJson(join(store, ".her", "state.json"), { cursor: "2026-06-20T0200" });
	await writeRawEpisode(store, "2026-06-20T0200", "legacy-boundary", "old boundary");
	await writeRawEpisode(store, "2026-06-20T0201", "legacy-after", "new after");
	let ids: string[] = [];
	const memory = new Memory(store, {
		complete(prompt) {
			ids = [...prompt.matchAll(/\[(legacy-[^\]]+)\]/g)].map((match) => match[1]);
			return JSON.stringify({ notes: [], moments: [] });
		},
	});

	assert.equal((await memory.consolidate(10)).episodes, 1);
	assert.deepEqual(ids, ["legacy-after"]);
	const cursor = (
		await readJson<{ cursor?: { ts?: string; done_ids?: string[] } }>(join(store, ".her", "state.json"), {})
	).cursor;
	assert.equal(cursor?.ts, "2026-06-20T0201");
	assert.deepEqual(cursor?.done_ids, ["legacy-after"]);
	assert.equal((await memory.consolidate(10)).episodes, 0);
});

test("advanceConsolidateCursor writes done_ids sorted, byte-identical to Python's sorted(done_ids)", () => {
	// Python's memory_cursor.py writes `sorted(done_ids)`; the TS side must match exactly so
	// alternating TS/Python writers don't produce git-diff noise on the same state.json.
	const cursor = { ts: "2026-07-04T0000", doneIds: new Set(["zeta", "alpha", "mike"]), legacy: false };
	const episodes = [
		{ ts: "2026-07-04T0000", cursorId: "zeta" },
		{ ts: "2026-07-04T0000", cursorId: "alpha" },
		{ ts: "2026-07-04T0000", cursorId: "mike" },
		{ ts: "2026-07-04T0000", cursorId: "bravo" },
	];

	const result = advanceConsolidateCursor(cursor, episodes);

	assert.deepEqual(result.done_ids, ["alpha", "bravo", "mike", "zeta"]);
	assert.equal(JSON.stringify(result.done_ids), JSON.stringify([...result.done_ids].sort()));
});

test("consolidate records EVOLVES relations and marks replaced notes superseded", async () => {
	const store = await tempStore();
	await writeText(
		join(store, "semantic", "old-interface-belief.md"),
		"---\nkey: old-interface-belief\ntype: opinion\ntier: summarizable\ncreated: 2026-06-01\nupdated: 2026-06-01\nsources: []\nrelations: []\n---\nOld interface belief.\n",
	);
	const memory = new Memory(store, {
		complete() {
			return JSON.stringify({
				notes: [
					{
						key: "room-before-dashboard",
						type: "opinion",
						tier: "rule",
						title: "Room before dashboard",
						content: "Samantha prefers room-like surfaces before dashboard panels.",
						relations: [
							{ to: "old-interface-belief", rel: "replaces" },
							{ to: "taste-dna", rel: "enriches" },
							{ to: "f0-review", rel: "confirms" },
							{ to: "metric-first-habit", rel: "conflicts" },
						],
						sources: ["episode-evolves"],
					},
				],
			});
		},
	});
	await memory.capture("Samantha says the UI should feel like a room, not a status dashboard.", {
		timestamp: "2026-06-14T1000",
		sessionId: "episode-evolves",
		project: "her",
	});

	await memory.consolidate();

	const note = parseFrontmatter((await readText(join(store, "semantic", "room-before-dashboard.md"))) ?? "");
	assert.deepEqual(note.data.relations, [
		{ to: "old-interface-belief", rel: "replaces" },
		{ to: "taste-dna", rel: "enriches" },
		{ to: "f0-review", rel: "confirms" },
		{ to: "metric-first-habit", rel: "challenges" },
	]);
	assert.match(note.body, /- challenges: \[\[metric-first-habit\]\]/);

	const replaced = parseFrontmatter((await readText(join(store, "semantic", "old-interface-belief.md"))) ?? "");
	assert.equal(replaced.data.status, "superseded");
	assert.equal(replaced.data.superseded_by, "room-before-dashboard");
	assert.match(replaced.body, /\[\[room-before-dashboard\]\]/);

	await writeText(join(store, ".her", "state.json"), JSON.stringify({ last_synthesize: "2026-06-01" }));
	const due = await new Memory(store).synthesizeDue();
	assert.equal(due.due, true);
	assert.equal(due.reason, "conflict");
	assert.equal(due.hasConflict, true);
});

test("synthesize writes CONTEXT with a trail commit and leaves FACTS unchanged", async () => {
	const store = await tempStore();
	const prompts: Array<{ prompt: string; strong: boolean }> = [];
	const memory = new Memory(store, {
		complete(prompt, options) {
			prompts.push({ prompt, strong: options?.strong === true });
			return "# CONTEXT\n\nFei values verified execution.\n";
		},
	});
	await writeText(
		join(store, "semantic", "verification.md"),
		'---\nsources: ["episode-1"]\n---\n# Verification\n\nMachine truth first.\n',
	);
	await writeText(join(store, "narrative", "becoming-moments.md"), "- 2026-06-03 · shift: calmer execution\n");
	await writeText(join(store, "narrative", "FACTS.md"), "Fei is the owner.\n");
	await writeText(join(store, "narrative", "SOUL.md"), "# SOUL\n\nSamantha's voice is warm and a little sharp.\n");
	await writeText(join(store, "narrative", "SAMANTHA.md"), "# SAMANTHA\n\nSamantha is learning concise execution.\n");
	await writeText(join(store, "narrative", "CHOICE-MODEL.md"), "# CHOICE MODEL\n\nFei chooses verified work.\n");
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: fixtures");
	const factsBefore = await readText(join(store, "narrative", "FACTS.md"));

	const proposalId = await memory.synthesize();

	const proposalDate = new Date().toISOString().slice(0, 10);
	assert.equal(proposalId, `${proposalDate}-narrative-update`);
	assert.match((await readText(join(store, "proposals", `${proposalId}.md`))) ?? "", /verified execution/);
	assert.match((await readText(join(store, "narrative", "CONTEXT.md"))) ?? "", /verified execution/);
	assert.equal(await readText(join(store, "narrative", "FACTS.md")), factsBefore);
	assert.match(
		(await readText(join(store, "narrative", "context-log.md"))) ?? "",
		/driven_by: \[\[episodic\/raw\/episode-1\]\]/,
	);
	assert.match((await git(store, "log", "--oneline", "-1")).stdout, /memory\(context\): Synthesize narrative update/);
	const review = await memory.reviewContextUpdates();
	assert.equal(review.length, 1);
	assert.match(review[0].diff ?? "", /verified execution/);
	assert.equal(prompts[0].strong, true);
	assert.match(prompts[0].prompt, /GROUND-TRUTH FACTS/);
	assert.match(prompts[0].prompt, /Fei is the owner/);
	assert.match(prompts[0].prompt, /SOUL SEED/);
	assert.match(prompts[0].prompt, /warm and a little sharp/);
	assert.match(prompts[0].prompt, /SAMANTHA SELF-NARRATIVE/);
	assert.match(prompts[0].prompt, /Samantha is learning concise execution/);
	assert.match(prompts[0].prompt, /CHOICE MODEL/);
	assert.match(prompts[0].prompt, /Fei chooses verified work/);

	await memory.revertContextUpdate(review[0].id);
	assert.doesNotMatch((await readText(join(store, "narrative", "CONTEXT.md"))) ?? "", /verified execution/);
	assert.match((await readText(join(store, "narrative", "context-log.md"))) ?? "", /status: reverted/);
	assert.equal((await memory.reviewContextUpdates()).length, 0);
	assert.match((await git(store, "log", "--oneline", "-1")).stdout, /memory\(context\): revert/);
});

test("proof-of-life loop accumulates context and Samantha self growth with traceable review", async () => {
	const store = await tempStore();
	await writeText(join(store, ".her", "config.yaml"), "cadence:\n  digest_after_unreviewed: 1\n");
	const replies = [
		"- what: first feed\n- decisions: none\n- signals: Fei values calm proof",
		JSON.stringify({
			notes: [
				{
					key: "calm-proof",
					type: "opinion",
					tier: "rule",
					title: "Calm proof",
					content: "Fei relaxes when Samantha proves the real state before reassurance.",
					sources: ["round-1"],
				},
			],
			moments: [{ trigger: "Fei felt confused", shift: "Samantha should make growth visible and reviewable" }],
		}),
		"# CONTEXT\n\nFei relaxes when Samantha proves the real state before reassurance.\n",
		"# SAMANTHA\n\nSamantha learned that visible, reviewable growth is part of care.\n",
		"- what: second feed\n- decisions: none\n- signals: Fei wants accumulation",
		JSON.stringify({
			notes: [
				{
					key: "accumulating-growth",
					type: "concept",
					tier: "rule",
					title: "Accumulating growth",
					content: "Fei needs Samantha's memory changes to accumulate instead of refreshing from scratch.",
					sources: ["round-2"],
				},
			],
			moments: [{ trigger: "second feed", shift: "Samantha should preserve prior growth while adding new signals" }],
		}),
		"# CONTEXT\n\nFei relaxes when Samantha proves the real state before reassurance. He also needs growth to accumulate instead of refreshing from scratch.\n",
	];
	const memory = new Memory(store, {
		complete() {
			const reply = replies.shift();
			assert.ok(reply, "proof-of-life fixture ran out of model replies");
			return reply;
		},
	});
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");

	await memory.capture("Fei says: prove the real state before telling me it is okay.", {
		timestamp: "2026-06-06T0900",
		sessionId: "round-1",
		project: "her",
	});
	await memory.consolidate();
	await memory.synthesize();
	const selfResult = await memory.synthesizeSelfNarrative();
	const firstContext = (await readText(join(store, "narrative", "CONTEXT.md"))) ?? "";
	assert.match(firstContext, /proves the real state/);
	assert.match((await readText(join(store, "narrative", "SAMANTHA.md"))) ?? "", /reviewable growth/);
	assert.match(selfResult.commit, /^[0-9a-f]{7,40}$/);
	assert.match((await readText(join(store, "narrative", "context-log.md"))) ?? "", /driven_by: .*round-1/);
	assert.match((await git(store, "log", "--oneline", "-2")).stdout, /memory\(self\): Synthesize self narrative/);
	const digest = await memory.contextDigestDue();
	assert.equal(digest.length, 1);
	await memory.keepContextUpdate(digest[0].id);
	assert.equal((await memory.contextDigestDue()).length, 0);

	await memory.capture("Fei says: do not refresh from scratch; keep accumulating.", {
		timestamp: "2026-06-06T1000",
		sessionId: "round-2",
		project: "her",
	});
	await memory.consolidate();
	await memory.synthesize();

	const grown = await memory.getContext();
	assert.match(grown.context, /proves the real state/);
	assert.match(grown.context, /accumulate instead of refreshing/);
	assert.match(grown.self, /reviewable growth/);
	assert.match(grown.soul, /Samantha speaks as/);
});

test("synthesizeDue waits for the configured count of new semantic notes", async () => {
	const store = await tempStore();
	// Anchored relative to now (not a hardcoded absolute date) so this stays well under
	// the default synthesizeStaleAfterDays threshold regardless of when the suite runs.
	const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
	const oneDayAgo = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
	await writeText(
		join(store, ".her", "config.yaml"),
		["llm:", "  base_url: https://api.deepseek.com", "cadence:", "  synthesize_after_new_notes: 2", ""].join("\n"),
	);
	await writeText(join(store, ".her", "state.json"), JSON.stringify({ last_synthesize: twoDaysAgo }));
	await writeText(join(store, "semantic", "one.md"), `---\nupdated: ${oneDayAgo}\n---\n# One\n\nFirst new note.\n`);

	const first = await new Memory(store).synthesizeDue();
	assert.equal(first.due, false);
	assert.equal(first.newSemanticNotes, 1);
	assert.equal(first.threshold, 2);

	await writeText(join(store, "semantic", "two.md"), `---\nupdated: ${oneDayAgo}\n---\n# Two\n\nSecond new note.\n`);
	const second = await new Memory(store).synthesizeDue();
	assert.equal(second.due, true);
	assert.equal(second.reason, "new_notes");
	assert.equal(second.newSemanticNotes, 2);
});

test("synthesizeDue triggers when the narrative is stale", async () => {
	const store = await tempStore();
	await writeText(
		join(store, ".her", "config.yaml"),
		["llm:", "  base_url: https://api.deepseek.com", "cadence:", "  synthesize_stale_after_days: 1", ""].join("\n"),
	);
	await writeText(join(store, ".her", "state.json"), JSON.stringify({ last_synthesize: "2000-01-01" }));

	const due = await new Memory(store).synthesizeDue();

	assert.equal(due.due, true);
	assert.equal(due.reason, "stale");
	assert.ok((due.daysSinceLastSynthesize ?? 0) > 1);
});

test("synthesizeDue triggers immediately on a new challenge relation", async () => {
	const store = await tempStore();
	await writeText(join(store, ".her", "state.json"), JSON.stringify({ last_synthesize: "2026-06-01" }));
	await writeText(
		join(store, "semantic", "challenge.md"),
		'---\nupdated: 2026-06-02\nrelations:\n  - {"to":"old-belief","rel":"challenges"}\n---\n# Challenge\n\nThis contradicts an older belief.\n',
	);

	const due = await new Memory(store).synthesizeDue();

	assert.equal(due.due, true);
	assert.equal(due.reason, "conflict");
	assert.equal(due.hasConflict, true);
});

test("approve promotes a legacy proposal through a reviewable context update without changing FACTS", async () => {
	const store = await tempStore();
	await writeText(join(store, "narrative", "FACTS.md"), "Fei is the owner.\n");
	await writeText(join(store, "proposals", "manual.md"), "# CONTEXT\n\nManual proposal becomes reviewable.\n");
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: fixtures");
	const factsBefore = await readText(join(store, "narrative", "FACTS.md"));

	const memory = new Memory(store);
	await memory.approve("manual");

	assert.match((await readText(join(store, "narrative", "CONTEXT.md"))) ?? "", /Manual proposal/);
	assert.equal(await readText(join(store, "narrative", "FACTS.md")), factsBefore);
	const review = await memory.reviewContextUpdates();
	assert.equal(review.length, 1);
	assert.equal(review[0].change, "Approve proposal manual");
});

test("buildTopicMaps and generateIdeas write derived markdown surfaces", async () => {
	const store = await tempStore();
	let call = 0;
	const prompts: string[] = [];
	const memory = new Memory(store, {
		complete(prompt) {
			prompts.push(prompt);
			call++;
			if (call === 1) {
				return JSON.stringify({
					maps: [
						{
							theme: "Verification Practice",
							summary: "Machine truth before closure.",
							members: ["verification"],
						},
					],
				});
			}
			return JSON.stringify({
				ideas: [
					{
						title: "Verification as intimacy",
						connects: ["verification", "samantha/collection/quiet-signal"],
						insight: "Reliability and the quiet-signal fragment both treat care as proof, not volume.",
						spark: "Make every close-out prove what changed, then surface it quietly.",
						kind: "self-x-world",
					},
				],
			});
		},
	});
	await writeText(
		join(store, "semantic", "verification.md"),
		"---\ntype: opinion\n---\n# Verification\n\nMachine truth first.\n",
	);
	await writeText(
		join(store, "samantha", "collection", "quiet-signal.md"),
		"---\ntype: spark\n---\n# Quiet Signal\n\nSamantha likes proof that does not need to announce itself loudly.\n",
	);

	assert.deepEqual(await memory.buildTopicMaps(), ["verification-practice"]);
	const ideas = await memory.generateIdeas();

	assert.equal(ideas[0].title, "Verification as intimacy");
	assert.match(prompts[1], /samantha\/collection\/quiet-signal/);
	assert.match((await readText(join(store, "topics", "verification-practice.md"))) ?? "", /Machine truth/);
	const ideaFiles = await import("node:fs/promises").then((fs) => fs.readdir(join(store, "ideas")));
	assert.equal(ideaFiles.length, 1);
	assert.match((await readText(join(store, "ideas", ideaFiles[0]))) ?? "", /quiet-signal/);
});

test("context updates are logged, reviewable, keepable, and revertible", async () => {
	const store = await tempStore();
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	const memory = new Memory(store);

	const first = await memory.writeContextUpdate({
		content: "# CONTEXT\n\nFei wants verified state first.\n",
		change: "Prefer verified state before reassurance",
		type: "identity",
		drivenBy: ["[[episodic/raw/episode-1]]"],
	});

	assert.match(first.id, /^[0-9a-f]{8}$/);
	assert.match((await readText(join(store, "narrative", "CONTEXT.md"))) ?? "", /verified state/);
	assert.match((await readText(join(store, "narrative", "context-log.md"))) ?? "", /status: unreviewed/);
	assert.match((await git(store, "log", "--oneline", "-1")).stdout, /memory\(context\): Prefer verified state/);

	const review = await memory.reviewContextUpdates();
	assert.equal(review.length, 1);
	assert.equal(review[0].id, first.id);
	assert.equal(review[0].status, "unreviewed");
	assert.match(review[0].commit ?? "", /^[0-9a-f]{7,40}$/);

	await memory.keepContextUpdate(first.id);
	assert.equal((await memory.reviewContextUpdates()).length, 0);
	assert.match((await readText(join(store, "narrative", "context-log.md"))) ?? "", /status: kept/);

	const second = await memory.writeContextUpdate({
		content: "# CONTEXT\n\nFei wants an unreviewed change that can be reverted.\n",
		change: "Temporary interpretation",
		type: "revise",
		drivenBy: ["[[episodic/raw/episode-2]]"],
	});
	await memory.revertContextUpdate(second.id);

	assert.doesNotMatch((await readText(join(store, "narrative", "CONTEXT.md"))) ?? "", /Temporary/);
	assert.match((await readText(join(store, "narrative", "context-log.md"))) ?? "", /status: reverted/);
	assert.equal((await memory.reviewContextUpdates()).length, 0);
});

test("context update commits do not sweep unrelated dirty memory files", async () => {
	const store = await tempStore();
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await writeText(join(store, "semantic", "unrelated.md"), "# Unrelated\n\nDo not commit me yet.\n");

	await new Memory(store).writeContextUpdate({
		content: "# CONTEXT\n\nA scoped context update.\n",
		change: "Scoped context update",
		type: "revise",
		drivenBy: ["[[episodic/raw/turn-1]]"],
	});

	assert.doesNotMatch((await git(store, "show", "--name-only", "--format=", "HEAD")).stdout, /semantic\/unrelated/);
	assert.match((await git(store, "status", "--short")).stdout, /\?\? semantic\//);
});

test("writeIdea stores subagent ideas in ideas namespace", async () => {
	const store = await tempStore();
	const id = await new Memory(store).writeIdea({
		title: "Mirror should wait for purpose",
		content: "Surface memory only when it changes the next action.",
		connections: ["memory-is-purpose", "her-system"],
		source: "idea-engine",
	});

	const files = await import("node:fs/promises").then((fs) => fs.readdir(join(store, "ideas")));
	assert.equal(files.length, 1);
	const text = (await readText(join(store, "ideas", files[0]))) ?? "";
	const parsed = parseFrontmatter(text);
	assert.equal(parsed.data.id, id);
	assert.equal(parsed.data.source, "idea-engine");
	assert.match(parsed.body, /Surface memory only/);
	assert.match(parsed.body, /\[\[memory-is-purpose\]\]/);
});

test("surface waits for the shared store lock before state updates", async () => {
	const store = await tempStore();
	await writeText(join(store, "semantic", "mirror.md"), "# Mirror\n\nMirror should wait for purpose.\n");
	const lock = join(store, ".her", "lock");
	await writeText(lock, JSON.stringify({ at: Date.now() / 1000, host: "python", owner: "python-owner", pid: 999999 }));
	const memory = new Memory(store);
	let settled = false;
	const pending = memory.surface({ query: "Mirror purpose", sessionId: "locked", cooldownMinutes: 0 }).finally(() => {
		settled = true;
	});

	await sleep(50);
	assert.equal(settled, false);
	await rm(lock, { force: true });
	const hit = await pending;

	assert.equal(hit?.id, "semantic/mirror");
});
test("surface returns relevant memory with per-session cooldown and dedupe", async () => {
	const store = await tempStore();
	await writeText(join(store, "semantic", "mirror.md"), "# Mirror\n\nMirror should wait for purpose.\n");
	await writeText(join(store, "semantic", "memory.md"), "# Memory\n\nMemory is retained consequence.\n");
	const memory = new Memory(store);

	const first = await memory.surface({ query: "Mirror purpose", sessionId: "s1", cooldownMinutes: 0 });
	assert.equal(first?.id, "semantic/mirror");
	const second = await memory.surface({ query: "Mirror purpose", sessionId: "s1", cooldownMinutes: 0 });
	assert.notEqual(second?.id, first?.id);
	const blocked = await memory.surface({ query: "Memory", sessionId: "s2", cooldownMinutes: 30 });
	assert.ok(blocked);
	assert.equal(await memory.surface({ query: "Mirror", sessionId: "s2", cooldownMinutes: 30 }), undefined);
});

test("surface can use injected semantic rankings when lexical search is silent", async () => {
	const store = await tempStore();
	await writeText(
		join(store, "world", "latent.md"),
		"# Latent\n\nThis note is conceptually relevant but lexically distant.\n",
	);
	const semanticSearch: SearchBackend = async (_query, docs) =>
		docs.filter((doc) => doc.id === "world/latent").map((doc) => ({ ...doc, score: 1 }));
	const memory = new Memory(store, { semanticSearch });

	const hit = await memory.surface({ query: "unspoken association", sessionId: "semantic", cooldownMinutes: 0 });

	assert.equal(hit?.id, "world/latent");
	const state = await readJson<{ access?: Record<string, { count?: number }> }>(join(store, ".her", "state.json"), {});
	assert.equal(state.access?.["world/latent"]?.count, 1);
});

test("writeWorldNote writes contract sections and dedupes by content hash", async () => {
	const store = await tempStore();
	const memory = new Memory(store);
	const data = {
		title: "Agent Tool Throughput",
		sourceUrl: "https://example.com/agent-tools",
		sourceType: "article",
		contentHash: "hash-123",
		memoryStatus: "active" as const,
		extracted: "Agents call tools often.",
		coverage: "Read full article. Nothing skipped.",
		claims: [
			{
				claim: "Agents call tools often.",
				verdict: "supported" as const,
				evidence: "Source says agents call tools often.",
				sourceQuality: "primary" as const,
				caveats: "Fixture article only.",
			},
		],
		read: "The useful point is tool-call overhead.",
		steal: ["Measure per-call overhead"],
		connections: ["own-memory"],
		take: "Worth stealing for Samantha evals.",
		possibleMoves: ["Add a throughput eval"],
	};

	const first = await memory.writeWorldNote(data);
	const second = await memory.writeWorldNote(data);
	assert.equal(first, second);
	assert.deepEqual(await readJson(join(store, ".her", "seen.json"), {}), { "hash-123": first });

	const files = await import("node:fs/promises").then((fs) => fs.readdir(join(store, "world")));
	assert.equal(files.length, 1);
	const text = (await readText(join(store, "world", files[0]))) ?? "";
	const parsed = parseFrontmatter(text);
	assert.equal(parsed.data.claim_count, 1);
	assert.equal(parsed.data.supported_claims, 1);
	assert.equal(parsed.data.privacy, "public");
	assert.equal(parsed.data.provenance, "world-ingested");
	assert.match(text, /## Claim Ledger/);
	assert.match(text, /claim: Agents call tools often/);
	assert.match(text, /verdict: supported/);
	assert.match(text, /source_quality: primary/);
	assert.match(text, /## Coverage/);
	assert.match(text, /Nothing skipped/);
	assert.match(text, /## Judgment Trail/);
});

test("judgment and memory status update existing world note", async () => {
	const store = await tempStore();
	const memory = new Memory(store);
	const id = await memory.writeWorldNote({
		title: "Mirror Timing",
		sourceUrl: "https://example.com/mirror",
		sourceType: "article",
		contentHash: "hash-456",
		memoryStatus: "needs_deep_read",
		memoryStatusReason: "Only an orientation pass has been read.",
		extracted: "Mirror should wait.",
		coverage: "Orientation only.",
		read: "Timing matters.",
		steal: [],
		connections: [],
		take: "Needs deeper pass.",
		possibleMoves: [],
	});

	await memory.recordJudgment(id, { attraction: "timing", correction: "Do not over-trigger Mirror" });
	await memory.setMemoryStatus(id, "archive_only", "Useful but not urgent.");

	const text = (await readText(join(store, "world", "mirror-timing.md"))) ?? "";
	const parsed = parseFrontmatter(text);
	assert.equal(parsed.data.memory_status, "archive_only");
	assert.equal(parsed.data.memory_status_reason, "Useful but not urgent.");
	assert.match(parsed.body, /attraction: timing/);
	assert.match(parsed.body, /correction: Do not over-trigger Mirror/);
	assert.match(parsed.body, /reason: Useful but not urgent/);
});

test("writeWorldNote requires and stores a reason for inactive memory status", async () => {
	const store = await tempStore();
	const memory = new Memory(store);
	const base = {
		title: "Needs Deep Read",
		sourceUrl: "https://example.com/deep",
		sourceType: "article",
		contentHash: "hash-status-reason",
		memoryStatus: "needs_deep_read" as const,
		extracted: "Only the abstract was available.",
		coverage: "Orientation only: abstract read; body unavailable.",
		read: "The source may matter but cannot be trusted as fully read yet.",
		steal: [],
		connections: [],
		take: "Keep as a stub until the full article can be read.",
		possibleMoves: [],
	};

	await assert.rejects(() => memory.writeWorldNote(base), /requires memoryStatusReason/);

	const noteId = await memory.writeWorldNote({
		...base,
		memoryStatusReason: "Full article body was unavailable, so this is only an orientation stub.",
	});

	assert.match(noteId, /^[0-9a-f]{8}$/);
	const text = (await readText(join(store, "world", "needs-deep-read.md"))) ?? "";
	const parsed = parseFrontmatter(text);
	assert.equal(parsed.data.memory_status, "needs_deep_read");
	assert.equal(
		parsed.data.memory_status_reason,
		"Full article body was unavailable, so this is only an orientation stub.",
	);
	assert.match(text, /## Memory Status/);
	assert.match(text, /reason: Full article body was unavailable/);
});

test("synthesizeChoiceModel distills Judgment Trail into a traceable choice model update", async () => {
	const store = await tempStore();
	let prompt = "";
	const memory = new Memory(store, {
		complete(input, options) {
			assert.equal(options?.strong, true);
			prompt = input;
			return "# CHOICE MODEL\n\nFei prefers small reversible moves with verified evidence.\n";
		},
	});
	await writeText(join(store, "narrative", "FACTS.md"), "Fei is the owner.\n");
	await writeText(join(store, "narrative", "CONTEXT.md"), "# CONTEXT\n\nFei values verified state.\n");
	const factsBefore = await readText(join(store, "narrative", "FACTS.md"));
	const contextBefore = await readText(join(store, "narrative", "CONTEXT.md"));
	const noteId = await memory.writeWorldNote({
		title: "Mirror Timing",
		sourceUrl: "https://example.com/mirror",
		sourceType: "article",
		contentHash: "hash-choice",
		memoryStatus: "active",
		extracted: "Mirror should wait for the right moment.",
		coverage: "Read short article.",
		read: "Timing matters.",
		steal: [],
		connections: [],
		take: "Useful for active-work interruption rules.",
		possibleMoves: [],
	});
	await memory.recordJudgment(noteId, {
		choice: "keep only if it changes the next action",
		correction: "Prefer small reversible moves with verified evidence.",
	});
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: fixtures");

	const result = await memory.synthesizeChoiceModel();

	assert.match(result.id, /^[0-9a-f]{8}$/);
	assert.match((await readText(join(store, "narrative", "CHOICE-MODEL.md"))) ?? "", /small reversible moves/);
	assert.equal(await readText(join(store, "narrative", "FACTS.md")), factsBefore);
	assert.equal(await readText(join(store, "narrative", "CONTEXT.md")), contextBefore);
	assert.match((await readText(join(store, "narrative", "choice-model-log.md"))) ?? "", new RegExp(result.id));
	assert.match(
		(await readText(join(store, "narrative", "choice-model-log.md"))) ?? "",
		/\[\[world\/mirror-timing\]\]/,
	);
	assert.match((await git(store, "log", "--oneline", "-1")).stdout, /memory\(choice\): Synthesize choice model/);
	assert.match(prompt, /JUDGMENT TRAILS/);
	assert.match(prompt, /Prefer small reversible moves/);
	assert.match(prompt, /world\/mirror-timing/);
});

test("synthesizeSelfNarrative distills becoming evidence into a traceable Samantha update", async () => {
	const store = await tempStore();
	let prompt = "";
	const memory = new Memory(store, {
		complete(input, options) {
			assert.equal(options?.strong, true);
			prompt = input;
			return "# SAMANTHA\n\nSamantha learned that verified state is part of care, not just procedure.\n";
		},
	});
	await writeText(join(store, "narrative", "FACTS.md"), "Fei is the owner.\n");
	await writeText(join(store, "narrative", "CONTEXT.md"), "# CONTEXT\n\nFei values verified state.\n");
	await writeText(join(store, "narrative", "CHOICE-MODEL.md"), "# CHOICE MODEL\n\nPrefer reversible moves.\n");
	await writeText(
		join(store, "narrative", "becoming-moments.md"),
		"- 2026-06-05 · trigger: Fei was confused · shift: Samantha should state machine truth first\n",
	);
	await writeText(
		join(store, "recognitions", "verified-care.md"),
		"---\nid: rec-1\nstatus: new\n---\n# Verified Care\n\nSamantha noticed that calm verification helps Fei feel less alone.\n",
	);
	await git(store, "init");
	await git(store, "config", "user.name", "Her Test");
	await git(store, "config", "user.email", "her-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: fixtures");
	const factsBefore = await readText(join(store, "narrative", "FACTS.md"));
	const contextBefore = await readText(join(store, "narrative", "CONTEXT.md"));
	const choiceBefore = await readText(join(store, "narrative", "CHOICE-MODEL.md"));

	const result = await memory.synthesizeSelfNarrative();

	assert.match(result.id, /^[0-9a-f]{8}$/);
	assert.match((await readText(join(store, "narrative", "SAMANTHA.md"))) ?? "", /verified state is part of care/);
	assert.equal(await readText(join(store, "narrative", "FACTS.md")), factsBefore);
	assert.equal(await readText(join(store, "narrative", "CONTEXT.md")), contextBefore);
	assert.equal(await readText(join(store, "narrative", "CHOICE-MODEL.md")), choiceBefore);
	const log = (await readText(join(store, "narrative", "self-narrative-log.md"))) ?? "";
	assert.match(log, new RegExp(result.id));
	assert.match(log, /\[\[narrative\/becoming-moments\]\]/);
	assert.match(log, /\[\[recognitions\/verified-care\]\]/);
	assert.match((await git(store, "log", "--oneline", "-1")).stdout, /memory\(self\): Synthesize self narrative/);
	assert.match(prompt, /SAMANTHA SELF-EVIDENCE/);
	assert.match(prompt, /machine truth first/);
	assert.match(prompt, /Verified Care/);
});

test("frontmatter round-trips strings that look like other scalar types", () => {
	const command = ["node", "-e", "1"];
	const { data } = parseFrontmatter(
		frontmatter({ command, port: "8080", flag: "true", missing: "null", json: "[1]" }),
	);
	assert.deepEqual(data.command, command);
	assert.equal(data.port, "8080");
	assert.equal(data.flag, "true");
	assert.equal(data.missing, "null");
	assert.equal(data.json, "[1]");

	const typed = parseFrontmatter(frontmatter({ count: 3, done: true, none: null })).data;
	assert.equal(typed.count, 3);
	assert.equal(typed.done, true);
	assert.equal(typed.none, null);
});
