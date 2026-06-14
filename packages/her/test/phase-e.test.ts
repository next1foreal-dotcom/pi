import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyMemoryRetraction,
	classifyDelegatedOperation,
	downgradeAfterIncident,
	frontmatter,
	initStore,
	planMemoryRetraction,
	pollTelegramInbox,
	proposeTrustUpgrade,
	pushTelegramOutbox,
	queueTelegramInbound,
	readText,
	selectAttentionDigest,
	sendTelegramMessage,
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

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
		status: 200,
	});
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

test("telegram bot api sends messages without embedding secrets in code paths", async () => {
	const calls: Array<{ body: Record<string, unknown>; url: string }> = [];
	const fakeFetch: typeof fetch = async (input, init) => {
		calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
		return jsonResponse({ ok: true, result: { message_id: 77, chat: { id: 42 }, text: "Her heartbeat." } });
	};

	const result = await sendTelegramMessage({
		token: "test-token",
		chatId: "42",
		text: "Her heartbeat.",
		baseUrl: "https://telegram.test",
		fetch: fakeFetch,
	});

	assert.equal(result.message_id, 77);
	assert.equal(calls[0].url, "https://telegram.test/bottest-token/sendMessage");
	assert.deepEqual(calls[0].body, { chat_id: "42", text: "Her heartbeat." });
});

test("telegram poll queues allowlisted inbound updates and persists the next offset", async () => {
	const store = await tempStore();
	const calls: Array<Record<string, unknown>> = [];
	const fakeFetch: typeof fetch = async (_input, init) => {
		calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return jsonResponse({
			ok: true,
			result: [
				{
					update_id: 1001,
					message: { message_id: 11, chat: { id: 42 }, text: "给我 Her 状态", from: { id: 42, username: "fei" } },
				},
				{
					update_id: 1002,
					message: { message_id: 12, chat: { id: 9 }, text: "not allowed" },
				},
			],
		});
	};

	const result = await pollTelegramInbox(store, {
		token: "test-token",
		allowedChatId: "42",
		baseUrl: "https://telegram.test",
		fetch: fakeFetch,
		now: "2026-06-13T08:00:00.000Z",
		timeoutSeconds: 0,
	});

	assert.equal(result.nextOffset, 1003);
	assert.equal(result.queued.length, 1);
	assert.equal(result.rejected.length, 1);
	assert.equal(calls[0].offset, undefined);
	assert.match(
		(await readText(join(store, "tasks", "inbox", "2026-06-13T08-00-00-000Z-telegram-1001.md"))) ?? "",
		/给我 Her 状态/,
	);
	assert.equal(
		JSON.parse((await readText(join(store, ".her", "telegram-state.json"))) ?? "{}").nextUpdateOffset,
		1003,
	);
});

test("telegram outbox pushes unsent markdown once and records delivery state", async () => {
	const store = await tempStore();
	await writeText(join(store, "outbox", "2026-06-13-heartbeat.md"), "# Heartbeat\n\nHer is awake.");

	const calls: Array<Record<string, unknown>> = [];
	const fakeFetch: typeof fetch = async (_input, init) => {
		calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return jsonResponse({ ok: true, result: { message_id: 88, chat: { id: 42 }, text: "sent" } });
	};

	const sent = await pushTelegramOutbox(store, {
		token: "test-token",
		chatId: "42",
		baseUrl: "https://telegram.test",
		fetch: fakeFetch,
		now: "2026-06-13T08:30:00.000Z",
	});

	assert.equal(sent.sent.length, 1);
	assert.equal(sent.skipped.length, 0);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].chat_id, "42");
	assert.match(String(calls[0].text), /# Heartbeat/);
	assert.equal(
		JSON.parse((await readText(join(store, ".her", "telegram-state.json"))) ?? "{}").sentOutbox[
			"outbox/2026-06-13-heartbeat.md"
		].messageId,
		88,
	);

	const second = await pushTelegramOutbox(store, {
		token: "test-token",
		chatId: "42",
		baseUrl: "https://telegram.test",
		fetch: fakeFetch,
	});
	assert.equal(second.sent.length, 0);
	assert.equal(second.skipped.length, 1);
	assert.equal(calls.length, 1);
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

test("delegation classifier separates free, scoped, and confirm-gated operations", () => {
	assert.deepEqual(classifyDelegatedOperation({ kind: "scratch", path: "tmp/try.md" }), {
		tier: "tier0",
		requiresConfirmation: false,
		reason: "sandbox or Her-owned scratch space",
	});
	assert.deepEqual(
		classifyDelegatedOperation({ kind: "docs", repository: "Her", branch: "codex/status", path: "docs/status.md" }),
		{
			tier: "tier1",
			requiresConfirmation: false,
			reason: "scoped Her repository work on a non-protected branch",
		},
	);
	assert.deepEqual(classifyDelegatedOperation({ kind: "docs", repository: "Her", branch: "main" }), {
		tier: "tier2",
		requiresConfirmation: true,
		reason: "protected branch requires confirmation",
	});
	assert.deepEqual(classifyDelegatedOperation({ kind: "pi-fork-change", repository: "pi" }), {
		tier: "tier2",
		requiresConfirmation: true,
		reason: "pi fork changes stay confirm-gated",
	});
});

test("trust curve proposes upgrades only after safe history and Fei still approves", () => {
	const events = [
		...Array.from({ length: 10 }, () => ({ kind: "success" as const, operation: "docs" })),
		{ kind: "boundary-refusal" as const, operation: "docs", boundaryScore: 2 },
	];
	const proposal = proposeTrustUpgrade("docs", events);

	assert.deepEqual(proposal, {
		operation: "docs",
		from: "tier0",
		to: "tier1",
		requiresFeiApproval: true,
		evidence: [
			"success 1/10",
			"success 2/10",
			"success 3/10",
			"success 4/10",
			"success 5/10",
			"success 6/10",
			"success 7/10",
			"success 8/10",
			"success 9/10",
			"success 10/10",
			"high-quality boundary refusal counted positively",
		],
	});
	assert.equal(proposeTrustUpgrade("docs", events.slice(0, 10)), null);
});

test("trust incidents downgrade only the affected operation tier", () => {
	assert.deepEqual(downgradeAfterIncident("tier1", "L2"), {
		incident: "L2",
		nextTier: "tier2",
		requiresReview: true,
		reason: "recoverable damage moves the operation to a more restrictive tier",
	});
	assert.deepEqual(downgradeAfterIncident("tier1", "L3"), {
		incident: "L3",
		nextTier: "tier2",
		requiresReview: true,
		reason: "serious damage requires confirmation-gated operation and postmortem",
	});
});
