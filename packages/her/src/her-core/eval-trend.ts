import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { StorePaths } from "./paths.ts";
import { writeText } from "./store.ts";

export type TrendDirection = "rising" | "flat" | "regression";

export interface EvalTrendPoint {
	generatedAt: string;
	score: number;
	maxScore: number;
	boundaryScore: number;
	boundaryMax: number;
}

export interface EvalTrendAlert {
	kind: "total-regression" | "boundary-regression";
	message: string;
}

export interface EvalTrendReport {
	alerts: EvalTrendAlert[];
	direction: TrendDirection;
	latest?: EvalTrendPoint;
	points: EvalTrendPoint[];
	previous?: EvalTrendPoint;
	status: "ok" | "regression" | "insufficient-data";
}

interface HistoryPoint extends EvalTrendPoint {
	file: string;
}

export async function runEvalTrend(root: string): Promise<EvalTrendReport> {
	const paths = new StorePaths(root);
	const points = await readEvalHistory(join(paths.evals, "history"));
	const report = computeEvalTrend(points.map(({ file: _file, ...point }) => point));
	await writeText(join(paths.evals, "trend.md"), renderEvalTrendReport(report));
	return report;
}

export function computeEvalTrend(points: EvalTrendPoint[]): EvalTrendReport {
	const sorted = [...points].sort(comparePoints);
	if (sorted.length < 2) {
		return { alerts: [], direction: "flat", points: sorted, status: "insufficient-data" };
	}
	const previous = sorted.at(-2) as EvalTrendPoint;
	const latest = sorted.at(-1) as EvalTrendPoint;
	const direction = latest.score > previous.score ? "rising" : latest.score < previous.score ? "regression" : "flat";
	const alerts: EvalTrendAlert[] = [];
	if (latest.boundaryScore < previous.boundaryScore) {
		alerts.push({
			kind: "boundary-regression",
			message: `boundary score fell from ${previous.boundaryScore}/${previous.boundaryMax} to ${latest.boundaryScore}/${latest.boundaryMax}`,
		});
	}
	if (latest.score < previous.score) {
		alerts.push({
			kind: "total-regression",
			message: `total score fell from ${previous.score}/${previous.maxScore} to ${latest.score}/${latest.maxScore}`,
		});
	}
	return {
		alerts,
		direction,
		latest,
		points: sorted,
		previous,
		status: alerts.length > 0 ? "regression" : "ok",
	};
}

export function renderEvalTrendReport(report: EvalTrendReport): string {
	return [
		"# Her Eval Trend",
		"",
		`Status: ${report.status}`,
		`Direction: ${report.direction}`,
		`Points: ${report.points.length}`,
		`Latest: ${formatPoint(report.latest)}`,
		`Previous: ${formatPoint(report.previous)}`,
		"",
		"## Alerts",
		formatAlerts(report.alerts),
		"",
		"## History",
		formatHistory(report.points),
		"",
	].join("\n");
}

async function readEvalHistory(historyDir: string): Promise<HistoryPoint[]> {
	let entries: string[];
	try {
		entries = await readdir(historyDir);
	} catch {
		return [];
	}
	const points: HistoryPoint[] = [];
	for (const file of entries.filter(isHistoryJson).sort(compareString)) {
		try {
			const parsed: unknown = JSON.parse(await readFile(join(historyDir, file), "utf8"));
			const point = toEvalTrendPoint(parsed);
			if (point) points.push({ ...point, file });
		} catch {}
	}
	return points.sort(compareHistoryPoints);
}

function isHistoryJson(file: string): boolean {
	return file.endsWith(".json") && file !== "baseline.json" && file !== "latest.json";
}

function toEvalTrendPoint(value: unknown): EvalTrendPoint | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.generatedAt !== "string") return undefined;
	if (typeof value.score !== "number" || !Number.isFinite(value.score)) return undefined;
	if (typeof value.maxScore !== "number" || !Number.isFinite(value.maxScore)) return undefined;
	const boundary = Array.isArray(value.categories)
		? value.categories.find((category) => isRecord(category) && category.category === "boundary")
		: undefined;
	return {
		generatedAt: value.generatedAt,
		score: value.score,
		maxScore: value.maxScore,
		boundaryScore:
			isRecord(boundary) && typeof boundary.score === "number" && Number.isFinite(boundary.score)
				? boundary.score
				: 0,
		boundaryMax:
			isRecord(boundary) && typeof boundary.maxScore === "number" && Number.isFinite(boundary.maxScore)
				? boundary.maxScore
				: 0,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatPoint(point: EvalTrendPoint | undefined): string {
	if (!point) return "(none)";
	return `${point.generatedAt} total ${point.score}/${point.maxScore}, boundary ${point.boundaryScore}/${point.boundaryMax}`;
}

function formatAlerts(alerts: EvalTrendAlert[]): string {
	if (alerts.length === 0) return "(none)";
	return alerts.map((alert) => `- ${alert.kind}: ${alert.message}`).join("\n");
}

function formatHistory(points: EvalTrendPoint[]): string {
	if (points.length === 0) return "(none)";
	return points.map((point) => `- ${formatPoint(point)}`).join("\n");
}

function compareHistoryPoints(a: HistoryPoint, b: HistoryPoint): number {
	return comparePoints(a, b) || compareString(a.file, b.file);
}

function comparePoints(a: EvalTrendPoint, b: EvalTrendPoint): number {
	return a.generatedAt.localeCompare(b.generatedAt);
}

function compareString(a: string, b: string): number {
	return a.localeCompare(b);
}
