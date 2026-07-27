/**
 * G-145 — map deer-workflow `--print` JSONL events → Her run envelope patches.
 * Pure: no I/O. Unknown event types are ignored (caller may log).
 */

import type { HerRunEvent, HerRunKind, HerRunStatus } from "./runs.ts";

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
	source?: string;
}): DeerBridgeState {
	return {
		runId: opts.runId?.trim() || "",
		title: opts.title?.trim() || "deer-workflow",
		...(opts.parentRunId?.trim() ? { parentRunId: opts.parentRunId.trim() } : {}),
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
