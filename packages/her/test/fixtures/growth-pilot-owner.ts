import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GrowthHostPlan } from "../../src/growth-experiment/host.ts";
import { GrowthJournal } from "../../src/growth-experiment/journal.ts";
import { growthPilotProposalDigest } from "../../src/growth-experiment/pilot-authorization.ts";
import type { Experience } from "../../src/growth-experiment/types.ts";
import { loadRuntimeConfig } from "../../src/her-core/bg-task-config.ts";
import { sha256 } from "../../src/her-core/improvement-plan.ts";

/** Explicitly synthetic owner/history fixture. It is never an approval or bill for a real experiment. */
export async function authorizePilotFixture(root: string, plan: GrowthHostPlan, experiences: Experience[]) {
	const old = new GrowthJournal(root, "historical-inquiry");
	const planDigest = sha256("old fixture plan");
	await old.append("plan", { digest: planDigest, model: plan.model });
	const reserve = await old.append("model-reserve", { runId: "accepted-old", reservedTokens: 500 });
	const decision = await old.append("human-spend-risk-acceptance", {
		runId: "accepted-old",
		reservationDigest: reserve.digest,
		actualTokens: "unknown",
		actualUsd: "unknown",
	});
	await old.append("model-reserve", { runId: "previous-probe", reservedTokens: 500 });
	await old.append("model-result", {
		runId: "previous-probe",
		tokens: 30,
		usd: 0.000018,
		model: plan.model.reported[0],
		provider: plan.model.provider,
		finishReason: "stop",
		usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
	});
	const probe = await old.append("model-probe-result", {
		status: "model-ready",
		scope: "provider-response-only",
		runId: "previous-probe",
		planDigest,
		reportedModel: plan.model.reported[0],
		provider: plan.model.provider,
		tokens: 30,
	});
	const prior = new GrowthJournal(root, "stopped-pilot");
	await prior.append("plan", { digest: sha256("previous stopped fixture"), model: plan.model });
	await prior.append("model-reserve", { runId: "stopped-known", reservedTokens: 500 });
	await prior.append("model-result", { runId: "stopped-known", tokens: 30, usd: 0.000018 });
	const stop = await prior.append("pilot-stop", { status: "INCOMPLETE", reason: "fixture stop" });
	const input = JSON.stringify(experiences);
	await writeFile(join(root, "evals/pilot-experiences.json"), input);
	plan.pilot!.experience = { file: "evals/pilot-experiences.json", sha256: sha256(input) };
	const now = new Date().toISOString();
	plan.expiresAt = new Date(Date.parse(now) + plan.budget.wallMs).toISOString();
	const historicalUnknown = {
		inquiryId: old.id,
		planDigest,
		runId: "accepted-old",
		reservationDigest: reserve.digest,
		decisionDigest: decision.digest,
	};
	const proposalDigest = growthPilotProposalDigest(plan);
	const endpoint = loadRuntimeConfig(root).llm.baseUrl;
	const previousPilot = { inquiryId: prior.id, stopDigest: stop.digest };
	const modelProbe = { inquiryId: old.id, receiptDigest: probe.digest };
	const approval = JSON.stringify({
		version: 1,
		scope: "growth-pilot",
		inquiryId: plan.inquiryId,
		approvedBy: plan.approvedBy,
		approvedAt: now,
		memoryRoot: root,
		endpoint,
		proposalDigest,
		acceptsHistoricalUnknown: true,
		historicalUnknown,
		previousPilot,
		modelProbe,
		source: {
			kind: "direct-user-message",
			reference: "offline-engineering-owner-fixture-only",
			quote: "Synthetic protocol authorization; never use for live requests.",
		},
	});
	await writeFile(join(root, "evals/pilot-approval.json"), approval);
	plan.pilotAuthorization = {
		version: 1,
		scope: "growth-pilot",
		inquiryId: plan.inquiryId,
		memoryRoot: root,
		endpoint,
		approvedBy: plan.approvedBy,
		proposalDigest,
		approval: { file: "evals/pilot-approval.json", sha256: sha256(approval) },
		startsAt: now,
		expiresAt: plan.expiresAt,
		historicalUnknown,
		previousPilot,
		modelProbe,
	};
}
