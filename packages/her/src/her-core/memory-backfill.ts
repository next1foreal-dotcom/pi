import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { summarizeAuditCosts } from "./cost-ledger.ts";
import type { ConsolidateResult } from "./memory-types.ts";
import type { StorePaths } from "./paths.ts";
import { appendText, parseFrontmatter, readJson, readText } from "./store.ts";

export interface BackfillOptions {
	batchSize?: number;
	budgetUsd?: number;
	dryRun?: boolean;
	finalize?: boolean;
	maxBatches?: number;
	now?: string;
}

export interface BackfillEpisode {
	id: string;
	path: string;
	ts: string;
}

export interface BackfillBatchResult {
	costUsd: number;
	cursorAfter: string;
	cursorBefore: string | null;
	episodes: BackfillEpisode[];
	index: number;
	result?: ConsolidateResult;
	status: "planned" | "processed";
}

export interface BackfillRunResult {
	batches: BackfillBatchResult[];
	budgetSpentUsd: number;
	budgetUsd?: number;
	cursorAfter: string | null;
	cursorBefore: string | null;
	dryRun: boolean;
	finalize?: {
		proposalId: string;
		topicMaps: string[];
	};
	plannedEpisodes: number;
	processedEpisodes: number;
	stoppedReason: "budget_cap" | "complete" | "max_batches";
}

export interface BackfillMemory {
	readonly paths: StorePaths;
	buildTopicMaps(): Promise<string[]>;
	consolidate(limit?: number): Promise<ConsolidateResult>;
	synthesize(): Promise<string>;
}

interface BackfillState {
	cursor?: string | null;
}

export async function runBackfill(memory: BackfillMemory, opts: BackfillOptions = {}): Promise<BackfillRunResult> {
	const batchSize = opts.batchSize ?? 40;
	if (!Number.isFinite(batchSize) || batchSize <= 0) throw new Error("backfill batchSize must be positive");
	if (opts.maxBatches !== undefined && (!Number.isFinite(opts.maxBatches) || opts.maxBatches < 0)) {
		throw new Error("backfill maxBatches must be non-negative");
	}
	const dryRun = opts.dryRun === true;
	if (!dryRun && opts.budgetUsd === undefined) throw new Error("backfill requires budgetUsd unless dryRun is true");
	if (opts.budgetUsd !== undefined && (!Number.isFinite(opts.budgetUsd) || opts.budgetUsd <= 0)) {
		throw new Error("backfill budgetUsd must be positive");
	}

	const initialState = await readJson<BackfillState>(memory.paths.stateFile, {});
	const cursorBefore = initialState.cursor ?? null;
	let cursor = cursorBefore;
	let budgetSpentUsd = await readBackfillCostUsd(memory.paths.root, opts.now);
	const batches: BackfillBatchResult[] = [];
	let stoppedReason: BackfillRunResult["stoppedReason"] = "complete";

	for (;;) {
		const episodes = (await episodesSince(memory.paths, cursor)).slice(0, batchSize);
		if (episodes.length === 0) {
			stoppedReason = "complete";
			break;
		}
		if (opts.maxBatches !== undefined && batches.length >= opts.maxBatches) {
			stoppedReason = "max_batches";
			break;
		}
		if (!dryRun && opts.budgetUsd !== undefined && budgetSpentUsd >= opts.budgetUsd) {
			stoppedReason = "budget_cap";
			break;
		}

		const cursorAfter = episodes.at(-1)?.ts ?? cursor ?? "";
		const batchBase = {
			costUsd: 0,
			cursorAfter,
			cursorBefore: cursor,
			episodes: episodes.map(({ id, path, ts }) => ({ id, path, ts })),
			index: batches.length + 1,
		};
		if (dryRun) {
			batches.push({ ...batchBase, status: "planned" });
			cursor = cursorAfter;
			continue;
		}

		const result = await memory.consolidate(batchSize);
		const stateAfter = await readJson<BackfillState>(memory.paths.stateFile, {});
		const writtenCursor = stateAfter.cursor ?? cursorAfter;
		const batch = {
			...batchBase,
			cursorAfter: writtenCursor,
			result,
			status: "processed" as const,
		};
		await recordBackfillBatch(memory.paths, batch, opts.now);
		batches.push(batch);
		cursor = writtenCursor;
		budgetSpentUsd = await readBackfillCostUsd(memory.paths.root, opts.now);
	}

	const result: BackfillRunResult = {
		batches,
		budgetSpentUsd,
		...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
		cursorAfter: batches.at(-1)?.cursorAfter ?? cursorBefore,
		cursorBefore,
		dryRun,
		plannedEpisodes: batches.reduce((sum, batch) => sum + batch.episodes.length, 0),
		processedEpisodes: dryRun ? 0 : batches.reduce((sum, batch) => sum + (batch.result?.episodes ?? 0), 0),
		stoppedReason,
	};

	if (!dryRun && opts.finalize === true && stoppedReason === "complete") {
		result.finalize = {
			topicMaps: await memory.buildTopicMaps(),
			proposalId: await memory.synthesize(),
		};
	}

	return result;
}

async function episodesSince(paths: StorePaths, cursor: string | null): Promise<BackfillEpisode[]> {
	const names = await readdir(paths.raw).catch((error: unknown) => {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	});
	const episodes: BackfillEpisode[] = [];
	for (const name of names.filter((entry) => entry.endsWith(".md"))) {
		const path = join(paths.raw, name);
		const parsed = parseFrontmatter(await readText(path));
		if (parsed.data.protected_zone === true || parsed.data.consolidate === false) continue;
		const ts = String(parsed.data.timestamp ?? name.split("--")[0]);
		if (cursor !== null && ts <= cursor) continue;
		episodes.push({
			id: String(parsed.data.id ?? name.replace(/\.md$/, "")),
			path: `episodic/raw/${name}`,
			ts,
		});
	}
	return episodes.sort((left, right) => left.ts.localeCompare(right.ts) || left.path.localeCompare(right.path));
}

async function readBackfillCostUsd(root: string, now = new Date().toISOString()): Promise<number> {
	const summary = await summarizeAuditCosts(root, { month: now.slice(0, 7) });
	return summary.byPurpose.backfill?.usd ?? 0;
}

async function recordBackfillBatch(paths: StorePaths, batch: BackfillBatchResult, now?: string): Promise<void> {
	const ts = now ?? new Date().toISOString();
	await appendText(
		join(paths.root, "audit", `${ts.slice(0, 10)}.jsonl`),
		`${JSON.stringify({
			ts,
			tool: "her_backfill",
			verdict: "ALLOW",
			rule: null,
			cost: {
				usd: batch.costUsd,
				purpose: "backfill",
				provider: "local-runner",
			},
			context: {
				batchIndex: batch.index,
				cursorBefore: batch.cursorBefore,
				cursorAfter: batch.cursorAfter,
				episodeIds: batch.episodes.map((episode) => episode.id),
				episodes: batch.episodes.length,
			},
		})}\n`,
	);
}
