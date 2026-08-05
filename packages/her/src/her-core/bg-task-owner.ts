/**
 * G-185/S1 — owner-first wake ownership (pure; pi-agnostic).
 *
 * A background task records the session that spawned it (`ownerSessionId`). When its
 * terminal event lands, that session should be the one woken, instead of whichever
 * live session happened to reconcile first.
 *
 * This module is the single authority for that verdict. `classifyOwnerWake` is consumed
 * at the reconcile claim point (G-185/S1b), where stamping `notifiedAt` and emitting a
 * WakeEvent happen together and only for a session allowed to claim. A session that
 * defers still advances the task's status but leaves it unstamped, so the owner's next
 * pass finds the event waiting: letting an event pass never burns it.
 *
 * Failure direction is fixed: when ownership timing cannot be read (timestamps
 * unparseable) we claim rather than defer. A wake landing in the wrong session is
 * recoverable; silence is not.
 */

import type { BgTaskRecord } from "./bg-task-record.ts";
import { type HerRunSnapshot, type HerWakeLedgerRow, listHerRunSnapshots, readRunsWakeLedger } from "./runs.ts";

/** 垫的 (spec §垫的): owner 会话 10 分钟内没接手 → 任何会话可代送。 */
export const OWNER_WAKE_GRACE_MS = 10 * 60 * 1000;

/**
 * - `own` — mine, or ownerless (legacy records / foreground spawns): claim immediately.
 * - `defer` — another session's, still inside the grace window: advance state, claim nothing.
 * - `takeover` — another session's, past the grace window: claim it, and say so in the wake.
 * - `external` — G-185/S5: Studio's watcher already reported it. Settle the record, stay quiet.
 */
export type OwnerWakeVerdict = "own" | "defer" | "takeover" | "external";

function ownerOf(record: BgTaskRecord): string {
	return typeof record.ownerSessionId === "string" ? record.ownerSessionId.trim() : "";
}

/**
 * Anchor for the grace clock. `endedAt` is the terminal moment; `created` is the stable
 * fallback. `updated` is deliberately not used — reconcile bumps it on every lease write,
 * so a takeover anchored on it would never fire.
 */
function graceAnchorMs(record: BgTaskRecord): number | null {
	for (const value of [record.endedAt, record.created]) {
		if (typeof value !== "string" || !value) continue;
		const ms = Date.parse(value);
		if (!Number.isNaN(ms)) return ms;
	}
	return null;
}

/**
 * Who may claim this task's terminal event right now. `mySessionId` undefined = the caller
 * is not a live session (headless reconcile): it may claim ownerless work immediately, and
 * owned work only once the owner's grace window has lapsed.
 */
export function classifyOwnerWake(
	record: BgTaskRecord,
	mySessionId: string | undefined,
	nowMs: number,
): OwnerWakeVerdict {
	const owner = ownerOf(record);
	if (!owner) return "own"; // ownerless (legacy record / 前台自建) — 现状: 先到先得
	if (mySessionId && owner === mySessionId) return "own";
	const anchor = graceAnchorMs(record);
	if (anchor === null) return "takeover"; // 读不出时刻 → 宁可代送也不静默
	return nowMs - anchor >= OWNER_WAKE_GRACE_MS ? "takeover" : "defer";
}

/** True when the event belongs to another session's poller (still inside the grace window). */
export function shouldDeferToOwner(record: BgTaskRecord, mySessionId: string | undefined, nowMs: number): boolean {
	return classifyOwnerWake(record, mySessionId, nowMs) === "defer";
}

/** True when this session claims another session's task because its owner never picked it up. */
export function isOwnerTakeover(record: BgTaskRecord, mySessionId: string | undefined, nowMs: number): boolean {
	return classifyOwnerWake(record, mySessionId, nowMs) === "takeover";
}

/**
 * G-188 — can a session running in this mode actually deliver a wake?
 *
 * Only a resident TUI session can: it is still there after the reconcile, with a next turn to
 * wake into. Everything else is one-shot — pi `--print`/`--mode json` process one prompt and
 * exit, and Studio spawns its RPC sessions per command (`pi-build.ts`: "Print mode is one-shot…
 * we spawn it… send exactly one command… then close stdin"). A one-shot claimer stamps
 * `notifiedAt`, exits holding the event, and the report is gone — which is exactly how G-148's
 * deer report was swallowed. Studio's own wakes come from the S3 server watcher instead.
 *
 * Unknown modes read as "cannot deliver": waiting is recoverable, swallowing is not.
 */
export function canDeliverWake(mode: string): boolean {
	return mode === "tui";
}

/** Annotation appended to the wake message when this session delivers for a gone owner. */
export function formatOwnerTakeoverNote(taskIds: string[]): string {
	if (taskIds.length === 0) return "";
	return `\n(owner session 已不在,代送: ${taskIds.join(", ")})`;
}

/**
 * G-185/S5 — bg-task ids Studio has already reported on.
 *
 * The Studio watcher wakes the owner workspace ~2 min after a task lands, long before pi's
 * 10-min takeover; without this join pi would tell Fei the same thing a second time. The
 * two worlds meet at `bgTaskId`: pi stamps it into the run envelope (S5), Studio's ledger
 * rows carry `runId`/`wakeId`, and this walks task → run → ledger.
 *
 * `failed: true` rows do **not** count as delivered. On the Studio side that flag settles the
 * key (stop retrying); from here it means the opposite — the watcher gave up, so nobody was
 * told, and pi's takeover is the last line of defense. Deliberate divergence from
 * samantha-ui's `settledWakeKeys`.
 */
export function matchExternalDeliveries(
	snapshots: readonly HerRunSnapshot[],
	rows: readonly HerWakeLedgerRow[],
): Set<string> {
	const delivered = new Set<string>();
	const byRunId = new Set<string>();
	const byWakeId = new Set<string>();
	for (const row of rows) {
		if (row.failed) continue;
		if (row.runId) byRunId.add(row.runId);
		// Browser rows carry no runId, so their wakeId is the only key available.
		else byWakeId.add(row.wakeId);
	}
	for (const run of snapshots) {
		if (!run.bgTaskId) continue;
		// G-183 display id — the identity Studio's browser path can compute.
		const wakeId = run.piSessionId ?? run.goalId ?? run.runId;
		if (byRunId.has(run.runId) || byWakeId.has(wakeId)) delivered.add(run.bgTaskId);
	}
	return delivered;
}

/** IO wrapper over `matchExternalDeliveries`. Missing books → empty set (nothing delivered). */
export async function loadExternalDeliveries(memoryRoot: string): Promise<Set<string>> {
	const [snapshots, rows] = await Promise.all([
		listHerRunSnapshots(memoryRoot, Number.MAX_SAFE_INTEGER),
		readRunsWakeLedger(memoryRoot),
	]);
	return matchExternalDeliveries(snapshots, rows);
}
