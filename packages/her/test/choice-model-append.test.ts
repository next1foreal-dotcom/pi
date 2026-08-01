import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initStore, Memory, readText, writeText } from "../src/her-core/index.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-choice-append-"));
	await initStore(root);
	return root;
}

// 8/1 accident replay: real content pulled from D:\@Her\her-memory's git history
// (commit a27325a for rule A, working tree for rule B) via
// `git -C D:\@Her\her-memory log --follow -- choice-model/communication-tone.md`.
// Rule A used to be alone in the committed file; after Fei recorded rule B (a
// different rule, same domain) the working tree showed ONLY rule B — rule A's
// id 155ee91e, weight 3, and evidence were gone.
test("recordFeedback never drops an existing rule when a non-synonymous rule is recorded (8/1 accident replay)", async () => {
	const store = await tempStore();
	const memory = new Memory(store);

	await memory.recordFeedback({
		domain: "communication-tone",
		task: "B4 反馈学习验收：120 字以内中文 Her 项目状态摘要",
		diffSummary:
			"Fei 反馈第一版状态摘要仍像报告；不喜欢“目前/通过本地验证/仍只是”这类公文化表述。Evidence: B4 feedback round 1. Requested weight: 3.",
		rule: "给 Fei 写状态摘要时，要更直接、更口语。第一句先说结论，再说下一步；避免“目前/通过本地验证/仍只是”等偏公文措辞。",
		weight: 3,
		at: "2026-06-13T10:32:18.792Z",
	});

	await memory.recordFeedback({
		domain: "communication-tone",
		task: "Her 项目今日进展摘要",
		diffSummary:
			'Fei 重写了进展摘要：最重要的事实前置（G-101 合入），砍掉过程叙事（"最近一轮代码合流"→"全部收进"，"踩坑后切到"→"定在"），砍掉工具名（BACKLOG），状态报事实不报安排（"已完成"而非"剩下的要等"），例行心跳当脚注收尾。',
		rule: "写状态摘要时：最重要的事实放第一句，砍掉所有自述过程、工具名、未来安排；例行状态（心跳/同步）放到最后当脚注一句话。",
		weight: 2,
		at: "2026-08-01T18:02:30.696Z",
	});

	const file = (await readText(join(store, "choice-model", "communication-tone.md"))) ?? "";
	const marker = /<!-- her-choice-rules\n([\s\S]*?)\n-->/.exec(file);
	assert.ok(marker, "her-choice-rules marker block must be present");
	const rules = JSON.parse(marker[1]) as Array<{ id: string; rule: string; weight: number; evidence: unknown[] }>;

	assert.equal(rules.length, 2, "both rule A and rule B must survive as two distinct JSON entries");

	// Match by rule text/id, not a hardcoded legacy id: the real file's "155ee91e" id was a hash of an
	// earlier draft of rule A's text (one that still had a trailing "Weight: 3." the model wrote into the
	// rule field itself); a manual follow-up commit trimmed that suffix from the rule text but left the old
	// id in place, so a fresh recordFeedback() call on today's rule text legitimately mints a different id.
	// The invariant under test is content survival, not byte-identical id reproduction.
	const ruleA = rules.find((item) => item.rule.startsWith("给 Fei 写状态摘要时"));
	assert.ok(ruleA, "rule A (communication-tone opening line) must not be dropped");
	assert.equal(ruleA?.weight, 3, "rule A's weight must be unchanged");
	assert.equal(ruleA?.evidence.length, 1, "rule A's evidence must be unchanged");
	assert.match(file, /给 Fei 写状态摘要时，要更直接、更口语/);

	const ruleB = rules.find((item) => item.id === "a36b2946");
	assert.ok(ruleB, "rule B (a36b2946) must be recorded");
	assert.equal(ruleB?.weight, 2);
	assert.match(file, /写状态摘要时：最重要的事实放第一句/);
});

// Defensive hardening: parseChoiceRuleRecords silently returns [] when the her-choice-rules JSON
// block fails to parse (memory-utils.ts parseChoiceRuleRecords's catch-and-return-[] path). If that
// ever happens to a domain file that already carries the marker (as opposed to a fresh seed file,
// which has no marker at all), recordFeedback must refuse to write rather than silently treating the
// domain as rule-free and overwriting real history with a single new entry.
test("recordFeedback refuses to write when an existing her-choice-rules marker fails to parse", async () => {
	const store = await tempStore();
	const path = join(store, "choice-model", "communication-tone.md");
	await writeText(
		path,
		"# Communication Tone Rules\n\n## Active Rules\n\n(none)\n\n<!-- her-choice-rules\n{not valid json][\n-->\n",
	);
	const memory = new Memory(store);

	await assert.rejects(
		() =>
			memory.recordFeedback({
				domain: "communication-tone",
				task: "new task",
				diffSummary: "new diff",
				rule: "A brand new rule.",
				at: "2026-08-02T00:00:00.000Z",
			}),
		/her-choice-rules|parse|corrupt/i,
	);

	// The corrupted file must be left untouched, not silently replaced.
	const after = (await readText(path)) ?? "";
	assert.match(after, /not valid json/);
	assert.doesNotMatch(after, /A brand new rule\./);
});

test("recordFeedback accumulates weight and appends evidence for a synonymous rule instead of adding a new entry", async () => {
	const store = await tempStore();
	const memory = new Memory(store);

	await memory.recordFeedback({
		domain: "code-style",
		task: "first correction",
		diffSummary: "Use early returns.",
		rule: "Prefer early returns over nested if/else.",
		weight: 2,
		at: "2026-01-01T00:00:00.000Z",
	});
	// normalizeChoiceRule trims + lowercases + collapses whitespace, so this counts as the same rule
	// despite different casing/spacing/trailing text.
	await memory.recordFeedback({
		domain: "code-style",
		task: "second correction",
		diffSummary: "Same preference reinforced.",
		rule: "  PREFER EARLY   RETURNS over nested if/else.  ",
		weight: 3,
		at: "2026-01-02T00:00:00.000Z",
	});

	const file = (await readText(join(store, "choice-model", "code-style.md"))) ?? "";
	const marker = /<!-- her-choice-rules\n([\s\S]*?)\n-->/.exec(file);
	assert.ok(marker);
	const rules = JSON.parse(marker[1]) as Array<{
		id: string;
		rule: string;
		weight: number;
		evidence: Array<{ task: string }>;
	}>;

	assert.equal(rules.length, 1, "a synonymous rule must accumulate onto the existing entry, not add a new one");
	assert.equal(rules[0].weight, 5, "weight must accumulate (2 + 3)");
	assert.equal(rules[0].evidence.length, 2, "evidence must be appended, not replaced");
	assert.equal(rules[0].evidence[0].task, "first correction");
	assert.equal(rules[0].evidence[1].task, "second correction");
	// The stored rule text reflects the latest phrasing, trimmed (existing behavior, unchanged by this task).
	assert.equal(rules[0].rule, "PREFER EARLY   RETURNS over nested if/else.");
});

test("rendering buckets a stale rule under Stale Rules and a fresh rule under Active Rules while retaining both in the JSON block", async () => {
	const store = await tempStore();
	const memory = new Memory(store);

	// Rule A triggers once, 40 days before rule B is recorded -> stale relative to rule B's "now".
	await memory.recordFeedback({
		domain: "design-taste",
		task: "old design note",
		diffSummary: "Cut the drop shadows.",
		rule: "Flat design over skeuomorphism.",
		at: "2026-01-01T00:00:00.000Z",
	});
	// Rule B is a different rule, recorded 40 days later (> CHOICE_RULE_STALE_AFTER_DAYS of 30).
	await memory.recordFeedback({
		domain: "design-taste",
		task: "fresh design note",
		diffSummary: "Use warmer neutrals.",
		rule: "Warm neutrals over cool grays.",
		at: "2026-02-10T00:00:00.000Z",
	});

	const file = (await readText(join(store, "choice-model", "design-taste.md"))) ?? "";

	const activeSection = /## Active Rules\n\n([\s\S]*?)\n\n## Stale Rules/.exec(file)?.[1] ?? "";
	const staleSection = /## Stale Rules\n\n([\s\S]*?)\n\n<!--/.exec(file)?.[1] ?? "";
	assert.match(activeSection, /Warm neutrals over cool grays/, "fresh rule must render under Active Rules");
	assert.doesNotMatch(
		activeSection,
		/Flat design over skeuomorphism/,
		"stale rule must not render under Active Rules",
	);
	assert.match(staleSection, /Flat design over skeuomorphism/, "stale rule must render under Stale Rules");
	assert.doesNotMatch(staleSection, /Warm neutrals over cool grays/, "fresh rule must not render under Stale Rules");

	// The JSON block is the durable source of truth: both rules stay fully present regardless of section.
	const marker = /<!-- her-choice-rules\n([\s\S]*?)\n-->/.exec(file);
	assert.ok(marker);
	const rules = JSON.parse(marker[1]) as Array<{ rule: string; status: string }>;
	assert.equal(rules.length, 2, "both rules must remain in the JSON block");
	const staleRule = rules.find((item) => item.rule === "Flat design over skeuomorphism.");
	const activeRule = rules.find((item) => item.rule === "Warm neutrals over cool grays.");
	assert.equal(staleRule?.status, "stale");
	assert.equal(activeRule?.status, "active");
});
