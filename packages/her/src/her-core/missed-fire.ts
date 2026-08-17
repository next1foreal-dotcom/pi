export const MISSED_FIRE_GRACE_MS = 2 * 60 * 60 * 1000;
export const MISSED_FIRE_MAX_CATCHUP = 5;

const DAY_MS = 86_400_000;

export type MissedFirePolicy = "skip" | "once" | "all";
export type CadenceOrgan = "reflect" | "choice-model" | "synthesize";

export interface MissedFireInput {
	lastRunMs: number;
	lastDueCheckMs?: number;
	nowMs: number;
	intervalDays: number;
	policy: MissedFirePolicy;
}

export interface MissedFireResult {
	due: boolean;
	owed: number;
	missed: number;
	policy: MissedFirePolicy;
	advanceAnchorTo?: string;
}

export function parseCadenceTimestamp(value: string | undefined | null): number | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const time = Date.parse(trimmed);
	return Number.isNaN(time) ? undefined : time;
}

export function parseMissedFirePolicy(raw: unknown, organ: CadenceOrgan): MissedFirePolicy {
	if (raw === undefined || raw === null || raw === "") return "once";
	if (raw === "skip" || raw === "once" || raw === "all") return raw;
	console.warn(`[her] missed-fire: invalid policy ${JSON.stringify(raw)} for ${organ}; falling back to once`);
	return "once";
}

export function lastRunStateKey(organ: CadenceOrgan): "last_reflect" | "last_choice_model" | "last_synthesize" {
	if (organ === "reflect") return "last_reflect";
	if (organ === "choice-model") return "last_choice_model";
	return "last_synthesize";
}

export function lastDueCheckStateKey(
	organ: CadenceOrgan,
): "last_due_check_reflect" | "last_due_check_choice_model" | "last_due_check_synthesize" {
	if (organ === "reflect") return "last_due_check_reflect";
	if (organ === "choice-model") return "last_due_check_choice_model";
	return "last_due_check_synthesize";
}

export function nextCadenceAnchorIso(input: {
	lastRunMs: number | undefined;
	nowMs: number;
	intervalDays: number;
	policy: MissedFirePolicy;
}): string {
	if (input.policy === "all" && input.lastRunMs !== undefined) {
		const step = input.intervalDays * DAY_MS;
		if (Number.isFinite(step) && step > 0) {
			return new Date(Math.min(input.lastRunMs + step, input.nowMs)).toISOString();
		}
	}
	return new Date(input.nowMs).toISOString();
}

export function computeMissedFire(input: MissedFireInput): MissedFireResult {
	const { lastRunMs, lastDueCheckMs, nowMs, intervalDays, policy } = input;
	if (lastRunMs > nowMs) {
		console.warn("[her] missed-fire: clock went backwards (lastRun after now); clamping G=0");
		return { due: false, owed: 0, missed: 0, policy };
	}
	const intervalMs = intervalDays * DAY_MS;
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		console.warn(`[her] missed-fire: invalid intervalDays ${intervalDays}; treating as not due`);
		return { due: false, owed: 0, missed: 0, policy };
	}
	const gridCount = Math.max(0, Math.floor((nowMs - lastRunMs) / intervalMs));
	if (gridCount === 0) return { due: false, owed: 0, missed: 0, policy };
	const missed = countMissedPoints(lastRunMs, lastDueCheckMs, nowMs, intervalMs, gridCount);
	if (missed >= MISSED_FIRE_MAX_CATCHUP) {
		console.warn(`[her] missed-fire: catch-up capped at ${MISSED_FIRE_MAX_CATCHUP} (missed=${missed})`);
	}
	return settleOwed(policy, lastRunMs, lastDueCheckMs, nowMs, intervalMs, gridCount, missed);
}

function countMissedPoints(
	lastRunMs: number,
	lastDueCheckMs: number | undefined,
	nowMs: number,
	intervalMs: number,
	gridCount: number,
): number {
	if (lastDueCheckMs === undefined) return Math.max(gridCount - 1, 0);
	const graceEnd = nowMs - MISSED_FIRE_GRACE_MS;
	let missed = 0;
	for (let k = 1; k <= gridCount; k++) {
		const at = lastRunMs + k * intervalMs;
		if (at > lastDueCheckMs && at <= graceEnd) missed += 1;
	}
	return missed;
}

function settleOwed(
	policy: MissedFirePolicy,
	lastRunMs: number,
	lastDueCheckMs: number | undefined,
	nowMs: number,
	intervalMs: number,
	gridCount: number,
	missed: number,
): MissedFireResult {
	const latestMs = lastRunMs + gridCount * intervalMs;
	const migrating = lastDueCheckMs === undefined;
	const liveShift = migrating || (latestMs > lastDueCheckMs && latestMs > nowMs - MISSED_FIRE_GRACE_MS);
	if (policy !== "skip") return { due: true, owed: 1, missed, policy };
	if (liveShift) return { due: true, owed: 1, missed, policy };
	if (missed > 0) {
		return { due: false, owed: 0, missed, policy, advanceAnchorTo: new Date(latestMs).toISOString() };
	}
	return { due: false, owed: 0, missed, policy };
}
