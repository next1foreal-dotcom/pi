import { canonicalJson, readProtectedFile, sha256 } from "../her-core/improvement-plan.ts";
import { redactSecrets } from "../her-core/store.ts";
import { storeLock } from "../her-core/store-lock.ts";
import type { HerGrowthHost } from "./host.ts";
import { advance, reopen } from "./loop.ts";
import { experiences } from "./parse.ts";
import { assertResearchUnexposed } from "./review.ts";
import { type GrowthTaskResult, type GrowthUsage, growthUsage, runGrowthTask } from "./task.ts";
import type { GrowthState, Observation } from "./types.ts";

export interface GrowthPilotRow {
	taskId: string;
	condition: "A" | "B";
	status: "missing" | "observed" | "interrupted";
	mode: "control" | GrowthTaskResult["mode"] | null;
	observation: Observation | null;
	selection: GrowthTaskResult["selection"] | null;
	retrievedMethodIds: string[] | null;
	usage: GrowthUsage | null;
	elapsedMs: number | null;
	reason: string | null;
}
export interface GrowthPilotReport {
	status: "NO-METHOD" | "REVIEW-REJECTED" | "INCOMPLETE" | "NO-OBSERVED-GAIN" | "PROMISING-PILOT";
	inquiryId: string;
	planDigest: string;
	correction: "not-reached" | "not-observed" | "not-needed" | "revised" | "failed";
	rows: GrowthPilotRow[];
	development: GrowthTaskResult | null;
	usage: GrowthUsage;
	reason: string;
}
async function learn(host: HerGrowthHost, signal?: AbortSignal): Promise<GrowthState> {
	let state = (await host.journal.state())!;
	while (["discover", "investigate", "candidate"].includes(state.phase)) {
		const previous = state.revision;
		state = await advance(state, host, signal);
		if (state.revision <= previous) throw new Error("learning did not advance; no retry");
	}
	return state;
}
function unavailable(state: GrowthState): GrowthPilotReport["status"] {
	if (state.pending || state.phase === "blocked") return "INCOMPLETE";
	return state.method?.review && state.method.review.decision !== "eligible-for-review"
		? "REVIEW-REJECTED"
		: "NO-METHOD";
}
/** Continuous bounded research only. Never installs a method, extends a window, probes connectivity or retries a run. */
export async function runGrowthPilot(host: HerGrowthHost, signal?: AbortSignal): Promise<GrowthPilotReport> {
	const contract = host.plan.pilot;
	if (
		!contract ||
		contract.thoughts !== 12 ||
		contract.probes !== 2 ||
		!host.plan.correction ||
		contract.finalTaskIds.length !== 4 ||
		new Set(contract.finalTaskIds).size !== 4 ||
		canonicalJson(host.plan.correction.developmentTaskIds) !== canonicalJson([contract.developmentTaskId]) ||
		contract.finalTaskIds.includes(contract.developmentTaskId) ||
		canonicalJson([...contract.finalTaskIds, contract.developmentTaskId].sort()) !==
			canonicalJson(host.plan.tasks.map((t) => t.id).sort()) ||
		host.plan.budget.requests === undefined ||
		host.plan.model.requestOptions?.requireComplete !== true
	)
		throw new Error("frozen four-task pilot/development contract and strict total request cap required");
	await host.assertRunning(signal);
	const first = await storeLock(host.journal.root, async () => {
		const rows = await host.journal.read();
		const state = await host.journal.state();
		if (
			!state ||
			state.revision !== 0 ||
			state.phase !== "discover" ||
			state.spent.thoughts ||
			state.spent.probes ||
			state.limits.thoughts !== contract.thoughts ||
			state.limits.probes !== contract.probes ||
			rows.some((r) => ["pilot-run-reserved", "pilot-stop", "model-reserve"].includes(r.kind))
		)
			throw new Error("pilot needs fresh revision zero; consumed or interrupted runs cannot replay");
		assertResearchUnexposed(host.plan, state, rows);
		const raw = experiences(
			JSON.parse(
				(await readProtectedFile(host.journal.root, contract.experience!.file, 1024 * 1024)).toString("utf8"),
			),
		);
		if (canonicalJson(raw) !== canonicalJson(state.experiences))
			throw new Error("initial learning state differs from approved raw experience");
		for (const e of state.experiences.flatMap((x) => x.evidence))
			if (sha256(await readProtectedFile(host.journal.root, e.ref, 1024 * 1024)) !== e.digest)
				throw new Error("raw learning experience artifact mismatch");
		return host.journal.append("pilot-run-reserved", { planDigest: host.planDigest, contract });
	});
	const rows: GrowthPilotRow[] = contract.finalTaskIds.flatMap((taskId, index) =>
		(index === 1 || index === 2 ? (["B", "A"] as const) : (["A", "B"] as const)).map((condition) => ({
			taskId,
			condition,
			status: "missing",
			mode: null,
			observation: null,
			selection: null,
			retrievedMethodIds: null,
			usage: null,
			elapsedMs: null,
			reason: "not reached",
		})),
	);
	let status: GrowthPilotReport["status"] = "INCOMPLETE";
	let reason = "pilot did not finish";
	let correction: GrowthPilotReport["correction"] = "not-reached";
	let development: GrowthTaskResult | null = null;
	try {
		let state = await learn(host, signal);
		if (state.phase !== "trial-ready") {
			status = unavailable(state);
			reason = state.note || state.phase;
		} else {
			development = await runGrowthTask(host, contract.developmentTaskId, signal);
			if (development.status === "task-failed")
				throw new Error(development.reason || "development task interrupted");
			state = (await host.journal.state())!;
			if (
				development.mode === "method-used" &&
				development.observation?.outcome === "failure" &&
				state.phase === "suspended"
			) {
				correction = "failed";
				// Only actual development artifacts become fresh experience. Final scores never enter research.
				const task = host.plan.tasks.find((t) => t.id === contract.developmentTaskId)!;
				state = await reopen(
					state,
					[
						{
							id: `development-${development.observation.runId}`,
							taskId: task.id,
							expectation: task.description,
							observation: development.observation.summary,
							evidence: development.observation.evidence,
						},
					],
					host,
				);
				await host.journal.append("pilot-development-wake", {
					taskId: task.id,
					runId: development.observation.runId,
					revision: state.revision,
				});
				state = await learn(host, signal);
				if (state.phase === "trial-ready") correction = "revised";
			} else correction = development.mode === "method-used" ? "not-needed" : "not-observed";
			if (state.phase !== "trial-ready") {
				status = unavailable(state);
				reason = state.note || state.phase;
			} else {
				await host.reflect(signal);
				for (const row of rows) {
					await host.assertRunning(signal);
					state = (await host.journal.state())!;
					if (row.condition === "B" && (state.phase !== "trial-ready" || state.method?.status !== "trial-ready")) {
						row.reason = "method suspended; no forced restore or final-task retraining";
						continue;
					}
					const started = Date.now();
					const reservation = await host.journal.append("pilot-task-reserved", {
						taskId: row.taskId,
						condition: row.condition,
					});
					row.status = "interrupted";
					row.reason = "task interrupted";
					try {
						if (row.condition === "A") {
							row.mode = "control";
							row.retrievedMethodIds = [];
							row.observation = await host.runBaseline(row.taskId, true, signal);
						} else {
							const result = await runGrowthTask(host, row.taskId, signal);
							row.mode = result.mode;
							row.selection = result.selection ?? null;
							row.retrievedMethodIds = result.retrievedMethodIds;
							row.observation = result.observation ?? null;
							if (result.status === "task-failed") throw new Error(result.reason || "ordinary task interrupted");
						}
						row.status = "observed";
						row.reason = null;
					} catch (error) {
						row.reason = redactSecrets(error instanceof Error ? error.message : "task interrupted");
						throw error;
					} finally {
						row.usage = growthUsage((await host.journal.read()).filter((r) => r.seq > reservation.seq));
						row.elapsedMs = Date.now() - started;
						await host.journal.append("pilot-task-result", { ...row });
					}
				}
				if (rows.some((r) => r.status !== "observed")) {
					status = "INCOMPLETE";
					reason = "all eight registered conditions retained; some method conditions missing";
				} else {
					const wins = (condition: "A" | "B") =>
						rows.filter((r) => r.condition === condition && r.observation?.outcome === "success").length;
					status = wins("B") > wins("A") ? "PROMISING-PILOT" : "NO-OBSERVED-GAIN";
					reason = "four paired tasks, one run each; no formal P1/P2 pass or significance claim";
				}
			}
		}
	} catch (error) {
		status = "INCOMPLETE";
		reason = redactSecrets(error instanceof Error ? error.message : "pilot stopped");
	}
	for (const row of rows) if (row.status === "missing" && row.reason === "not reached") row.reason = reason;
	const report: GrowthPilotReport = {
		status,
		inquiryId: host.plan.inquiryId,
		planDigest: host.planDigest,
		correction,
		rows,
		development,
		usage: growthUsage((await host.journal.read()).filter((r) => r.seq > first.seq)),
		reason,
	};
	await host.journal.append("pilot-report", { ...report });
	await host.journal.append("pilot-stop", { status, reason, reportDigest: sha256(canonicalJson(report)) });
	return report;
}
