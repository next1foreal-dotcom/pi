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

function comparePoints(a: EvalTrendPoint, b: EvalTrendPoint): number {
	return a.generatedAt.localeCompare(b.generatedAt);
}
