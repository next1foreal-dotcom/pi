/**
 * G-145 — map deer-workflow `--print` JSONL events → Her run envelope patches.
 * Pure: no I/O. Unknown event types are ignored (caller may log).
 */

import { join } from "node:path";

import type { HerRunEvent, HerRunKind, HerRunStatus } from "./runs.ts";

/** Task ids are our own (`t-YYYYMMDD-xxxxxx`); anything else must not name a path. */
const JOURNAL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * G-193 — where a deer run records the Agent answers it produces, or
 * `undefined` for a run that keeps no journal.
 *
 * Keyed by `resumeFrom` when the brief explicitly asks to continue an earlier
 * task, and by the run's own task id otherwise. A new task's id is new, so its
 * journal is empty and it replays nothing: reusing recorded answers inside work
 * that was meant to be done again would report old news as new.
 *
 * Kept out of `.her/tasks` on purpose — sidecar files next to task records have
 * broken all three record scanners before (G-188). A run with no task id of its
 * own gets no journal at all; borrowing a key would let one run replay
 * another's answers.
 */
export function deerJournalPath(
	memoryRoot: string,
	taskId: string | undefined,
	resumeFrom: string | undefined,
): string | undefined {
	const key = resumeFrom?.trim() || taskId?.trim();
	if (!key || !JOURNAL_KEY_RE.test(key)) {
		return undefined;
	}
	return join(memoryRoot, ".her", "workflow-journals", `${key}.jsonl`);
}

export const DEER_RUN_KIND: HerRunKind = "workflow";
export const DEER_RUN_SOURCE = "deer-workflow";

/** Subset of deer-workflow event shapes we care about (0.1.0). */
export type DeerWorkflowEvent = {
	type: string;
	workflowId?: string;
	scriptPath?: string;
	phase?: string;
	message?: string;
	timestamp?: string;
	durationMs?: number;
	meta?: {
		name?: string;
		description?: string;
		phases?: { title?: string }[];
	};
	error?: {
		name?: string;
		message?: string;
	};
};

export type DeerBridgeState = {
	runId: string;
	title: string;
	workflowName?: string;
	parentRunId?: string;
	/** G-185/S5 — session that spawned the bg task behind this run (pi's `ownerSessionId`). */
	ownerWorkspaceId?: string;
	/** G-185/S5 — `.her/tasks` id, so Studio can join this run back to the task. */
	bgTaskId?: string;
	source: string;
};

export type DeerBridgePatch = Omit<HerRunEvent, "type">;

function basename(scriptPath: string): string {
	const norm = scriptPath.replace(/\\/g, "/");
	const i = norm.lastIndexOf("/");
	return i >= 0 ? norm.slice(i + 1) : norm;
}

function truncate(text: string, max = 160): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function defaultDeerRunId(workflowId: string): string {
	return `deer-${workflowId}`;
}

export function createDeerBridgeState(opts: {
	runId?: string;
	title?: string;
	parentRunId?: string;
	ownerWorkspaceId?: string;
	bgTaskId?: string;
	source?: string;
}): DeerBridgeState {
	return {
		runId: opts.runId?.trim() || "",
		title: opts.title?.trim() || "deer-workflow",
		...(opts.parentRunId?.trim() ? { parentRunId: opts.parentRunId.trim() } : {}),
		...(opts.ownerWorkspaceId?.trim() ? { ownerWorkspaceId: opts.ownerWorkspaceId.trim() } : {}),
		...(opts.bgTaskId?.trim() ? { bgTaskId: opts.bgTaskId.trim() } : {}),
		source: opts.source?.trim() || DEER_RUN_SOURCE,
	};
}

/**
 * Apply one deer JSONL event. Returns a Her run patch to append, or null if no envelope change.
 */
export function applyDeerWorkflowEvent(
	state: DeerBridgeState,
	raw: unknown,
): { state: DeerBridgeState; patch: DeerBridgePatch | null; ignoredType?: string } {
	if (!raw || typeof raw !== "object") {
		return { state, patch: null, ignoredType: "non-object" };
	}
	const event = raw as DeerWorkflowEvent;
	const type = typeof event.type === "string" ? event.type : "";
	const at =
		typeof event.timestamp === "string" && event.timestamp.length > 0 ? event.timestamp : new Date().toISOString();

	let next: DeerBridgeState = state;
	if (!next.runId && typeof event.workflowId === "string" && event.workflowId) {
		next = { ...next, runId: defaultDeerRunId(event.workflowId) };
	}

	const base = (): DeerBridgePatch | null => {
		if (!next.runId) return null;
		return {
			runId: next.runId,
			status: "running",
			kind: DEER_RUN_KIND,
			source: next.source,
			title: next.title,
			at,
			...(next.parentRunId ? { parentRunId: next.parentRunId } : {}),
			...(next.ownerWorkspaceId ? { ownerWorkspaceId: next.ownerWorkspaceId } : {}),
			...(next.bgTaskId ? { bgTaskId: next.bgTaskId } : {}),
		};
	};

	switch (type) {
		case "workflow:start": {
			if (typeof event.scriptPath === "string" && event.scriptPath && next.title === "deer-workflow") {
				next = { ...next, title: basename(event.scriptPath) };
			}
			const patch = base();
			return { state: next, patch: patch ? { ...patch, status: "running" as HerRunStatus } : null };
		}
		case "workflow:meta": {
			const name = event.meta?.name?.trim();
			if (name) next = { ...next, workflowName: name, title: name };
			const patch = base();
			return { state: next, patch };
		}
		case "workflow:phase:start": {
			const phase = typeof event.phase === "string" ? event.phase.trim() : "";
			const name = next.workflowName || next.title;
			if (phase) next = { ...next, title: `${name} · ${phase}` };
			const patch = base();
			return { state: next, patch };
		}
		case "workflow:phase:end":
		case "log":
			return { state: next, patch: null };
		case "workflow:end": {
			const patch = base();
			return {
				state: next,
				patch: patch ? { ...patch, status: "done", title: next.workflowName || next.title } : null,
			};
		}
		case "workflow:error": {
			const msg = event.error?.message?.trim() || event.error?.name?.trim() || "workflow error";
			const patch = base();
			return {
				state: next,
				patch: patch
					? {
							...patch,
							status: "failed",
							title: truncate(`${next.workflowName || next.title}: ${msg}`),
						}
					: null,
			};
		}
		default:
			return { state: next, patch: null, ignoredType: type || "missing-type" };
	}
}

/** Parse one stdout line; invalid JSON → ignored. */
export function parseDeerWorkflowLine(line: string): unknown | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}
