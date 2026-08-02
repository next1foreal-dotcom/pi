/**
 * G-185/S1 — owner-first wake sorting (pure; pi-agnostic).
 *
 * A background task now records the session that spawned it (`ownerSessionId`).
 * When its terminal event lands, that session's poller should be the one woken,
 * instead of whichever live session happened to reconcile first. This module owns
 * only the sorting decision:
 *   - shouldDeferToOwner: is this event another session's to deliver (for now)?
 *   - isOwnerTakeover: am I delivering it only because the owner never showed up?
 *   - sortEventsByOwner: split one reconcile batch into deliver / deferred.
 *
 * G-132's lease + notifiedAt + wake-ledger are untouched — this is a pre-send
 * filter on the event batch, not a second dedup mechanism.
 *
 * Failure direction is fixed: when ownership or timing cannot be read (record
 * missing, timestamps unparseable) we deliver rather than defer. A wake landing
 * in the wrong session is recoverable; silence is not.
 */

import type { WakeEvent } from "./bg-task-reconcile.ts";
import { type BgTaskRecord, loadBgTask } from "./bg-task-record.ts";

/** 垫的 (spec §垫的): owner 会话 10 分钟内没接手 → 任何会话可代送。 */
export const OWNER_WAKE_GRACE_MS = 10 * 60 * 1000;

type OwnerVerdict = "own" | "defer" | "takeover";

function ownerOf(record: BgTaskRecord): string {
	return typeof record.ownerSessionId === "string" ? record.ownerSessionId.trim() : "";
}

/**
 * Anchor for the grace clock. `endedAt` is the terminal moment; `created` is the
 * stable fallback. `updated` is deliberately not used — reconcile bumps it on every
 * lease write, so a takeover anchored on it would never fire.
 */
function graceAnchorMs(record: BgTaskRecord): number | null {
	for (const value of [record.endedAt, record.created]) {
		if (typeof value !== "string" || !value) continue;
		const ms = Date.parse(value);
		if (!Number.isNaN(ms)) return ms;
	}
	return null;
}

function classify(record: BgTaskRecord, mySessionId: string | undefined, nowMs: number): OwnerVerdict {
	const owner = ownerOf(record);
	if (!owner) return "own"; // ownerless (legacy record / 前台自建) — 现状: 先到先得
	if (mySessionId && owner === mySessionId) return "own";
	const anchor = graceAnchorMs(record);
	if (anchor === null) return "takeover"; // 读不出时刻 → 宁可代送也不静默
	return nowMs - anchor >= OWNER_WAKE_GRACE_MS ? "takeover" : "defer";
}

/** True when the event belongs to another session's poller (still inside the grace window). */
export function shouldDeferToOwner(record: BgTaskRecord, mySessionId: string | undefined, nowMs: number): boolean {
	return classify(record, mySessionId, nowMs) === "defer";
}

/** True when this session delivers another session's task because its owner never picked it up. */
export function isOwnerTakeover(record: BgTaskRecord, mySessionId: string | undefined, nowMs: number): boolean {
	return classify(record, mySessionId, nowMs) === "takeover";
}

/** Annotation appended to the wake message when this session delivers for a gone owner. */
export function formatOwnerTakeoverNote(taskIds: string[]): string {
	if (taskIds.length === 0) return "";
	return `\n(owner session 已不在,代送: ${taskIds.join(", ")})`;
}

export type OwnerWakeSort = {
	/** Events this session should wake on. */
	deliver: WakeEvent[];
	/** Task ids left to their owner session's poller this round. */
	deferred: string[];
	/** Delivered ids whose owner never showed up — annotated in the wake message. */
	takenOver: string[];
};

/**
 * Split a reconcile batch by ownership. A record that fails to load is delivered
 * (treated as ownerless) — see the failure-direction note above.
 */
export async function sortEventsByOwner(
	memoryRoot: string,
	events: WakeEvent[],
	mySessionId: string | undefined,
	now: Date = new Date(),
): Promise<OwnerWakeSort> {
	const nowMs = now.getTime();
	const deliver: WakeEvent[] = [];
	const deferred: string[] = [];
	const takenOver: string[] = [];
	for (const event of events) {
		let record: BgTaskRecord | undefined;
		try {
			record = (await loadBgTask(memoryRoot, event.taskId))?.record;
		} catch {
			record = undefined;
		}
		const verdict = record ? classify(record, mySessionId, nowMs) : "own";
		if (verdict === "defer") {
			deferred.push(event.taskId);
			continue;
		}
		if (verdict === "takeover") takenOver.push(event.taskId);
		deliver.push(event);
	}
	return { deliver, deferred, takenOver };
}
