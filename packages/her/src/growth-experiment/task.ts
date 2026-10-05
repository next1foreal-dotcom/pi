import { redactSecrets } from "../her-core/store.ts";
import { storeLock } from "../her-core/store-lock.ts";
import type { HerGrowthHost } from "./host.ts";
import { type GrowthReceipt, recallGrowthMethods } from "./journal.ts";
import { tryMethod } from "./loop.ts";
import type { Observation, Selection } from "./types.ts";

export interface GrowthUsage {
	requests: number;
	tokens: number | null;
	estimatedUsd: number | null;
	knownTokens: number;
	knownEstimatedUsd: number;
	runIds: string[];
}
/** Reservation counts attempts; pending usage is never zero or a paid invoice. */
export function growthUsage(rows: GrowthReceipt[]): GrowthUsage {
	const reservations = rows.filter((r) => r.kind === "model-reserve");
	const results = rows.filter((r) => r.kind === "model-result");
	const knownTokens = results.reduce((n, r) => n + Number(r.data.tokens), 0);
	const knownEstimatedUsd = results.reduce((n, r) => n + Number(r.data.usd), 0);
	const unknown = reservations.some((r) => !results.some((s) => s.data.runId === r.data.runId));
	return {
		requests: reservations.length,
		tokens: unknown ? null : knownTokens,
		estimatedUsd: unknown ? null : knownEstimatedUsd,
		knownTokens,
		knownEstimatedUsd,
		runIds: reservations.map((r) => String(r.data.runId)),
	};
}
export interface GrowthTaskResult {
	status: "task-observed" | "task-failed";
	taskId: string;
	mode: "method-used" | "model-declined" | "host-blocked" | "no-active-method" | "interrupted";
	retrievedMethodIds: string[];
	selection?: Selection;
	observation?: Observation;
	reason?: string;
	usage: GrowthUsage;
	elapsedMs: number;
}
/** Ordinary bounded research task: caller supplies only a task, never a method ID or use instruction. */
export async function runGrowthTask(
	host: HerGrowthHost,
	taskId: string,
	signal?: AbortSignal,
): Promise<GrowthTaskResult> {
	const task = host.plan.tasks.find((t) => t.id === taskId);
	if (!task) throw new Error("task not approved");
	await host.assertRunning(signal);
	const started = Date.now();
	const reservation = await storeLock(host.journal.root, async () => {
		const state = await host.journal.state();
		if (!state || state.pending || !["trial-ready", "suspended", "deferred"].includes(state.phase))
			throw new Error("ordinary task needs a completed learning/review state without a pending failure");
		if (
			(await host.journal.read()).some(
				(r) =>
					["ordinary-task-reserved", "task-selection-reserved", "use-result"].includes(r.kind) &&
					r.data.taskId === taskId,
			) ||
			state.trials.some((t) => t.task.id === taskId)
		)
			throw new Error("ordinary task already consumed; no replay");
		return host.journal.append("ordinary-task-reserved", { taskId, planDigest: host.planDigest });
	});
	let mode: GrowthTaskResult["mode"] = "interrupted";
	let selection: Selection | undefined;
	let observation: Observation | undefined;
	let reason: string | undefined;
	const retrievedMethodIds: string[] = [];
	try {
		// Permissions remain bound to this inquiry. Unrelated active methods do not gain a tool grant.
		const recalled = (await recallGrowthMethods(host.journal.root)).find((s) => s.id === host.plan.inquiryId);
		if (recalled?.method) {
			if (
				recalled.method.review?.decision !== "eligible-for-review" ||
				recalled.method.review.planDigest !== host.planDigest
			)
				throw new Error("recalled method lacks a matching independent gate");
			retrievedMethodIds.push(recalled.method.id);
		}
		await host.journal.append("ordinary-task-retrieval", {
			taskId,
			methodIds: retrievedMethodIds,
			scope: "approved-inquiry",
		});
		if (!recalled) {
			mode = "no-active-method";
			observation = await host.runBaseline(taskId, true, signal, { condition: "task" });
		} else {
			const state = await tryMethod(
				recalled,
				{ id: task.id, description: task.description, environment: task.environment },
				host,
				signal,
			);
			const trial = state.trials.find((t) => t.task.id === taskId);
			if (!trial || state.pending || state.phase === "blocked" || state.phase === "deferred")
				throw new Error(state.note || "method selection/use did not complete");
			selection = trial.selection;
			if (trial.status === "observed") {
				mode = "method-used";
				observation = trial.observation;
				if (!observation) throw new Error("missing actual method observation");
			} else {
				mode = trial.status === "declined" ? "model-declined" : "host-blocked";
				// Selection already consumed one call. A fresh solution gets only the second matched call.
				observation = await host.runBaseline(taskId, false, signal, {
					condition: "task",
					deliberation: [JSON.stringify(selection)],
				});
			}
		}
	} catch (error) {
		reason = redactSecrets(error instanceof Error ? error.message : "ordinary task failed");
	}
	const result: GrowthTaskResult = {
		status: observation && !reason ? "task-observed" : "task-failed",
		taskId,
		mode,
		retrievedMethodIds,
		...(selection ? { selection } : {}),
		...(observation ? { observation } : {}),
		...(reason ? { reason } : {}),
		usage: growthUsage((await host.journal.read()).filter((r) => r.seq > reservation.seq)),
		elapsedMs: Date.now() - started,
	};
	await host.journal.append("ordinary-task-result", { ...result });
	return result;
}
