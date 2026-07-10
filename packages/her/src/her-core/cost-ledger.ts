import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StorePaths } from "./paths.ts";
import { frontmatter, readText, writeText } from "./store.ts";

export interface AuditCost {
	model?: string;
	outputTokens?: number;
	provider?: string;
	purpose?: string;
	usd: number;
}

export interface CostLedgerAuditEntry {
	context?: Record<string, unknown>;
	cost?: AuditCost;
	ts: string;
	tool: string;
}

export interface CostBucket {
	count: number;
	usd: number;
}

export interface CostSummary {
	byPurpose: Record<string, CostBucket>;
	entries: number;
	month: string;
	totalUsd: number;
}

export interface CostReport {
	path: string;
	reconciliation: {
		deltaUsd?: number;
		providerTotalUsd?: number;
		status: "local-only" | "partial";
	};
	summary: CostSummary;
	updated: string;
}

export interface CostReportOptions {
	month?: string;
	now?: string;
	providerTotalUsd?: number;
}

export interface CostSummaryOptions {
	month?: string;
}

export interface CostDayBucket extends CostBucket {
	date: string;
}

export interface CostProviderBucket extends CostBucket {
	provider: string;
}

export interface CostBreakdown {
	byDay: CostDayBucket[];
	byProvider: CostProviderBucket[];
	entries: number;
	month: string;
	monthUsd: number;
	today: string;
	todayUsd: number;
}

export interface CostBreakdownOptions {
	month?: string;
	now?: string;
}

export async function summarizeAuditCosts(root: string, opts: CostSummaryOptions = {}): Promise<CostSummary> {
	const month = opts.month ?? new Date().toISOString().slice(0, 7);
	const entries = await readAuditEntries(root, month);
	const byPurpose: Record<string, CostBucket> = {};
	let totalUsd = 0;
	for (const entry of entries) {
		if (!entry.cost || !Number.isFinite(entry.cost.usd)) continue;
		const usd = entry.cost.usd;
		totalUsd += usd;
		const purpose = entry.cost.purpose ?? stringContext(entry.context, "purpose") ?? entry.tool;
		const bucket = byPurpose[purpose] ?? { count: 0, usd: 0 };
		bucket.count += 1;
		bucket.usd = roundUsd(bucket.usd + usd);
		byPurpose[purpose] = bucket;
	}
	return { month, entries: entries.length, totalUsd: roundUsd(totalUsd), byPurpose };
}

/**
 * Reads the same audit ledger as summarizeAuditCosts but breaks costs down by calendar day and by
 * provider, plus a same-day total, so `her cost` never needs a second recomputation of the ledger.
 */
export async function summarizeCostBreakdown(root: string, opts: CostBreakdownOptions = {}): Promise<CostBreakdown> {
	const now = opts.now ?? new Date().toISOString();
	const month = opts.month ?? now.slice(0, 7);
	const today = now.slice(0, 10);
	const entries = await readAuditEntries(root, month);
	const byDayMap: Record<string, CostBucket> = {};
	const byProviderMap: Record<string, CostBucket> = {};
	let monthUsd = 0;
	for (const entry of entries) {
		if (!entry.cost || !Number.isFinite(entry.cost.usd)) continue;
		const usd = entry.cost.usd;
		monthUsd += usd;
		const date = entry.ts.slice(0, 10);
		const dayBucket = byDayMap[date] ?? { count: 0, usd: 0 };
		dayBucket.count += 1;
		dayBucket.usd = roundUsd(dayBucket.usd + usd);
		byDayMap[date] = dayBucket;
		const provider = entry.cost.provider ?? "unknown";
		const providerBucket = byProviderMap[provider] ?? { count: 0, usd: 0 };
		providerBucket.count += 1;
		providerBucket.usd = roundUsd(providerBucket.usd + usd);
		byProviderMap[provider] = providerBucket;
	}
	return {
		byDay: Object.entries(byDayMap)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([date, bucket]) => ({ date, ...bucket })),
		byProvider: Object.entries(byProviderMap)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([provider, bucket]) => ({ provider, ...bucket })),
		entries: entries.length,
		month,
		monthUsd: roundUsd(monthUsd),
		today,
		todayUsd: byDayMap[today]?.usd ?? 0,
	};
}

export async function writeCostReport(root: string, opts: CostReportOptions = {}): Promise<CostReport> {
	const updated = opts.now ?? new Date().toISOString();
	const summary = await summarizeAuditCosts(root, { month: opts.month ?? updated.slice(0, 7) });
	const paths = new StorePaths(root);
	const path = join(paths.costReports, `${summary.month}.md`);
	const providerTotalUsd = opts.providerTotalUsd === undefined ? undefined : roundUsd(Number(opts.providerTotalUsd));
	const reconciliation =
		providerTotalUsd === undefined
			? { status: "local-only" as const }
			: {
					status: "partial" as const,
					providerTotalUsd,
					deltaUsd: roundUsd(providerTotalUsd - summary.totalUsd),
				};
	const report: CostReport = {
		path: `reports/cost/${summary.month}.md`,
		updated,
		summary,
		reconciliation,
	};
	await writeText(path, renderCostReport(report));
	return report;
}

export async function enforceDailyCostCap(
	root: string,
	limitUsd: number,
	date = new Date().toISOString().slice(0, 10),
): Promise<CostBucket> {
	const entries = await readAuditEntries(root, date);
	let usd = 0;
	let count = 0;
	for (const entry of entries) {
		if (!entry.cost || !Number.isFinite(entry.cost.usd)) continue;
		usd += entry.cost.usd;
		count += 1;
	}
	const bucket = { count, usd: roundUsd(usd) };
	if (bucket.usd >= limitUsd) throw new Error(`daily Her cost cap reached: ${bucket.usd} >= ${limitUsd}`);
	return bucket;
}

async function readAuditEntries(root: string, prefix: string): Promise<CostLedgerAuditEntry[]> {
	const auditDir = resolve(root, "audit");
	const names = await readdir(auditDir).catch((error: unknown) => {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	});
	const entries: CostLedgerAuditEntry[] = [];
	for (const name of names.filter((item) => item.startsWith(prefix) && item.endsWith(".jsonl")).sort()) {
		const text = (await readText(join(auditDir, name))) ?? "";
		for (const line of text.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const parsed = JSON.parse(line) as CostLedgerAuditEntry;
			if (typeof parsed.ts === "string" && typeof parsed.tool === "string") entries.push(parsed);
		}
	}
	return entries;
}

function renderCostReport(report: CostReport): string {
	const rows = Object.entries(report.summary.byPurpose)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([purpose, bucket]) => `| ${purpose} | ${bucket.count} | ${bucket.usd.toFixed(4)} |`);
	return [
		frontmatter({
			type: "her_cost_report",
			month: report.summary.month,
			updated: report.updated,
			total_usd: report.summary.totalUsd,
			provider_reconciliation: report.reconciliation.status,
		}).trimEnd(),
		"",
		`# Her Cost Report ${report.summary.month}`,
		"",
		`local audit total: $${report.summary.totalUsd.toFixed(4)}`,
		`provider reconciliation: ${report.reconciliation.status}`,
		report.reconciliation.providerTotalUsd === undefined
			? "provider total: not supplied"
			: `provider total: $${report.reconciliation.providerTotalUsd.toFixed(4)}`,
		"",
		"| Purpose | Entries | USD |",
		"|---|---:|---:|",
		...(rows.length ? rows : ["| none | 0 | 0.0000 |"]),
		"",
	].join("\n");
}

function stringContext(context: Record<string, unknown> | undefined, field: string): string | undefined {
	const value = context?.[field];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function roundUsd(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}
