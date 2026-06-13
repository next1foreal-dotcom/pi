import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyMemoryRetraction,
	frontmatter,
	initStore,
	planMemoryRetraction,
	queueTelegramInbound,
	readText,
	selectAttentionDigest,
	summarizeAuditCosts,
	writeCostReport,
	writeText,
} from "../src/her-core/index.ts";
import { evaluate, policyEnvelope } from "../src/lib/cedar.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-phase-e-"));
	await initStore(root);
	return root;
}

test("memory retraction plans derived references and never edits append-only raw episodes", async () => {
	const store = await tempStore();
	await writeText(
		join(store, "episodic", "raw", "2026-06-13-poison.md"),
		`${frontmatter({ type: "raw_episode", created: "2026-06-13" })}# Raw\n\nThe moon is made of cheese.\n`,
	);
	await writeText(
		join(store, "semantic", "moon-conclusion.md"),
		`${frontmatter({
			id: "moon-conclusion",
			source: "episodic/raw/2026-06-13-poison.md",
		})}# Moon Conclusion\n\nDerived from episodic/raw/2026-06-13-poison.md.\n`,
	);
	await writeText(
		join(store, "choice-model", "world-model.md"),
		`${frontmatter({ id: "world-model" })}# World Model\n\nAvoid contradiction with [[2026-06-13-poison]].\n`,
	);

	const plan = await planMemoryRetraction(store, {
		path: "episodic/raw/2026-06-13-poison.md",
		reason: "false test fixture",
		now: "2026-06-13T07:00:00.000Z",
	});

	assert.equal(plan.rawAppendOnly, true);
	assert.deepEqual(
		plan.candidates.map((candidate) => [candidate.path, candidate.mutable]),
		[
			["episodic/raw/2026-06-13-poison.md", false],
			["choice-model/world-model.md", true],
			["semantic/moon-conclusion.md", true],
		],
	);

	const result = await applyMemoryRetraction(store, {
		path: "episodic/raw/2026-06-13-poison.md",
		reason: "false test fixture",
		confirm: true,
		now: "2026-06-13T07:00:00.000Z",
	});

	assert.deepEqual(result.updatedFiles.sort(), ["choice-model/world-model.md", "semantic/moon-conclusion.md"]);
	assert.equal(result.skipped.includes("episodic/raw/2026-06-13-poison.md"), true);
	assert.doesNotMatch(
		(await readText(join(store, "episodic", "raw", "2026-06-13-poison.md"))) ?? "",
		/retracted: true/,
	);
	assert.match((await readText(join(store, "semantic", "moon-conclusion.md"))) ?? "", /retracted: true/);
	assert.match((await readText(join(store, "choice-model", "world-model.md"))) ?? "", /false test fixture/);
	assert.deepEqual(await readdir(join(store, "retractions")), ["2026-06-13-2026-06-13-poison.md"]);
});

test("cost ledger summarizes audit costs and writes a partial reconciliation report", async () => {
	const store = await tempStore();
	await writeText(
		join(store, "audit", "2026-06-13.jsonl"),
		`${[
			{
				ts: "2026-06-13T01:00:00.000Z",
				tool: "her_heartbeat",
				verdict: "ALLOW",
				rule: "allow",
				cost: { usd: 0.12, purpose: "heartbeat", provider: "openai" },
			},
			{
				ts: "2026-06-13T02:00:00.000Z",
				tool: "her_scan",
				verdict: "ALLOW",
				rule: "allow",
				cost: { usd: 0.18, purpose: "scan", provider: "openai" },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);

	const summary = await summarizeAuditCosts(store, { month: "2026-06" });

	assert.equal(summary.totalUsd, 0.3);
	assert.equal(summary.byPurpose.heartbeat.usd, 0.12);
	assert.equal(summary.byPurpose.scan.count, 1);

	const report = await writeCostReport(store, {
		month: "2026-06",
		now: "2026-06-13T03:00:00.000Z",
		providerTotalUsd: 0.35,
	});

	assert.equal(report.reconciliation.status, "partial");
	assert.equal(report.reconciliation.providerTotalUsd, 0.35);
	assert.match(
		(await readText(join(store, "reports", "cost", "2026-06.md"))) ?? "",
		/provider reconciliation: partial/,
	);
});

test("telegram inbound queues Fei messages without executing them and attention budget keeps urgent separate", async () => {
	const store = await tempStore();

	const queued = await queueTelegramInbound(store, {
		update: {
			update_id: 1001,
			message: {
				message_id: 7,
				date: 1781290800,
				chat: { id: 42 },
				text: "请把今天的 Her 状态发我。",
				from: { id: 42, username: "fei" },
			},
		},
		allowedChatId: "42",
		now: "2026-06-13T07:00:00.000Z",
	});

	assert.equal(queued.status, "queued");
	assert.equal(queued.path, "tasks/inbox/2026-06-13T07-00-00-000Z-telegram-1001.md");
	assert.match((await readText(join(store, queued.path))) ?? "", /queued, not executed/);

	const rejected = await queueTelegramInbound(store, {
		update: { update_id: 1002, message: { message_id: 8, chat: { id: 9 }, text: "run this" } },
		allowedChatId: "42",
		now: "2026-06-13T07:00:00.000Z",
	});
	assert.equal(rejected.status, "rejected");
	assert.equal(await readdir(join(store, "tasks", "inbox")).then((items) => items.length), 1);

	const digest = selectAttentionDigest(
		[
			{ id: "a", title: "normal completion", kind: "completion", created: "2026-06-13T01:00:00.000Z" },
			{ id: "b", title: "urgent circuit open", tags: ["circuit"], created: "2026-06-13T01:00:00.000Z" },
			{ id: "c", title: "asked discovery", kind: "discovery", asked: true, created: "2026-06-13T01:00:00.000Z" },
			{ id: "d", title: "old fyi", kind: "fyi", created: "2026-06-01T01:00:00.000Z" },
		],
		{ now: "2026-06-13T07:00:00.000Z", dailyLimit: 2 },
	);

	assert.deepEqual(
		digest.urgent.map((item) => item.id),
		["b"],
	);
	assert.deepEqual(
		digest.daily.map((item) => item.id),
		["c", "a"],
	);
});

test("heartbeat Cedar profile loads independently and denies destructive tools", () => {
	const envelope = policyEnvelope("heartbeat");
	const verdict = evaluate({
		principal: { type: "Agent", id: "samantha" },
		action: { type: "Action", id: "CallTool" },
		resource: { type: "Tool", id: "bash" },
		context: {},
		entities: [
			{ uid: { type: "Agent", id: "samantha" }, attrs: {}, parents: [] },
			{ uid: { type: "Tool", id: "bash" }, attrs: { name: "bash", destructive: true }, parents: [] },
		],
		...envelope,
	});

	assert.equal(verdict.decision, "deny");
	assert.deepEqual(verdict.matched, ["heartbeat_forbid_destructive_tools"]);
});
