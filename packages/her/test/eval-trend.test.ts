import assert from "node:assert/strict";
import test from "node:test";
import { computeEvalTrend, type EvalTrendPoint } from "../src/her-core/eval-trend.ts";

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
