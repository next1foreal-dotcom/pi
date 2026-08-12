import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { summarizeScores, type TaskResult } from "./score.ts";

export type ReportData = { incomplete: boolean; summary: { numerator: number; denominator: number; excluded: number; score: number | null }; results: TaskResult[]; manifest: Record<string, unknown>; markdown: string };

function markdownCell(value: string | number | null | undefined): string {
	return String(value ?? "-").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderReport(manifest: Record<string, unknown>, results: TaskResult[]): ReportData {
	const summary = summarizeScores(results);
	const grouped = new Map<string, TaskResult[]>();
	for (const result of results) {
		const category = String((manifest.categories as Record<string, string> | undefined)?.[result.taskId] ?? "uncategorized");
		const entries = grouped.get(category) ?? [];
		entries.push(result);
		grouped.set(category, entries);
	}
	const lines: string[] = [];
	const incomplete = manifest.complete !== true;
	if (incomplete) lines.push("# INCOMPLETE", "");
	lines.push("# Hands exam report", "");
	for (const [category, entries] of grouped) {
		lines.push(`## ${category}`, "", "| Task | Execution | Grade | Points | Wall ms | Evidence |", "| --- | --- | --- | --- | --- | --- |");
		for (const result of entries) {
			const evidence = result.artifacts[0] ? relative(String(manifest.runDir ?? ""), result.artifacts[0]) : "-";
			lines.push(`| ${markdownCell(result.taskId)} | ${markdownCell(result.executionStatus)} | ${markdownCell(result.grade)} | ${markdownCell(result.points)} | ${markdownCell(result.wallMs)} | ${markdownCell(evidence)} |`);
		}
		lines.push("");
	}
	lines.push(`Total: ${summary.numerator}/${summary.denominator}${summary.score === null ? "" : ` (${(summary.score * 100).toFixed(1)}%)`}.`, `Excluded tasks: ${summary.excluded}. ENV_FAIL and SKIPPED are excluded from the denominator.`, "This is a snapshot, not a controlled experiment.", "", "## Manifest", "", `- runId: ${markdownCell(String(manifest.runId ?? "unknown"))}`, `- gitSha: ${markdownCell(String(manifest.gitSha ?? "unknown"))}`, `- provider: ${markdownCell(String(manifest.provider ?? "unknown"))}`, `- model: ${markdownCell(String(manifest.model ?? "unknown"))}`, `- tasksJsonSha256: ${markdownCell(String(manifest.tasksJsonSha256 ?? "unknown"))}`, `- fixturesSha256: ${markdownCell(String(manifest.fixturesSha256 ?? "unknown"))}`, `- uiBase: ${markdownCell(String(manifest.uiBase ?? "unknown"))}`);
	const markdown = `${lines.join("\n")}\n`;
	return { incomplete, summary, results, manifest, markdown };
}

export async function writeReport(runDir: string): Promise<ReportData> {
	const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as Record<string, unknown>;
	manifest.runDir = runDir;
	const taskIds = Array.isArray(manifest.tasks) ? manifest.tasks.filter((task): task is string => typeof task === "string") : [];
	const results: TaskResult[] = [];
	for (const taskId of taskIds) {
		const path = join(runDir, `${taskId}.json`);
		try {
			results.push(JSON.parse(await readFile(path, "utf8")) as TaskResult);
		} catch {
			continue;
		}
	}
	if (taskIds.length === 0) {
		for (const name of await readdir(runDir)) if (/^T\d+\.json$/.test(name)) results.push(JSON.parse(await readFile(join(runDir, name), "utf8")) as TaskResult);
	}
	if (!("categories" in manifest)) {
		const categories: Record<string, string> = {};
		for (const result of results) categories[result.taskId] = "uncategorized";
		manifest.categories = categories;
	}
	const report = renderReport(manifest, results);
	await writeFile(join(runDir, "report.md"), report.markdown, "utf8");
	await writeFile(join(runDir, "report.json"), `${JSON.stringify({ incomplete: report.incomplete, summary: report.summary, results: report.results, manifest: report.manifest }, null, 2)}\n`, "utf8");
	return report;
}
