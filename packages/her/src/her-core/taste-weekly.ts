import { join } from "node:path";
import { extractJson, markdownEntries } from "./memory-utils.ts";
import type { ModelLike } from "./model.ts";
import type { StorePaths } from "./paths.ts";
import { appendText, frontmatter, parseFrontmatter, readText, writeJson, writeText } from "./store.ts";

/** palate P2-1: cluster members (D6 threshold) needed before a new board is proposed. Fable-set default. */
export const NEW_BOARD_THRESHOLD = 5;
const MIN_CARDS_FOR_CLUSTERING = 3;

export interface TasteIntakeLogEntry {
	ts: string;
	source: string;
	result: "success" | "error";
	noteId?: string;
	error?: string;
}

export async function appendTasteIntakeLog(paths: StorePaths, entry: TasteIntakeLogEntry): Promise<void> {
	await appendText(join(paths.herDir, "taste-intake-log.jsonl"), `${JSON.stringify(entry)}\n`);
}

async function readTasteIntakeLog(paths: StorePaths): Promise<TasteIntakeLogEntry[]> {
	const text = await readText(join(paths.herDir, "taste-intake-log.jsonl"));
	if (!text) return [];
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as TasteIntakeLogEntry);
}

export interface TasteCardSummary {
	stem: string;
	id: string;
	title: string;
	boards: string[];
	excerpt: string;
}

export async function readTasteCards(paths: StorePaths): Promise<TasteCardSummary[]> {
	const cards: TasteCardSummary[] = [];
	for (const entry of await markdownEntries(paths.world)) {
		const text = await readText(join(paths.world, entry));
		if (!text) continue;
		const { data, body } = parseFrontmatter(text);
		if (data.source_type !== "taste-card") continue;
		const stem = entry.replace(/\.md$/, "");
		cards.push({
			stem,
			id: typeof data.id === "string" ? data.id : stem,
			title: typeof data.title === "string" ? data.title : stem,
			boards: Array.isArray(data.boards) ? (data.boards as string[]) : [],
			excerpt: body.trim().replace(/\s+/g, " ").slice(0, 240),
		});
	}
	return cards;
}

export interface TasteLostEntry {
	source: string;
	ts: string;
	reason: string;
}

export interface TasteReconciliation {
	dropped: number;
	cardsFound: number;
	lost: TasteLostEntry[];
}

/** palate P2-1: intake log is the only fact source for "dropped"; world/ cards are the only fact source for "found". */
export async function reconcileTasteIntake(
	paths: StorePaths,
	cards: TasteCardSummary[],
	since: string,
): Promise<TasteReconciliation> {
	const sinceTime = Date.parse(since);
	const entries = (await readTasteIntakeLog(paths)).filter((entry) => {
		const t = Date.parse(entry.ts);
		return Number.isNaN(sinceTime) || Number.isNaN(t) || t >= sinceTime;
	});
	const cardIds = new Set(cards.map((card) => card.id));
	const lost: TasteLostEntry[] = [];
	let cardsFound = 0;
	for (const entry of entries) {
		if (entry.result === "error") {
			lost.push({ source: entry.source, ts: entry.ts, reason: entry.error ?? "intake failed" });
			continue;
		}
		if (entry.noteId && cardIds.has(entry.noteId)) {
			cardsFound++;
		} else {
			lost.push({ source: entry.source, ts: entry.ts, reason: "card not found in world/" });
		}
	}
	return { dropped: entries.length, cardsFound, lost };
}

export interface TasteCluster {
	name: string;
	members: string[];
	reason: string;
}

export type TasteClusterStatus = "ok" | "insufficient-sample" | "model-unavailable";

export interface TasteClusterResult {
	status: TasteClusterStatus;
	clusters: TasteCluster[];
}

function tasteClusterPrompt(cards: TasteCardSummary[]): string {
	const lines = cards.map(
		(card) => `- ${card.stem}: title="${card.title}" boards=[${card.boards.join(", ")}] excerpt="${card.excerpt}"`,
	);
	return [
		"Return ONLY JSON (no prose, no code fence). Group these taste cards into clusters that share a real theme.",
		"Leave out cards that do not clearly share a theme with at least one other card.",
		'JSON shape: {"clusters":[{"name":"short cluster name","members":["stem1","stem2"],"reason":"one sentence why they belong together"}]}',
		"",
		`CARDS:\n${lines.join("\n")}`,
	].join("\n");
}

/** palate P2-1: the clustering intelligence lives in the model call itself (arch d7) — no local heuristics. */
export async function clusterTasteCards(
	cards: TasteCardSummary[],
	model: ModelLike | undefined,
): Promise<TasteClusterResult> {
	if (cards.length < MIN_CARDS_FOR_CLUSTERING) return { status: "insufficient-sample", clusters: [] };
	if (!model) return { status: "model-unavailable", clusters: [] };
	try {
		const raw = await model.complete(tasteClusterPrompt(cards));
		const parsed = extractJson<{ clusters?: Array<{ name?: string; members?: string[]; reason?: string }> }>(raw);
		const knownStems = new Set(cards.map((card) => card.stem));
		const clusters = (parsed.clusters ?? [])
			.map((cluster) => ({
				name: cluster.name?.trim() || "未命名簇",
				members: (cluster.members ?? []).filter((member): member is string => knownStems.has(member)),
				reason: cluster.reason?.trim() ?? "",
			}))
			.filter((cluster) => cluster.members.length > 0);
		return { status: "ok", clusters };
	} catch {
		return { status: "model-unavailable", clusters: [] };
	}
}

function intersectAll(sets: Array<Set<string>>): Set<string> {
	if (sets.length === 0) return new Set();
	return sets.reduce((acc, set) => new Set([...acc].filter((value) => set.has(value))));
}

export type TasteProposalStatus = "pending" | "applied" | "dismissed";

export interface TasteProposal {
	id: string;
	board: string;
	members: string[];
	reason: string;
	status: TasteProposalStatus;
}

/** palate P2-1 AC-4: only propose — building the board is a separate, Fei-approved command (P2-2). */
export function proposeNewBoards(clusters: TasteCluster[], cards: TasteCardSummary[], week: string): TasteProposal[] {
	const boardsByStem = new Map(cards.map((card) => [card.stem, new Set(card.boards)]));
	const proposals: TasteProposal[] = [];
	let index = 0;
	for (const cluster of clusters) {
		if (cluster.members.length < NEW_BOARD_THRESHOLD) continue;
		const memberBoards = cluster.members.map((stem) => boardsByStem.get(stem) ?? new Set<string>());
		if (intersectAll(memberBoards).size > 0) continue;
		index++;
		proposals.push({
			id: `${week}-${index}`,
			board: cluster.name,
			members: cluster.members,
			reason: cluster.reason,
			status: "pending",
		});
	}
	return proposals;
}

export interface TasteProposalsSidecar {
	generatedAt: string;
	week: string;
	proposals: TasteProposal[];
}

/** palate P2-1 §2.e: sidecar schema is a concurrency contract with the UI — field names are frozen. */
export async function writeTasteProposalsSidecar(paths: StorePaths, sidecar: TasteProposalsSidecar): Promise<void> {
	await writeJson(join(paths.herDir, "taste-proposals.json"), sidecar);
}

export async function readTasteProposalsSidecar(paths: StorePaths): Promise<TasteProposalsSidecar | undefined> {
	const text = await readText(join(paths.herDir, "taste-proposals.json"));
	return text ? (JSON.parse(text) as TasteProposalsSidecar) : undefined;
}

/** palate P2-2: apply/dismiss is the only legal second write to a proposal's status field. */
export async function markTasteProposalApplied(paths: StorePaths, proposalId: string): Promise<void> {
	const sidecar = await readTasteProposalsSidecar(paths);
	if (!sidecar) return;
	const proposals = sidecar.proposals.map((proposal) =>
		proposal.id === proposalId ? { ...proposal, status: "applied" as const } : proposal,
	);
	await writeTasteProposalsSidecar(paths, { ...sidecar, proposals });
}

/**
 * palate P2-2: `taste-board-apply <board> ...` is the CLI's proposal-consuming write. It correlates
 * by board name (the CLI arg), not proposal id, since the operator names a board, not a proposal.
 * Returns how many pending proposals were flipped to "applied".
 */
export async function markTasteProposalsAppliedForBoard(paths: StorePaths, board: string): Promise<number> {
	const sidecar = await readTasteProposalsSidecar(paths);
	if (!sidecar) return 0;
	let changed = 0;
	const proposals = sidecar.proposals.map((proposal) => {
		if (proposal.board !== board || proposal.status !== "pending") return proposal;
		changed++;
		return { ...proposal, status: "applied" as const };
	});
	if (changed > 0) await writeTasteProposalsSidecar(paths, { ...sidecar, proposals });
	return changed;
}

function isoWeekLabel(date: Date): string {
	const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const dayNum = utc.getUTCDay() || 7;
	utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
	const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
	const weekNo = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
	return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function renderReconciliationSection(reconciliation: TasteReconciliation): string {
	const { dropped, cardsFound, lost } = reconciliation;
	const lines = ["## 对账", "", `丢 ${dropped} → 成卡 ${cardsFound} → 流失 ${lost.length}`];
	if (lost.length > 0) {
		lines.push("", "**流失≠0 — 没消化下去的：**");
		for (const entry of lost) lines.push(`- ${entry.source}（${entry.ts}）：${entry.reason}`);
	}
	return lines.join("\n");
}

function renderClusterSection(clustering: TasteClusterResult): string {
	const lines = ["## 聚簇发现", ""];
	if (clustering.status === "insufficient-sample") {
		lines.push(`样本不足，跳过聚簇（卡数不足 ${MIN_CARDS_FOR_CLUSTERING}，禁止硬凑）。`);
	} else if (clustering.status === "model-unavailable") {
		lines.push("模型不可用，本周聚簇跳过。");
	} else if (clustering.clusters.length === 0) {
		lines.push("本周没有发现明显聚簇。");
	} else {
		for (const cluster of clustering.clusters) {
			lines.push(
				`### ${cluster.name}（${cluster.members.length} 卡）`,
				"",
				cluster.reason,
				"",
				`成员：${cluster.members.join("、")}`,
				"",
			);
		}
	}
	return lines.join("\n").trimEnd();
}

function renderProposalSection(proposals: TasteProposal[]): string {
	const lines = ["## 新板提议", ""];
	if (proposals.length === 0) {
		lines.push("本周没有新板提议。");
	} else {
		for (const proposal of proposals) {
			lines.push(
				`- **${proposal.board}** 候选（${proposal.members.length} 卡）：${proposal.reason}。成员：${proposal.members.join("、")}`,
			);
		}
	}
	return lines.join("\n");
}

export interface TasteWeeklyOptions {
	since?: string;
	now?: string;
}

export interface TasteWeeklyResult {
	week: string;
	since: string;
	until: string;
	generatedAt: string;
	reconciliation: TasteReconciliation;
	clusterStatus: TasteClusterStatus;
	clusters: TasteCluster[];
	proposals: TasteProposal[];
	reportPath: string;
	reportMarkdown: string;
}

function renderTasteWeeklyReport(
	week: string,
	since: string,
	until: string,
	generatedAt: string,
	reconciliation: TasteReconciliation,
	clustering: TasteClusterResult,
	proposals: TasteProposal[],
): string {
	return [
		`# 味蕾周消化 · 第 ${week} 周`,
		"",
		`范围：${since} → ${until} · 生成于 ${generatedAt}`,
		reconciliation.lost.length > 0 ? "" : undefined,
		reconciliation.lost.length > 0 ? `**流失 ${reconciliation.lost.length} 条，见对账**` : undefined,
		"",
		renderReconciliationSection(reconciliation),
		"",
		renderClusterSection(clustering),
		"",
		renderProposalSection(proposals),
		"",
		"---",
		`${week} · 丢 ${reconciliation.dropped} / 成卡 ${reconciliation.cardsFound} / 流失 ${reconciliation.lost.length} · her-memory/world`,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

export async function runTasteWeekly(
	paths: StorePaths,
	model: ModelLike | undefined,
	options: TasteWeeklyOptions = {},
): Promise<TasteWeeklyResult> {
	const now = options.now ?? new Date().toISOString();
	const since = options.since ?? new Date(Date.parse(now) - 7 * 86_400_000).toISOString();
	const week = isoWeekLabel(new Date(now));

	const cards = await readTasteCards(paths);
	const reconciliation = await reconcileTasteIntake(paths, cards, since);
	const clustering = await clusterTasteCards(cards, model);
	const proposals = proposeNewBoards(clustering.clusters, cards, week);

	const reportMarkdown = renderTasteWeeklyReport(week, since, now, now, reconciliation, clustering, proposals);
	const reportPath = join(paths.tasteReports, `${week}.md`);
	await writeText(reportPath, reportMarkdown);
	await writeTasteProposalsSidecar(paths, { generatedAt: now, week, proposals });

	return {
		week,
		since,
		until: now,
		generatedAt: now,
		reconciliation,
		clusterStatus: clustering.status,
		clusters: clustering.clusters,
		proposals,
		reportPath,
		reportMarkdown,
	};
}
