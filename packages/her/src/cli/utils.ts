import { createHash } from "node:crypto";
import type { ClaimLedgerEntry, LongTaskStatus, WorldNoteData } from "../her-core/index.ts";
import { longTaskStatuses } from "../her-core/index.ts";

export class UsageError extends Error {}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function parsePositiveNumber(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`${option} must be a positive number`);
	return parsed;
}

export function parseOptionalPositiveNumber(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError("HER_TELEGRAM_PI_TIMEOUT_MS must be positive");
	return parsed;
}

export function parseNonNegativeNumber(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`${option} must be a non-negative number`);
	return parsed;
}

export function requireOptionValue(value: string | undefined, option: string): string {
	if (!value) throw new UsageError(`${option} requires a value`);
	return value;
}

export function requireNonBlank(value: string | undefined, option: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new UsageError(`${option} cannot be blank`);
	return trimmed;
}

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
	return requireNonBlank(env[name], name);
}

export function parseMemoryStatus(value: string): WorldNoteData["memoryStatus"] {
	if (value === "active" || value === "archive_only" || value === "needs_deep_read") return value;
	throw new UsageError("--memory-status must be active, archive_only, or needs_deep_read");
}

export function parseGoalStatus(value: string): LongTaskStatus {
	if (longTaskStatuses.includes(value as LongTaskStatus)) return value as LongTaskStatus;
	throw new UsageError("--status must be active, blocked, completed, or cancelled");
}

export function parseGoalCheckpointStatus(value: string): Extract<LongTaskStatus, "active" | "blocked"> {
	if (value === "active" || value === "blocked") return value;
	throw new UsageError("--status must be active or blocked for goal-checkpoint");
}

export function parseClaimJson(value: string): ClaimLedgerEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new UsageError(`--claim-json must be valid JSON: ${errorMessage(error)}`);
	}
	if (!parsed || typeof parsed !== "object") throw new UsageError("--claim-json must be a JSON object");
	const record = parsed as Record<string, unknown>;
	const verdict = record.verdict;
	const sourceQuality = record.sourceQuality;
	if (verdict !== "supported" && verdict !== "contradicted" && verdict !== "insufficient_evidence") {
		throw new UsageError("--claim-json verdict must be supported, contradicted, or insufficient_evidence");
	}
	if (
		sourceQuality !== "primary" &&
		sourceQuality !== "secondary" &&
		sourceQuality !== "weak" &&
		sourceQuality !== "unavailable" &&
		sourceQuality !== "blocked"
	) {
		throw new UsageError("--claim-json sourceQuality must be primary, secondary, weak, unavailable, or blocked");
	}
	const claim = requireNonBlank(stringField(record, "claim"), "claim");
	const evidence = requireNonBlank(stringField(record, "evidence"), "evidence");
	const caveats = stringField(record, "caveats")?.trim();
	return {
		claim,
		verdict,
		evidence,
		sourceQuality,
		...(caveats ? { caveats } : {}),
	};
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" ? value : undefined;
}

export function intakeContentHash(sourceUrl: string, extracted: string): string {
	return createHash("sha256").update(`${sourceUrl}\n${extracted}`).digest("hex");
}
