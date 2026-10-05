import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { loadRuntimeConfig } from "../her-core/bg-task-config.ts";
import { canonicalJson, readProtectedFile, sha256 } from "../her-core/improvement-plan.ts";
import type { GrowthHostPlan } from "./host.ts";
import { GrowthJournal, type GrowthReceipt } from "./journal.ts";
import { record, text } from "./parse.ts";
import { growthUsage } from "./task.ts";

export interface GrowthPilotAuthorization {
	version: 1;
	scope: "growth-pilot";
	inquiryId: string;
	memoryRoot: string;
	endpoint: string;
	approvedBy: string;
	proposalDigest: string;
	approval: { file: string; sha256: string };
	startsAt: string;
	expiresAt: string;
	historicalUnknown: {
		inquiryId: string;
		planDigest: string;
		runId: string;
		reservationDigest: string;
		decisionDigest: string;
	};
	previousPilot: { inquiryId: string; stopDigest: string };
	modelProbe: { inquiryId: string; receiptDigest: string };
}
/** The owner approves the complete immutable proposal; runtime clock fields are frozen separately once. */
export function growthPilotProposalDigest(plan: Readonly<GrowthHostPlan>): string {
	const { approvedBy: _owner, expiresAt: _window, pilotAuthorization: _authorization, ...proposal } = plan;
	return sha256(canonicalJson(proposal));
}
export async function readGrowthHistory(root: string): Promise<Array<{ id: string; rows: GrowthReceipt[] }>> {
	const files = await readdir(join(root, "proposals", "growth")).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const history = [];
	for (const name of files.filter((n) => n.endsWith(".md")).sort()) {
		const id = name.slice(0, -3);
		history.push({ id, rows: await new GrowthJournal(root, id).read() });
	}
	return history;
}
/** Owner files are attestations from an actual user message, not cryptographic proof of who wrote the local file. */
export async function validatePilotAuthorization(root: string, plan: Readonly<GrowthHostPlan>) {
	const auth = plan.pilotAuthorization;
	if (
		!plan.pilot ||
		!auth ||
		auth.version !== 1 ||
		auth.scope !== "growth-pilot" ||
		auth.inquiryId !== plan.inquiryId ||
		auth.approvedBy !== plan.approvedBy ||
		!auth.approvedBy?.trim() ||
		auth.proposalDigest !== growthPilotProposalDigest(plan) ||
		auth.historicalUnknown?.inquiryId === plan.inquiryId ||
		auth.previousPilot?.inquiryId === plan.inquiryId ||
		plan.model.requestOptions?.requireComplete !== true ||
		plan.model.maxOutputTokens > 8192 ||
		!Number.isSafeInteger(plan.budget.requests) ||
		plan.budget.requests! < 1 ||
		plan.budget.requests! > 32 ||
		plan.budget.tokens > 100000 ||
		plan.budget.usd > 1 ||
		plan.budget.wallMs > 1800000
	)
		throw new Error("explicit bound owner growth-pilot authorization required");
	if (
		(await realpath(root)).toLowerCase() !==
		(await realpath(text(auth.memoryRoot, "authorized memory root"))).toLowerCase()
	)
		throw new Error("pilot authorization bound to another memory root");
	if (
		auth.endpoint !== loadRuntimeConfig(root).llm.baseUrl ||
		plan.model.request !== loadRuntimeConfig(root).llm.modelFast
	)
		throw new Error("pilot endpoint changed from approved configuration");
	const start = Date.parse(auth.startsAt);
	const end = Date.parse(auth.expiresAt);
	if (
		!Number.isFinite(start) ||
		!Number.isFinite(end) ||
		!/(Z|[+-]\d{2}:\d{2})$/.test(auth.startsAt) ||
		!/(Z|[+-]\d{2}:\d{2})$/.test(auth.expiresAt) ||
		end - start !== plan.budget.wallMs ||
		auth.expiresAt !== plan.expiresAt
	)
		throw new Error("pilot clock window must be frozen once with an explicit timezone");
	const bytes = await readProtectedFile(root, auth.approval.file, 32768);
	if (sha256(bytes) !== auth.approval.sha256) throw new Error("owner approval artifact changed");
	const approval = record(JSON.parse(bytes.toString("utf8")), "owner approval");
	const source = record(approval.source, "approval source");
	const approvedAt = Date.parse(text(approval.approvedAt, "approval timestamp"));
	if (
		approval.version !== 1 ||
		approval.scope !== "growth-pilot" ||
		approval.inquiryId !== plan.inquiryId ||
		approval.approvedBy !== plan.approvedBy ||
		approval.proposalDigest !== auth.proposalDigest ||
		approval.memoryRoot !== auth.memoryRoot ||
		approval.endpoint !== auth.endpoint ||
		approval.acceptsHistoricalUnknown !== true ||
		canonicalJson(approval.historicalUnknown) !== canonicalJson(auth.historicalUnknown) ||
		canonicalJson(approval.previousPilot) !== canonicalJson(auth.previousPilot) ||
		canonicalJson(approval.modelProbe) !== canonicalJson(auth.modelProbe) ||
		source.kind !== "direct-user-message" ||
		!text(source.reference, "user approval reference") ||
		!text(source.quote, "actual user approval text") ||
		!Number.isFinite(approvedAt) ||
		approvedAt > start
	)
		throw new Error("new direct owner approval and specific historical risk acceptance required");
	const experience = plan.pilot.experience;
	if (!experience || sha256(await readProtectedFile(root, experience.file, 1024 * 1024)) !== experience.sha256)
		throw new Error("approved raw experience artifact changed");
	return { auth, approvedAt, approvalSourceReference: String(source.reference) };
}
/** Full directory audit, repeated at every operation and again under the request reservation lock. */
export async function auditGrowthPilot(root: string, plan: Readonly<GrowthHostPlan>) {
	const { auth, approvedAt, approvalSourceReference } = await validatePilotAuthorization(root, plan);
	const history = await readGrowthHistory(root);
	const old = history.find((h) => h.id === auth.historicalUnknown.inquiryId)?.rows;
	const reservation = old?.find(
		(r) => r.kind === "model-reserve" && r.digest === auth.historicalUnknown.reservationDigest,
	);
	const decision = old?.find(
		(r) => r.kind === "human-spend-risk-acceptance" && r.digest === auth.historicalUnknown.decisionDigest,
	);
	if (
		!old?.some((r) => r.kind === "plan" && r.data.digest === auth.historicalUnknown.planDigest) ||
		reservation?.data.runId !== auth.historicalUnknown.runId ||
		decision?.data.runId !== auth.historicalUnknown.runId ||
		decision?.data.reservationDigest !== reservation.digest ||
		decision?.data.actualTokens !== "unknown" ||
		decision?.data.actualUsd !== "unknown" ||
		old.some((r) => r.kind === "model-result" && r.data.runId === reservation.data.runId)
	)
		throw new Error("specific original unknown reservation/risk decision changed or missing");
	const stop = history
		.find((h) => h.id === auth.previousPilot.inquiryId)
		?.rows.find((r) => r.kind === "pilot-stop" && r.digest === auth.previousPilot.stopDigest);
	if (!stop || Date.parse(stop.at) > approvedAt) throw new Error("previous stopped pilot and fresh approval required");
	const probeRows = history.find((h) => h.id === auth.modelProbe.inquiryId)?.rows;
	const probe = probeRows?.find((r) => r.kind === "model-probe-result" && r.digest === auth.modelProbe.receiptDigest);
	const measured = probeRows?.find((r) => r.kind === "model-result" && r.data.runId === probe?.data.runId);
	const probedPlan = probeRows?.find((r) => r.kind === "plan" && r.data.digest === probe?.data.planDigest);
	if (
		!probe ||
		probe.data.status !== "model-ready" ||
		!measured ||
		measured.data.error ||
		measured.data.finishReason !== "stop" ||
		probe.data.tokens !== measured.data.tokens ||
		probe.data.reportedModel !== measured.data.model ||
		!plan.model.reported.includes(String(probe.data.reportedModel)) ||
		probe.data.provider !== plan.model.provider ||
		record(probedPlan?.data.model, "probed model plan").request !== plan.model.request
	)
		throw new Error("existing model-ready and actual usage receipt required; no new connectivity probe");
	for (const h of history) {
		if (h.rows.some((r) => typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at))))
			throw new Error("invalid growth receipt timestamp");
		if (h.id === plan.inquiryId && h.rows.some((r) => r.kind === "model-result" && r.data.error))
			throw new Error("growth previous provider failure; no automatic retry");
		const reserves = h.rows.filter((r) => r.kind === "model-reserve");
		const results = h.rows.filter((r) => r.kind === "model-result");
		if (
			new Set(reserves.map((r) => r.data.runId)).size !== reserves.length ||
			new Set(results.map((r) => r.data.runId)).size !== results.length
		)
			throw new Error("duplicate model accounting records");
		for (const r of results) {
			if (
				!reserves.some((s) => s.data.runId === r.data.runId) ||
				!Number.isSafeInteger(r.data.tokens) ||
				Number(r.data.tokens) < 0 ||
				typeof r.data.usd !== "number" ||
				!Number.isFinite(r.data.usd) ||
				r.data.usd < 0
			)
				throw new Error("invalid actual usage accounting");
		}
		for (const r of h.rows) {
			const original = h.id === auth.historicalUnknown.inquiryId && r.data.runId === auth.historicalUnknown.runId;
			if (
				(r.kind === "model-unknown" ||
					(r.kind === "model-reserve" && !results.some((s) => s.data.runId === r.data.runId))) &&
				!original
			)
				throw new Error("unreconciled spend outside specific owner decision; stop pilot");
			if (h.id !== plan.inquiryId && r.kind === "model-reserve" && Date.parse(r.at) >= Date.parse(auth.startsAt))
				throw new Error("concurrent spend outside approved inquiry; stop pilot");
			if (
				r.kind === "human-pilot-authorization" &&
				r.data.approvalSourceReference === approvalSourceReference &&
				h.id !== plan.inquiryId
			)
				throw new Error("owner approval already consumed by another inquiry");
		}
	}
	const inquiries = history.map((h) => ({ inquiryId: h.id, usage: growthUsage(h.rows) }));
	return {
		approvalSourceReference,
		inquiries,
		historicalUnknown: {
			inquiryId: auth.historicalUnknown.inquiryId,
			runId: auth.historicalUnknown.runId,
			tokens: "unknown",
			usd: "unknown",
		},
		knownTokens: inquiries.reduce((n, h) => n + h.usage.knownTokens, 0),
		knownEstimatedUsd: inquiries.reduce((n, h) => n + h.usage.knownEstimatedUsd, 0),
		totalTokens: "unknown",
		totalUsd: "unknown",
	};
}
/** Called inside the existing root lock. No mutation of previous inquiries or settlements. */
export async function freezePilotAuthorization(
	journal: GrowthJournal,
	plan: Readonly<GrowthHostPlan>,
	planDigest: string,
) {
	const digest = sha256(canonicalJson(plan.pilotAuthorization));
	const previous = (await journal.read()).find((r) => r.kind === "human-pilot-authorization");
	if (previous && (previous.data.authorizationDigest !== digest || previous.data.planDigest !== planDigest))
		throw new Error("pilot authorization changed after freeze");
	if (previous) return;
	const snapshot = await auditGrowthPilot(journal.root, plan);
	await journal.append("human-pilot-authorization", {
		planDigest,
		authorizationDigest: digest,
		authorization: plan.pilotAuthorization,
		approvalSourceReference: snapshot.approvalSourceReference,
		initialHistory: snapshot,
	});
}
