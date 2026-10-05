import type { CompletionResult } from "../her-core/model.ts";
import type { GrowthHostPlan } from "./host.ts";
import type { GrowthReceipt } from "./journal.ts";
import { record } from "./parse.ts";

export function nativeDiscoveryBootstrap(plan: Readonly<GrowthHostPlan>): boolean {
	const probe = plan.pilotAuthorization?.modelProbe;
	return !!plan.model.grokBuild && !!probe && "scope" in probe && probe.scope === "first-discovery-response";
}
export function assertNativeFirstPurpose(plan: Readonly<GrowthHostPlan>, rows: GrowthReceipt[], purpose: string): void {
	if (nativeDiscoveryBootstrap(plan) && !rows.some((r) => r.kind === "model-reserve") && purpose !== "discover")
		throw new Error("native readiness must come from first real discovery, not a connectivity probe");
}
/** Channel readiness only. It says nothing about learner competence or method quality. */
export function nativeReadiness(
	plan: Readonly<GrowthHostPlan>,
	purpose: string,
	result: CompletionResult,
	failure?: unknown,
) {
	if (
		!nativeDiscoveryBootstrap(plan) ||
		purpose !== "discover" ||
		failure !== undefined ||
		result.finishReason !== "stop" ||
		result.diagnostics?.usageStatus !== "complete"
	)
		return {};
	try {
		record(JSON.parse(result.text), "native discovery response");
	} catch {
		return {};
	}
	return { nativeReadiness: { scope: "first-discovery-response", status: "model-ready" } };
}
export function auditNativeDiscovery(plan: Readonly<GrowthHostPlan>, rows: GrowthReceipt[]): void {
	const first = rows.find((r) => r.kind === "model-reserve");
	if (!first) return;
	const measured = rows.find((r) => r.kind === "model-result" && r.data.runId === first.data.runId);
	if (
		!measured ||
		first.data.purpose !== "discover" ||
		measured.data.error ||
		measured.data.finishReason !== "stop" ||
		measured.data.provider !== plan.model.provider ||
		!plan.model.reported.includes(String(measured.data.model))
	)
		throw new Error("native first discovery lacks actual model-ready/usage; no replay");
	const ready = record(measured.data.nativeReadiness, "native readiness");
	const diagnostics = record(measured.data.diagnostics, "native diagnostics");
	const receipt = record(measured.data.nativeReceipt, "native usage receipt");
	const usage = record(measured.data.usage, "measured usage");
	if (
		ready.scope !== "first-discovery-response" ||
		ready.status !== "model-ready" ||
		diagnostics.identitySource !== "native-cli-ledger" ||
		diagnostics.modelIdentity !== "reported" ||
		diagnostics.usageStatus !== "complete" ||
		receipt.modelCalls !== 1 ||
		receipt.total !== measured.data.tokens ||
		usage.total_tokens !== receipt.total ||
		!Number.isSafeInteger(receipt.total) ||
		Number(receipt.total) < 0
	)
		throw new Error("native readiness receipt does not match actual discovery usage");
	record(JSON.parse(String(measured.data.response)), "native discovery response");
}
