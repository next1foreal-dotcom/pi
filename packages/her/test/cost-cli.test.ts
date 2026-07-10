import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { runHerCli } from "../src/cli.ts";
import { summarizeAuditCosts, summarizeCostBreakdown } from "../src/her-core/cost-ledger.ts";
import { writeText } from "../src/her-core/store.ts";

const execFileAsync = promisify(execFile);

async function tempCostStore(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "her-cost-cli-"));
}

async function tempGitCostStore(): Promise<string> {
	const root = await tempCostStore();
	await execFileAsync("git", ["init"], { cwd: root });
	return root;
}

async function commitCostStoreBaseline(root: string): Promise<void> {
	await execFileAsync("git", ["config", "user.name", "Her Cost CLI Test"], { cwd: root });
	await execFileAsync("git", ["config", "user.email", "her-cost-cli-test@example.com"], { cwd: root });
	await execFileAsync("git", ["add", "-A"], { cwd: root });
	await execFileAsync("git", ["commit", "--allow-empty", "-m", "memory: init"], { cwd: root });
}

async function runCostCli(args: string[], store: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const stdout = stringWritable();
	const stderr = stringWritable();
	const code = await runHerCli(args, { ...process.env, HER_MEMORY_DIR: store }, store, {
		stdout: stdout.stream,
		stderr: stderr.stream,
	});
	return { code, stdout: stdout.read(), stderr: stderr.read() };
}

function stringWritable(): { read: () => string; stream: NodeJS.WritableStream } {
	let output = "";
	return {
		read: () => output,
		stream: new Writable({
			write(chunk, _encoding, callback) {
				output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
				callback();
			},
		}),
	};
}

function auditLine(entry: unknown): string {
	return `${JSON.stringify(entry)}\n`;
}

test("T1 summarizeCostBreakdown returns a zeroed breakdown when the audit directory is missing", async () => {
	const store = await tempCostStore();

	const result = await summarizeCostBreakdown(store, { now: "2026-07-10T12:00:00.000Z" });

	assert.equal(result.entries, 0);
	assert.equal(result.monthUsd, 0);
	assert.equal(result.todayUsd, 0);
	assert.equal(result.month, "2026-07");
	assert.equal(result.today, "2026-07-10");
	assert.deepEqual(result.byDay, []);
	assert.deepEqual(result.byProvider, []);
});

test("T2 summarizeCostBreakdown groups entries by day and provider and isolates today's total", async () => {
	const store = await tempCostStore();
	await writeText(
		join(store, "audit", "2026-07-08.jsonl"),
		[
			auditLine({
				ts: "2026-07-08T01:00:00.000Z",
				tool: "her_heartbeat",
				verdict: "ALLOW",
				rule: "allow",
				cost: { usd: 0.1, provider: "openai" },
			}),
			auditLine({
				ts: "2026-07-08T02:00:00.000Z",
				tool: "her_heartbeat",
				verdict: "ALLOW",
				rule: "allow",
				cost: { usd: 0.05, provider: "openai" },
			}),
		].join(""),
	);
	await writeText(
		join(store, "audit", "2026-07-09.jsonl"),
		auditLine({
			ts: "2026-07-09T03:00:00.000Z",
			tool: "her_scan",
			verdict: "ALLOW",
			rule: "allow",
			cost: { usd: 0.2, provider: "anthropic" },
		}),
	);
	await writeText(
		join(store, "audit", "2026-07-10.jsonl"),
		auditLine({
			ts: "2026-07-10T04:00:00.000Z",
			tool: "her_dispatch",
			verdict: "ALLOW",
			rule: "allow",
			cost: { usd: 0.07 },
		}),
	);

	const result = await summarizeCostBreakdown(store, { now: "2026-07-10T12:00:00.000Z" });

	assert.equal(result.entries, 4);
	assert.equal(result.monthUsd, 0.42);
	assert.equal(result.today, "2026-07-10");
	assert.equal(result.todayUsd, 0.07);
	assert.deepEqual(
		result.byDay.map((bucket) => [bucket.date, bucket.usd, bucket.count]),
		[
			["2026-07-08", 0.15, 2],
			["2026-07-09", 0.2, 1],
			["2026-07-10", 0.07, 1],
		],
	);
	assert.deepEqual(
		result.byProvider.map((bucket) => [bucket.provider, bucket.usd, bucket.count]),
		[
			["anthropic", 0.2, 1],
			["openai", 0.15, 2],
			["unknown", 0.07, 1],
		],
	);
});

test("T3 summarizeCostBreakdown skips entries without a finite cost and entries outside the requested month", async () => {
	const store = await tempCostStore();
	await writeText(
		join(store, "audit", "2026-07-05.jsonl"),
		[
			auditLine({ ts: "2026-07-05T01:00:00.000Z", tool: "her_heartbeat", verdict: "DENY", rule: "cap" }),
			auditLine({
				ts: "2026-07-05T02:00:00.000Z",
				tool: "her_heartbeat",
				verdict: "ALLOW",
				rule: "allow",
				cost: { usd: 0.3, provider: "openai" },
			}),
		].join(""),
	);
	await writeText(
		join(store, "audit", "2026-06-30.jsonl"),
		auditLine({
			ts: "2026-06-30T23:00:00.000Z",
			tool: "her_scan",
			verdict: "ALLOW",
			rule: "allow",
			cost: { usd: 9, provider: "openai" },
		}),
	);

	const result = await summarizeCostBreakdown(store, { now: "2026-07-10T12:00:00.000Z" });

	// entries counts every audit-log line (including the cost-less DENY), matching
	// summarizeAuditCosts's own "entries" semantics; only monthUsd/byDay/byProvider filter by cost.
	assert.equal(result.entries, 2);
	assert.equal(result.monthUsd, 0.3);
	assert.equal(result.todayUsd, 0);
});

test("T4 her cost --json output is same-source consistent with summarizeAuditCosts", async () => {
	const store = await tempGitCostStore();
	const now = new Date().toISOString();
	const today = now.slice(0, 10);
	const month = now.slice(0, 7);
	await writeText(
		join(store, "audit", `${today}.jsonl`),
		[
			auditLine({
				ts: now,
				tool: "her_heartbeat",
				verdict: "ALLOW",
				rule: "allow",
				cost: { usd: 0.12, provider: "openai" },
			}),
			auditLine({
				ts: now,
				tool: "her_scan",
				verdict: "ALLOW",
				rule: "allow",
				cost: { usd: 0.08, provider: "anthropic" },
			}),
		].join(""),
	);
	await commitCostStoreBaseline(store);

	const jsonResult = await runCostCli(["cost", "--json"], store);
	assert.equal(jsonResult.code, 0, jsonResult.stderr);
	const payload = JSON.parse(jsonResult.stdout) as {
		result?: { entries?: number; month?: string; monthUsd?: number; today?: string; todayUsd?: number };
	};
	assert.equal(payload.result?.month, month);
	assert.equal(payload.result?.today, today);
	assert.equal(payload.result?.entries, 2);
	assert.equal(payload.result?.monthUsd, 0.2);
	assert.equal(payload.result?.todayUsd, 0.2);

	const sameSource = await summarizeAuditCosts(store, { month });
	assert.equal(payload.result?.monthUsd, sameSource.totalUsd);
	assert.equal(payload.result?.entries, sameSource.entries);

	const humanResult = await runCostCli(["cost"], store);
	assert.equal(humanResult.code, 0, humanResult.stderr);
	assert.match(humanResult.stdout, /Her cost \d{4}-\d{2}: \$0\.2000 across 2 entries\./);
	assert.match(humanResult.stdout, /today \(\d{4}-\d{2}-\d{2}\): \$0\.2000/);
});

test("T5 her cost renders gracefully when no audit ledger exists yet", async () => {
	const store = await tempGitCostStore();
	await commitCostStoreBaseline(store);

	const result = await runCostCli(["cost"], store);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /Her cost \d{4}-\d{2}: \$0\.0000 across 0 entries\./);
	assert.match(result.stdout, /By day:\n {2}\(none\)/);
	assert.match(result.stdout, /By provider:\n {2}\(none\)/);

	const jsonResult = await runCostCli(["cost", "--json"], store);
	assert.equal(jsonResult.code, 0, jsonResult.stderr);
	const payload = JSON.parse(jsonResult.stdout) as { result?: { byDay?: unknown[]; byProvider?: unknown[] } };
	assert.deepEqual(payload.result?.byDay, []);
	assert.deepEqual(payload.result?.byProvider, []);
});
