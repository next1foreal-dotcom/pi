import type { GrowthReceipt } from "./journal.ts";
import type { GrowthPilotAuthorization } from "./pilot-authorization.ts";

export interface HistoricalUnknown {
	inquiryId: string;
	planDigest: string;
	runId: string;
	reservationDigest: string;
	decisionDigest: string;
}
/** One additional, specifically stopped inquiry. This never creates a decision or settlement. */
export function auditAdditionalUnknown(
	history: Array<{ id: string; rows: GrowthReceipt[] }>,
	auth: GrowthPilotAuthorization,
): void {
	const risk = auth.additionalHistoricalUnknown;
	if (!risk) return;
	if (
		risk.inquiryId !== auth.previousPilot.inquiryId ||
		risk.inquiryId === auth.inquiryId ||
		(risk.inquiryId === auth.historicalUnknown.inquiryId && risk.runId === auth.historicalUnknown.runId)
	)
		throw new Error("additional unknown must refer to the specifically stopped previous pilot");
	const rows = history.find((h) => h.id === risk.inquiryId)?.rows ?? [];
	const reserve = rows.find((r) => r.kind === "model-reserve" && r.digest === risk.reservationDigest);
	const stop = rows.find((r) => r.kind === "pilot-stop" && r.digest === auth.previousPilot.stopDigest);
	const decision = rows.find((r) => r.kind === "human-spend-risk-acceptance" && r.digest === risk.decisionDigest);
	if (
		!rows.some((r) => r.kind === "plan" && r.data.digest === risk.planDigest) ||
		!stop ||
		!reserve ||
		Date.parse(reserve.at) > Date.parse(stop.at) ||
		reserve.data.runId !== risk.runId ||
		!decision ||
		decision.data.runId !== risk.runId ||
		decision.data.reservationDigest !== reserve.digest ||
		decision.data.actualTokens !== "unknown" ||
		decision.data.actualUsd !== "unknown" ||
		Date.parse(decision.at) > Date.parse(auth.startsAt) ||
		rows.some((r) => r.kind === "model-result" && r.data.runId === risk.runId)
	)
		throw new Error("additional historical unknown reservation/risk decision changed or missing");
}
