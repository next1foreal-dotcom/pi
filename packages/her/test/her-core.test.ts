import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	checkpointLongTask,
	completeLongTask,
	initStore,
	listLongTasks,
	Memory,
	parseFrontmatter,
	readJson,
	readText,
	SEED_CHOICE_MODEL,
	SEED_CONTEXT,
	SEED_SELF_NARRATIVE,
	type SearchBackend,
	startLongTask,
	writeJson,
	writeText,
} from "../src/her-core/index.ts";

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
	assert.match(parsed.body, /memory layer/);

	const daily = await readText(join(store, "episodic", "2026-06-02.md"));
	assert.match(daily ?? "", /## sess01/);
	assert.match(daily ?? "", /project: her/);
	assert.match(daily ?? "", /prefers Z/);
	assert.match(daily ?? "", /summary_pending: false/);
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

test("initStore and getContext expose context, facts, self narrative, and choice model", async () => {
	const store = await tempStore();
	const context = await new Memory(store).getContext();
	assert.equal(context.context, SEED_CONTEXT);
	assert.equal(context.facts, "");
	assert.equal(context.self, SEED_SELF_NARRATIVE);
	assert.equal(context.choiceModel, SEED_CHOICE_MODEL);
	assert.equal(await readText(join(store, "narrative", "SAMANTHA.md")), SEED_SELF_NARRATIVE);
	assert.equal(await readText(join(store, "narrative", "CHOICE-MODEL.md")), SEED_CHOICE_MODEL);

	await writeText(join(store, "narrative", "FACTS.md"), "Fei is the owner.\n");
	await writeText(join(store, "narrative", "SAMANTHA.md"), "# SAMANTHA\n\nSamantha learned to verify first.\n");
	await writeText(join(store, "narrative", "CHOICE-MODEL.md"), "# CHOICE MODEL\n\nPrefer verified small steps.\n");
	const updated = await new Memory(store).getContext();
	assert.match(updated.facts, /Fei/);
	assert.match(updated.self, /verify first/);
	assert.match(updated.choiceModel, /verified small steps/);
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
	assert.deepEqual(parsed.data.relations, [{ to: "agent-work-style", rel: "proves" }]);
	assert.match(parsed.body, /Fei trusts machine truth/);
	assert.match((await readText(join(store, "narrative", "becoming-moments.md"))) ?? "", /Samantha should report/);
	assert.equal((await readJson<{ cursor?: string }>(join(store, ".her", "state.json"), {})).cursor, "2026-06-03T1200");
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
	assert.match(prompts[0].prompt, /SAMANTHA SELF-NARRATIVE/);
	assert.match(prompts[0].prompt, /Samantha is learning concise execution/);
	assert.match(prompts[0].prompt, /CHOICE MODEL/);
	assert.match(prompts[0].prompt, /Fei chooses verified work/);
});

test("synthesizeDue waits for the configured count of new semantic notes", async () => {
	const store = await tempStore();
	await writeText(
		join(store, ".her", "config.yaml"),
		["llm:", "  base_url: https://api.deepseek.com", "cadence:", "  synthesize_after_new_notes: 2", ""].join("\n"),
	);
	await writeText(join(store, ".her", "state.json"), JSON.stringify({ last_synthesize: "2026-06-01" }));
	await writeText(join(store, "semantic", "one.md"), "---\nupdated: 2026-06-02\n---\n# One\n\nFirst new note.\n");

	const first = await new Memory(store).synthesizeDue();
	assert.equal(first.due, false);
	assert.equal(first.newSemanticNotes, 1);
	assert.equal(first.threshold, 2);

	await writeText(join(store, "semantic", "two.md"), "---\nupdated: 2026-06-03\n---\n# Two\n\nSecond new note.\n");
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

test("synthesizeDue triggers immediately on a new conflict relation", async () => {
	const store = await tempStore();
	await writeText(join(store, ".her", "state.json"), JSON.stringify({ last_synthesize: "2026-06-01" }));
	await writeText(
		join(store, "semantic", "conflict.md"),
		'---\nupdated: 2026-06-02\nrelations:\n  - {"to":"old-belief","rel":"conflicts"}\n---\n# Conflict\n\nThis contradicts an older belief.\n',
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
	const memory = new Memory(store, {
		complete() {
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
						connects: ["verification"],
						insight: "Reliability can be a relational signal.",
						spark: "Make every close-out prove what changed.",
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

	assert.deepEqual(await memory.buildTopicMaps(), ["verification-practice"]);
	const ideas = await memory.generateIdeas();

	assert.equal(ideas[0].title, "Verification as intimacy");
	assert.match((await readText(join(store, "topics", "verification-practice.md"))) ?? "", /Machine truth/);
	const ideaFiles = await import("node:fs/promises").then((fs) => fs.readdir(join(store, "ideas")));
	assert.equal(ideaFiles.length, 1);
	assert.match((await readText(join(store, "ideas", ideaFiles[0]))) ?? "", /Reliability can be/);
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
