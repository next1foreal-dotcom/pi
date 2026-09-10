/**
 * G-448 — poll the filesystem for the first session-inbox or bg-task terminal event.
 * Zero model calls. Return values must never include message or task bodies.
 */

import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { isTerminal, loadBgTask } from "./bg-task-record.ts";

export const SESSION_WAIT_POLL_MS = 1000;
export const SESSION_WAIT_MAX_TARGETS = 8;
export const SESSION_WAIT_DEFAULT_TIMEOUT_MS = 120_000;

/** Refusal returned by her_session_wait inside an event-wake or heartbeat turn. */
export const SESSION_WAIT_REFUSAL =
	"事件唤醒或心跳回合内不许等待:her_session_wait 会阻塞最多 120 秒,无人值守回合里空等是浪费;" +
	"需要等会话消息或任务终态时,等下次对话再调。";

export type SessionWaitTarget = { kind: "session"; id: string } | { kind: "task"; id: string };

export type SessionWaitReady = {
	status: "ready";
	kind: "message" | "task";
	target: SessionWaitTarget;
	elapsedMs: number;
};

export type SessionWaitTimeout = {
	status: "timeout";
	elapsedMs: number;
	targets: Array<SessionWaitTarget & { state: string }>;
};

export type SessionWaitRefused = {
	status: "refused";
	reason: string;
};

export type SessionWaitResult = SessionWaitReady | SessionWaitTimeout | SessionWaitRefused;

export type SessionWaitInput = {
	root: string;
	selfId: string;
	targets: SessionWaitTarget[];
	timeoutMs?: number;
	wakeTurnActive?: boolean;
	heartbeat?: boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
};

/** Hard predicate for the her_session_wait tool entry: no blocking in wake/heartbeat turns. */
export function sessionWaitBlocked(wakeTurnActive: boolean, heartbeat = false): boolean {
	return wakeTurnActive || heartbeat;
}

export async function sessionWait(input: SessionWaitInput): Promise<SessionWaitResult> {
	const targets = input.targets;
	if (!Array.isArray(targets) || targets.length < 1 || targets.length > SESSION_WAIT_MAX_TARGETS) {
		throw new Error("her_session_wait: targets must contain 1 to 8 items");
	}
	for (const target of targets) {
		if ((target.kind !== "session" && target.kind !== "task") || !isSafeId(target.id)) {
			throw new Error("her_session_wait: each target needs kind session|task and a safe id");
		}
	}
	if (!isSafeId(input.selfId)) {
		throw new Error("her_session_wait: selfId must be a safe session id");
	}
	const timeoutMs = resolveTimeoutMs(input.timeoutMs);
	if (sessionWaitBlocked(input.wakeTurnActive === true, input.heartbeat === true)) {
		return { status: "refused", reason: SESSION_WAIT_REFUSAL };
	}

	const now = input.now ?? Date.now;
	const sleep = input.sleep ?? defaultSleep;
	const baseline = new Set(await listInboxFiles(input.root, input.selfId));
	const start = now();

	while (true) {
		const hit = await firstActivity(input.root, input.selfId, targets, baseline);
		const elapsedMs = now() - start;
		if (hit) return { status: "ready", ...hit, elapsedMs };
		if (elapsedMs >= timeoutMs) {
			return {
				status: "timeout",
				elapsedMs,
				targets: await snapshotTargets(input.root, targets),
			};
		}
		await sleep(Math.min(SESSION_WAIT_POLL_MS, timeoutMs - elapsedMs));
	}
}

function resolveTimeoutMs(value: number | undefined): number {
	if (value === undefined) return SESSION_WAIT_DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(value) || value < 0 || value > SESSION_WAIT_DEFAULT_TIMEOUT_MS) {
		throw new Error("her_session_wait: timeout_ms must be an integer in 0..120000");
	}
	return value;
}

function isSafeId(value: string): boolean {
	return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value);
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listInboxFiles(root: string, selfId: string): Promise<string[]> {
	const dir = join(root, "messages", selfId);
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const paths: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		paths.push(join(dir, entry.name));
	}
	paths.sort((left, right) => left.localeCompare(right));
	return paths;
}

function senderFromFilename(name: string): string | undefined {
	if (!name.endsWith(".md")) return undefined;
	const stem = name.slice(0, -3);
	const sep = stem.lastIndexOf("--");
	if (sep < 0) return undefined;
	const from = stem.slice(sep + 2);
	return isSafeId(from) ? from : undefined;
}

async function firstActivity(
	root: string,
	selfId: string,
	targets: SessionWaitTarget[],
	baseline: Set<string>,
): Promise<{ kind: "message" | "task"; target: SessionWaitTarget } | undefined> {
	const current = await listInboxFiles(root, selfId);
	const newcomers = new Set<string>();
	for (const path of current) {
		if (baseline.has(path)) continue;
		const from = senderFromFilename(basename(path));
		if (from) newcomers.add(from);
	}
	for (const target of targets) {
		if (target.kind === "session") {
			if (newcomers.has(target.id)) return { kind: "message", target };
			continue;
		}
		const loaded = await loadBgTask(root, target.id);
		if (loaded && isTerminal(loaded.record.status)) return { kind: "task", target };
	}
	return undefined;
}

async function snapshotTargets(
	root: string,
	targets: SessionWaitTarget[],
): Promise<Array<SessionWaitTarget & { state: string }>> {
	const rows: Array<SessionWaitTarget & { state: string }> = [];
	for (const target of targets) {
		if (target.kind === "session") {
			rows.push({ ...target, state: "waiting" });
			continue;
		}
		const loaded = await loadBgTask(root, target.id);
		rows.push({ ...target, state: loaded?.record.status ?? "missing" });
	}
	return rows;
}
