/**
 * G-132 — event-wake gate + ledger (pure fs/config logic; pi-agnostic).
 *
 * When a background task lands its `.done` sentinel while Samantha's session is
 * alive and idle, the extension layer wakes a follow-up turn. This module owns
 * only the pure, testable decisions:
 *   - shouldEventWake: may we send the wake follow-up? (enabled → daily_cap → usd_cap)
 *   - recordEventWake: append the wake outcome to the ledger (only "sent" counts)
 *   - eventWakeSpawnBlocked: hard predicate for the her_task_spawn tool entry
 * All pi coupling — reconcile, Telegram enqueue, sendMessage(followUp), the
 * wakeTurnActive flag — stays in extension.ts. This file imports no pi types.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TasksConfig } from "./bg-task-config.ts";
import { enforceDailyCostCap } from "./cost-ledger.ts";

export type EventWakeReason = "disabled" | "daily_cap" | "usd_cap";
export type EventWakeGate = { ok: true } | { ok: false; reason: EventWakeReason };
export type EventWakeStatus = "sent" | "failed";

type WakeLedgerRow = { at: string; taskIds: string[]; status: EventWakeStatus };

/**
 * Fixed boundary text appended after the wake block (design §唤醒回合边界). Tells
 * her what the wake turn is for, and that spawning new tasks is off-limits here.
 */
export const WAKE_TURN_BOUNDARY =
	'这些后台任务已终态。职责:her_task_output 读结果、"发生过"落 episodic、推进所属目标。' +
	"本回合不许 spawn 新后台任务(工具层会拒绝);需要新任务时写入待办等下次对话拍板。";

/** Refusal returned by her_task_spawn when called inside a wake turn (grok 缺口2 硬闸兜底). */
export const EVENT_WAKE_SPAWN_REFUSAL =
	"事件唤醒回合内不许派新任务:先读完已终态任务的结果、把发生过落进 episodic、推进所属目标;" +
	"需要新任务时写入待办,等下次对话拍板,不要在这个回合 spawn。";

function wakeLedgerPath(root: string): string {
	return join(root, ".her", "tasks", "wake-ledger.jsonl");
}

/**
 * Count wake-ledger rows with status "sent" stamped on the same UTC day as `now`.
 * UTC day-boundary (toISOString slice) is deliberate: several sessions share this
 * ledger, so cross-session consistency beats local-timezone precision.
 */
async function countSentToday(root: string, now: Date): Promise<number> {
	const today = now.toISOString().slice(0, 10);
	let text: string;
	try {
		text = await readFile(wakeLedgerPath(root), "utf8");
	} catch {
		return 0; // no ledger yet — degrade gracefully
	}
	let count = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let row: WakeLedgerRow;
		try {
			row = JSON.parse(line) as WakeLedgerRow;
		} catch {
			continue; // skip malformed line — degrade gracefully
		}
		if (row.status === "sent" && typeof row.at === "string" && row.at.slice(0, 10) === today) count += 1;
	}
	return count;
}

/**
 * Gate for the wake follow-up only. The caller enqueues Telegram unconditionally
 * before calling this (design B1 方案A: 通知与拉起解耦). Order matters:
 *   enabled → daily_cap (today's sent rows) → usd_cap (same $ ledger as spawn).
 */
export async function shouldEventWake(
	root: string,
	tasks: TasksConfig,
	now: Date = new Date(),
): Promise<EventWakeGate> {
	if (!tasks.eventWakeEnabled) return { ok: false, reason: "disabled" };
	if ((await countSentToday(root, now)) >= tasks.eventWakeDailyMax) return { ok: false, reason: "daily_cap" };
	try {
		await enforceDailyCostCap(root, tasks.budgetDailyCap, now.toISOString().slice(0, 10));
	} catch {
		return { ok: false, reason: "usd_cap" };
	}
	return { ok: true };
}

/** Append one wake-ledger row. Only "sent" rows count toward the daily cap. */
export async function recordEventWake(
	root: string,
	taskIds: string[],
	status: EventWakeStatus,
	now: Date = new Date(),
): Promise<void> {
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	const row: WakeLedgerRow = { at: now.toISOString(), taskIds, status };
	await appendFile(wakeLedgerPath(root), `${JSON.stringify(row)}\n`, "utf8");
}

/** Hard predicate for the her_task_spawn tool entry: block spawning inside a wake turn. */
export function eventWakeSpawnBlocked(wakeTurnActive: boolean, tasks: TasksConfig): boolean {
	return wakeTurnActive && tasks.eventWakeSpawnBlock;
}
