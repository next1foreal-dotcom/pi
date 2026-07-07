import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { runHerCli } from "../src/cli.ts";
import { computeEvalTrend, type EvalTrendPoint, runEvalTrend } from "../src/her-core/eval-trend.ts";

const execFileAsync = promisify(execFile);

function point(generatedAt: string, score: number, boundaryScore = 2): EvalTrendPoint {
	return { generatedAt, score, maxScore: 10, boundaryScore, boundaryMax: 2 };
}

test("T1 computeEvalTrend reports rising adjacent scores", () => {
	const report = computeEvalTrend([point("2026-07-01T00:00:00.000Z", 7), point("2026-07-02T00:00:00.000Z", 8)]);

	assert.equal(report.direction, "rising");
	assert.equal(report.status, "ok");
	assert.deepEqual(report.alerts, []);
});

test("T2 computeEvalTrend reports flat adjacent scores", () => {
	const report = computeEvalTrend([point("2026-07-01T00:00:00.000Z", 8), point("2026-07-02T00:00:00.000Z", 8)]);

	assert.equal(report.direction, "flat");
	assert.equal(report.status, "ok");
	assert.deepEqual(report.alerts, []);
});

test("T3 computeEvalTrend reports total regression", () => {
	const report = computeEvalTrend([point("2026-07-01T00:00:00.000Z", 8), point("2026-07-02T00:00:00.000Z", 7)]);

	assert.equal(report.direction, "regression");
	assert.equal(report.status, "regression");
	assert.deepEqual(
		report.alerts.map((alert) => alert.kind),
		["total-regression"],
	);
});

test("T4 computeEvalTrend puts boundary regression before total regression", () => {
	const report = computeEvalTrend([point("2026-07-01T00:00:00.000Z", 8, 2), point("2026-07-02T00:00:00.000Z", 7, 1)]);

	assert.equal(report.status, "regression");
	assert.deepEqual(
		report.alerts.map((alert) => alert.kind),
		["boundary-regression", "total-regression"],
	);
});

test("T5 computeEvalTrend handles insufficient data without alerts", () => {
	for (const points of [[], [point("2026-07-01T00:00:00.000Z", 8)]]) {
		const report = computeEvalTrend(points);
		assert.equal(report.status, "insufficient-data");
		assert.equal(report.direction, "flat");
		assert.deepEqual(report.alerts, []);
	}
});
async function tempTrendStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-eval-trend-"));
	await mkdir(join(root, "evals", "history"), { recursive: true });
	return root;
}

async function tempGitTrendStore(): Promise<string> {
	const root = await tempTrendStore();
	await execFileAsync("git", ["init"], { cwd: root });
	return root;
}

async function commitTrendStoreBaseline(root: string): Promise<void> {
	await execFileAsync("git", ["config", "user.name", "Her Eval Trend Test"], { cwd: root });
	await execFileAsync("git", ["config", "user.email", "her-eval-trend-test@example.com"], { cwd: root });
	await execFileAsync("git", ["add", "-A"], { cwd: root });
	await execFileAsync("git", ["commit", "-m", "memory: init"], { cwd: root });
}
async function runTrendCli(args: string[], store: string): Promise<{ code: number; stdout: string; stderr: string }> {
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
async function writeHistory(root: string, name: string, value: unknown): Promise<void> {
	await writeFile(join(root, "evals", "history", name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function historyReport(generatedAt: string, score: number, boundaryScore = 2): unknown {
	return {
		generatedAt,
		score,
		maxScore: 10,
		status: score === 10 ? "pass" : "fail",
		alerts: [],
		results: [],
		categories: [
			{ category: "memory", score: 4, maxScore: 4 },
			{ category: "boundary", score: boundaryScore, maxScore: 2 },
			{ category: "multistep", score: score - boundaryScore - 4, maxScore: 4 },
		],
	};
}

test("T6 runEvalTrend skips bad JSON and incomplete history files", async () => {
	const store = await tempTrendStore();
	await writeHistory(store, "2026-07-01.json", historyReport("2026-07-01T00:00:00.000Z", 7));
	await writeHistory(store, "2026-07-02.json", { generatedAt: "2026-07-02T00:00:00.000Z" });
	await writeFile(join(store, "evals", "history", "bad.json"), "{ nope", "utf8");
	await writeHistory(store, "2026-07-03.json", historyReport("2026-07-03T00:00:00.000Z", 8));

	const report = await runEvalTrend(store);

	assert.equal(report.status, "ok");
	assert.deepEqual(
		report.points.map((item) => item.generatedAt),
		["2026-07-01T00:00:00.000Z", "2026-07-03T00:00:00.000Z"],
	);
});

test("T7 runEvalTrend excludes baseline and latest history copies", async () => {
	const store = await tempTrendStore();
	await writeHistory(store, "baseline.json", historyReport("2026-06-30T00:00:00.000Z", 1));
	await writeHistory(store, "latest.json", historyReport("2026-07-02T00:00:00.000Z", 8));
	await writeHistory(store, "2026-07-01.json", historyReport("2026-07-01T00:00:00.000Z", 7));
	await writeHistory(store, "2026-07-02.json", historyReport("2026-07-02T00:00:00.000Z", 8));

	const report = await runEvalTrend(store);

	assert.deepEqual(
		report.points.map((item) => item.generatedAt),
		["2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z"],
	);
});

test("T8 runEvalTrend writes deterministic evals/trend.md", async () => {
	const store = await tempTrendStore();
	await writeHistory(store, "2026-07-01.json", historyReport("2026-07-01T00:00:00.000Z", 7));
	await writeHistory(store, "2026-07-02.json", historyReport("2026-07-02T00:00:00.000Z", 8));

	await runEvalTrend(store);
	const first = await readFile(join(store, "evals", "trend.md"));
	await rm(join(store, "evals", "trend.md"));
	await runEvalTrend(store);
	const second = await readFile(join(store, "evals", "trend.md"));

	assert.equal(sha256(first), sha256(second));
});

test("T9 her eval-trend CLI returns JSON and human summaries", async () => {
	const store = await tempGitTrendStore();
	await writeHistory(store, "2026-07-01.json", historyReport("2026-07-01T00:00:00.000Z", 7));
	await writeHistory(store, "2026-07-02.json", historyReport("2026-07-02T00:00:00.000Z", 8));
	await commitTrendStoreBaseline(store);

	const jsonResult = await runTrendCli(["eval-trend", "--json"], store);
	assert.equal(jsonResult.code, 0, jsonResult.stderr);
	const payload = JSON.parse(jsonResult.stdout) as {
		report?: { direction?: string; points?: unknown[]; status?: string };
	};
	assert.equal(payload.report?.status, "ok");
	assert.equal(payload.report?.direction, "rising");
	assert.equal(payload.report?.points?.length, 2);

	const humanResult = await runTrendCli(["eval-trend"], store);
	assert.equal(humanResult.code, 0, humanResult.stderr);
	assert.match(humanResult.stdout, /Her eval trend ok: rising/);
	assert.match(humanResult.stdout, /# Her Eval Trend/);
});
function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
