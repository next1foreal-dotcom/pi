/** Session-local execution receipts. No model calls, tool execution or memory writes. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createReadGuard, extractPath } from "../her-core/read-before-edit.ts";

export const REVIEW_ENTRY = "her-runtime-review-v1";
const MAX_RECEIPTS = 128;
const MAX_READS = 512;

export interface Check { name: string; key: string }
export interface Receipt {
	id: string;
	parent?: string;
	tool: string;
	key: string;
	path?: string;
	mutation: boolean;
	revision: number;
	started: number;
	ended?: number;
	check?: string;
}
export interface ReviewState {
	version: 1;
	clock: number;
	active: boolean;
	checks: Check[];
	reads: string[];
	pending: Receipt[];
	failed: Receipt[];
	passed: { name: string; revision: number; callId: string }[];
	revision: number;
	calls: number;
	maxCalls: number;
	continuations: number;
	maxContinuations: number;
	fault?: string;
	notified?: string;
}
export interface ReviewView {
	version: 1;
	status: "idle" | "blocked" | "needs-evidence" | "verified";
	revision: number;
	calls: number;
	maxCalls: number;
	failedCallIds: string[];
	pendingCallIds: string[];
	missingChecks: string[];
	fault?: string;
}

function blank(): ReviewState {
	return { version: 1, clock: 0, active: false, checks: [], reads: [], pending: [], failed: [], passed: [],
		revision: 0, calls: 0, maxCalls: 64, continuations: 0, maxContinuations: 0 };
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown, depth = 0): string {
	if (depth > 16) throw new Error("review input nesting limit");
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
	if (record(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k], depth + 1)}`).join(",")}}`;
	throw new Error("review input must be JSON");
}
export function callKey(tool: string, input: unknown): string {
	const text = canonical(input);
	if (text.length > 1_000_000) throw new Error("review input size limit");
	return createHash("sha256").update(`${tool}\0${text}`).digest("hex");
}
export function completionCall(tool: string, input: Record<string, unknown>): boolean {
	return tool === "her_goal_complete" ||
		(tool === "her_task_update" && (input.status === "done" || input.status === "completed"));
}
function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new Error(`expected integer ${min}..${max}`);
	}
	return value;
}

export class RuntimeReview {
	private state: ReviewState = blank();

	/** Only the operator command calls this. Models cannot replace acceptance requirements. */
	begin(raw: unknown): void {
		if (!record(raw) || !Array.isArray(raw.checks) || raw.checks.length < 1 || raw.checks.length > 8) {
			throw new Error("begin requires 1..8 checks");
		}
		const checks = raw.checks.map((check): Check => {
			if (!record(check) || typeof check.name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(check.name) ||
				(check.tool !== "bash" && check.tool !== "powershell") || !record(check.input) ||
				typeof check.input.command !== "string" || !check.input.command.trim() || check.input.command.length > 8192) {
				throw new Error("each check requires a safe name, bash/powershell tool and exact input.command");
			}
			return { name: check.name, key: callKey(check.tool, check.input) };
		});
		if (new Set(checks.map((c) => c.name)).size !== checks.length || new Set(checks.map((c) => c.key)).size !== checks.length) {
			throw new Error("duplicate check name or call");
		}
		this.state = { ...blank(), reads: [...this.state.reads], active: true, checks,
			maxCalls: boundedInt(raw.maxToolCalls, 64, 1, 512),
			maxContinuations: boundedInt(raw.maxContinuations, 0, 0, 2) };
	}

	reset(): void { this.state = { ...blank(), reads: [...this.state.reads] }; }
	fault(): void { this.state.fault = "observer-error"; }
	snapshot(): ReviewState { return structuredClone(this.state); }

	/** Reject corrupt snapshots; never turn a broken gate into a silently disabled gate. */
	restore(raw: unknown): void {
		try {
			if (!record(raw) || raw.version !== 1 || typeof raw.active !== "boolean") throw new Error("version");
			for (const field of ["checks", "reads", "pending", "failed", "passed"] as const) {
				if (!Array.isArray(raw[field])) throw new Error("array");
			}
			const next = structuredClone(raw) as unknown as ReviewState;
			if (next.checks.length > 8 || next.reads.length > MAX_READS || next.pending.length > MAX_RECEIPTS ||
				next.failed.length > MAX_RECEIPTS || next.passed.length > 8) throw new Error("size");
			for (const value of [next.clock, next.revision, next.calls, next.continuations]) {
				if (typeof value !== "number") throw new Error("counter");
				boundedInt(value, 0, 0, 1_000_000);
			}
			if (typeof next.maxCalls !== "number" || typeof next.maxContinuations !== "number") throw new Error("limits");
			boundedInt(next.maxCalls, 64, 1, 512);
			boundedInt(next.maxContinuations, 0, 0, 2);
			if (next.reads.some((p) => typeof p !== "string") ||
				next.checks.some((c) => !record(c) || typeof c.name !== "string" || typeof c.key !== "string") ||
				(next.active && next.checks.length === 0)) throw new Error("checks");
			for (const r of [...next.pending, ...next.failed]) {
				if (!record(r) || typeof r.id !== "string" || typeof r.key !== "string" || typeof r.tool !== "string" ||
					typeof r.mutation !== "boolean" || !Number.isInteger(r.revision) || !Number.isInteger(r.started) ||
					(r.ended !== undefined && !Number.isInteger(r.ended))) throw new Error("receipt");
			}
			if (next.passed.some((p) => !record(p) || typeof p.name !== "string" || typeof p.callId !== "string" ||
				!Number.isInteger(p.revision))) throw new Error("pass");
			// Interrupted work is not successful evidence. An identical successful retry can resolve it.
			if (next.failed.length + next.pending.length > MAX_RECEIPTS) next.fault = "receipt-overflow";
			next.failed = [...next.failed, ...next.pending.map((p) => ({ ...p, ended: ++next.clock }))].slice(-MAX_RECEIPTS);
			if (next.pending.some((p) => p.mutation)) next.revision++;
			next.pending = [];
			this.state = next;
		} catch {
			this.state = { ...blank(), active: true, fault: "corrupt-review-state" };
		}
	}

	guard(tool: string, input: Record<string, unknown>, cwd: string, id: string): string | undefined {
		const guard = createReadGuard();
		for (const path of this.state.reads) guard.noteToolCall("read", { path });
		const rawPath = extractPath(input);
		const verdict = guard.checkToolCall(tool, rawPath ? { path: resolve(cwd, rawPath) } : input);
		if (verdict.block) return verdict.reason;
		if (this.state.fault) return "Her runtime review failed; operator inspection/reset is required.";
		if (!this.state.active) return undefined;
		if (completionCall(tool, input)) {
			const view = this.view(id);
			if (view.status !== "verified") return `Her review refuses completion: ${this.summary(view)}`;
		} else if (this.state.calls > this.state.maxCalls ||
			(!this.state.pending.some((p) => p.id === id) && this.state.calls >= this.state.maxCalls)) {
			return "Her review tool-call budget exhausted. Stop and ask the operator.";
		}
		return undefined;
	}

	start(id: string, tool: string, input: Record<string, unknown>, cwd: string, mutation: boolean, parent?: string): void {
		if (this.state.pending.some((p) => p.id === id)) return;
		if (this.state.pending.length >= MAX_RECEIPTS) { this.fault(); return; }
		const key = callKey(tool, input);
		const check = this.state.checks.find((c) => c.key === key)?.name;
		const isMutation = mutation && !check && tool !== "codemode" && !completionCall(tool, input);
		if (this.state.active) {
			if (!completionCall(tool, input)) this.state.calls++;
			if (isMutation) this.state.revision++;
		}
		const path = extractPath(input);
		this.state.pending.push({ id, tool, key, mutation: isMutation, revision: this.state.revision, started: ++this.state.clock,
			...(parent ? { parent } : {}), ...(check ? { check } : {}), ...(path ? { path: resolve(cwd, path) } : {}) });
	}

	/** Called with Pi's final execution-end status, not with the model's narrative. */
	finish(id: string, isError: boolean): void {
		const call = this.state.pending.find((p) => p.id === id);
		if (!call) { if (this.state.active) this.fault(); return; }
		this.state.pending = this.state.pending.filter((p) => p.id !== id);
		call.ended = ++this.state.clock;
		if (!isError && (call.tool === "read" || call.tool === "write") && call.path) {
			this.state.reads = [...this.state.reads.filter((p) => p !== call.path), call.path].slice(-MAX_READS);
		}
		if (!this.state.active || call.tool === "her_goal_complete" || call.tool === "her_task_update") return;
		if (call.mutation) this.state.revision++;
		if (isError) {
			this.state.failed = this.state.failed.filter((r) => r.key !== call.key);
			this.state.failed.push(call);
			if (this.state.failed.length > MAX_RECEIPTS) { this.state.failed.length = MAX_RECEIPTS; this.fault(); }
		} else {
			// An overlapping success is not a retry of a failure that had not happened yet.
			this.state.failed = this.state.failed.filter((r) => r.key !== call.key || (r.ended ?? Infinity) >= call.started);
		}
		if (call.check) {
			this.state.passed = this.state.passed.filter((p) => p.name !== call.check);
			if (!isError && call.revision === this.state.revision && !this.state.pending.some((p) => p.mutation)) {
				this.state.passed.push({ name: call.check, revision: this.state.revision, callId: call.id });
			}
		}
	}

	view(excludeId?: string): ReviewView {
		// A still-running codemode parent may perform more work after an inner completion.
		// Finalize in a standalone model tool call after its parent and siblings have ended.
		const pending = this.state.pending.filter((p) => p.id !== excludeId);
		const missingChecks = this.state.checks.filter((c) => !this.state.passed.some((p) =>
			p.name === c.name && p.revision === this.state.revision)).map((c) => c.name);
		const status = this.state.fault || (this.state.active && (this.state.failed.length > 0 || pending.length > 0)) ? "blocked" :
			!this.state.active ? "idle" : missingChecks.length > 0 ? "needs-evidence" : "verified";
		return { version: 1, status, revision: this.state.revision, calls: this.state.calls, maxCalls: this.state.maxCalls,
			failedCallIds: this.state.failed.map((r) => r.id), pendingCallIds: pending.map((p) => p.id), missingChecks,
			...(this.state.fault ? { fault: this.state.fault } : {}) };
	}

	summary(view = this.view()): string {
		return `${view.status}; checks missing: ${view.missingChecks.join(", ") || "none"}; ` +
			`failed calls: ${view.failedCallIds.join(", ") || "none"}; pending: ${view.pendingCallIds.length}; ` +
			`calls ${view.calls}/${view.maxCalls}${view.fault ? `; ${view.fault}` : ""}`;
	}

	settle(canContinue: boolean): { notify: boolean; continue: boolean; view: ReviewView } {
		const view = this.view();
		const fingerprint = callKey("review", view);
		const notify = view.status !== "idle" && fingerprint !== this.state.notified;
		if (notify) this.state.notified = fingerprint;
		const needsWork = view.status === "blocked" || view.status === "needs-evidence";
		const next = notify && needsWork && canContinue && !view.fault && view.pendingCallIds.length === 0 &&
			this.state.calls < this.state.maxCalls && this.state.continuations < this.state.maxContinuations;
		if (next) this.state.continuations++;
		return { notify, continue: next, view };
	}
}
