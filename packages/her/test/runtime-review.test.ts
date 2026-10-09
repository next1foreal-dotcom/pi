import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRuntimeReview } from "../src/runtime-review/extension.ts";
import { callKey, REVIEW_ENTRY, RuntimeReview } from "../src/runtime-review/state.ts";

const cwd = "/work/project";
const checkInput = { command: "node --test test/unit.test.ts" };
const contract = { checks: [{ name: "unit", tool: "bash", input: checkInput }] };
function armed(extra: Record<string, unknown> = {}): RuntimeReview {
	const r = new RuntimeReview();
	r.begin({ ...contract, ...extra });
	return r;
}
function execute(r: RuntimeReview, id: string, tool: string, input: Record<string, unknown>, error = false, mutation = false, parent?: string): void {
	r.start(id, tool, input, cwd, mutation, parent);
	r.finish(id, error);
}

test("call fingerprints are stable across object ordering, and reject non-JSON", () => {
	assert.equal(callKey("bash", { a: 1, b: 2 }), callKey("bash", { b: 2, a: 1 }));
	assert.notEqual(callKey("bash", { a: 1 }), callKey("read", { a: 1 }));
	assert.throws(() => callKey("bash", { a: Number.NaN }));
});
test("empty, ambiguous and duplicate contracts cannot arm a green gate", () => {
	const r = armed();
	for (const invalid of [{}, { checks: [] }, { ...contract, maxToolCalls: 0 },
		{ ...contract, maxContinuations: 3 }, { checks: [...contract.checks, ...contract.checks] },
		{ checks: [{ name: "bad", tool: "read", input: { path: "x" } }] }]) {
		assert.throws(() => r.begin(invalid));
		assert.equal(r.view().status, "needs-evidence");
	}
});
test("a read attempt or failed read never grants edit access", () => {
	const r = new RuntimeReview();
	r.start("read-1", "read", { path: "a.ts" }, cwd, false);
	assert.match(r.guard("edit", { path: "a.ts" }, cwd, "edit-1") ?? "", /未读先改/);
	r.finish("read-1", true);
	assert.match(r.guard("edit", { path: "a.ts" }, cwd, "edit-2") ?? "", /未读先改/);
	execute(r, "read-2", "read", { path: "a.ts" });
	assert.equal(r.guard("edit", { path: "a.ts" }, cwd, "edit-3"), undefined);
});
test("read receipts are cwd-scoped and successful writes grant later editing", () => {
	const r = new RuntimeReview();
	execute(r, "write-1", "write", { path: "new.ts" }, false, true);
	assert.equal(r.guard("edit", { path: "new.ts" }, cwd, "e"), undefined);
	assert.match(r.guard("edit", { path: "new.ts" }, "/other/project", "e") ?? "", /未读先改/);
});
test("completion without a pinned check receipt is refused", () => {
	const r = armed();
	assert.match(r.guard("her_task_update", { status: "done" }, cwd, "done") ?? "", /refuses completion/);
	assert.match(r.guard("her_goal_complete", {}, cwd, "done") ?? "", /refuses completion/);
});
test("actual process failure is not a successful check; only an identical successful retry resolves it", () => {
	const input = { command: "fixture-process" };
	const r = armed({ checks: [{ name: "process", tool: "bash", input }] });
	const failure = spawnSync(process.execPath, ["-e", "process.exit(7)"], { timeout: 3000 });
	assert.equal(failure.status, 7);
	execute(r, "failed", "bash", input, failure.status !== 0, true);
	assert.equal(r.view().status, "blocked");
	const success = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 3000 });
	assert.equal(success.status, 0);
	execute(r, "retry", "bash", input, success.status !== 0, true);
	assert.equal(r.view().status, "verified");
});
test("wrong command, echo and changed options cannot satisfy the pinned check", () => {
	const r = armed();
	execute(r, "echo", "bash", { command: `echo ${checkInput.command}` }, false, true);
	execute(r, "options", "bash", { ...checkInput, timeout: 3 }, false, true);
	assert.equal(r.view().status, "needs-evidence");
});
test("a mutation after verification invalidates the prior pass", () => {
	const r = armed();
	execute(r, "check-1", "bash", checkInput, false, true);
	assert.equal(r.view().status, "verified");
	execute(r, "write", "write", { path: "a.ts", content: "changed" }, false, true);
	assert.equal(r.view().status, "needs-evidence");
	execute(r, "check-2", "bash", checkInput, false, true);
	assert.equal(r.view().status, "verified");
});
test("a check concurrent with a mutation cannot verify that mutation", () => {
	const r = armed();
	r.start("check", "bash", checkInput, cwd, true);
	r.start("write", "write", { path: "a.ts" }, cwd, true);
	r.finish("check", false);
	r.finish("write", false);
	assert.equal(r.view().status, "needs-evidence");
});
test("parallel checks compose, but pending sibling work blocks completion", () => {
	const input2 = { command: "node --test test/other.test.ts" };
	const r = armed({ checks: [...contract.checks, { name: "other", tool: "bash", input: input2 }] });
	r.start("c1", "bash", checkInput, cwd, true);
	r.start("c2", "bash", input2, cwd, true);
	r.finish("c1", false);
	assert.equal(r.view().status, "blocked");
	r.finish("c2", false);
	assert.equal(r.view().status, "verified");
});
test("nested completion waits until its codemode parent has ended", () => {
	const r = armed();
	r.start("cm", "codemode", { code: "fixture" }, cwd, true);
	execute(r, "cm/1", "bash", checkInput, false, true, "cm");
	r.start("cm/2", "her_goal_complete", {}, cwd, false, "cm");
	assert.match(r.guard("her_goal_complete", {}, cwd, "cm/2") ?? "", /refuses completion/);
	r.finish("cm/2", false);
	r.finish("cm", false);
	assert.equal(r.view().status, "verified");
	assert.equal(r.guard("her_goal_complete", {}, cwd, "standalone"), undefined);
});
test("nested failing checks cannot be hidden by successful codemode output", () => {
	const r = armed();
	r.start("cm", "codemode", { code: "fixture" }, cwd, true);
	execute(r, "cm/1", "bash", checkInput, true, true, "cm");
	r.finish("cm", false);
	assert.equal(r.view().status, "blocked");
	assert.deepEqual(r.view().failedCallIds, ["cm/1"]);
});
test("observer fault and observation overflow fail closed", () => {
	const r = armed();
	for (let i = 0; i < 129; i++) r.start(`p${i}`, "read", { path: `${i}` }, cwd, false);
	assert.equal(r.view().status, "blocked");
	assert.match(r.guard("write", { path: "x" }, cwd, "w") ?? "", /review failed/);
});
test("failed completion calls do not create a self-perpetuating failure", () => {
	const r = armed();
	execute(r, "done", "her_task_update", { status: "done" }, true);
	execute(r, "check", "bash", checkInput, false, true);
	assert.equal(r.view().status, "verified");
});
test("tool budget counts inner calls and permits reporting completion after the final passing call", () => {
	const r = armed({ maxToolCalls: 1 });
	r.start("c", "bash", checkInput, cwd, true);
	assert.equal(r.guard("bash", checkInput, cwd, "c"), undefined);
	r.finish("c", false);
	assert.match(r.guard("bash", { command: "anything" }, cwd, "next") ?? "", /budget/);
	assert.equal(r.guard("her_task_update", { status: "done" }, cwd, "done"), undefined);
});
test("continuations are opt-in, bounded, deduplicated and cancellable", () => {
	assert.equal(armed().settle(true).continue, false);
	const r = armed({ maxContinuations: 1 });
	assert.equal(r.settle(true).continue, true);
	assert.equal(r.settle(true).notify, false);
	execute(r, "read", "read", { path: "x" });
	assert.equal(r.settle(true).continue, false);
	assert.equal(armed({ maxContinuations: 2 }).settle(false).continue, false);
});
test("reload preserves a failed gate, restores successful reads and does not re-notify", () => {
	const r = armed();
	execute(r, "read", "read", { path: "x.ts" });
	execute(r, "check", "bash", checkInput, true, true);
	r.settle(true);
	const next = new RuntimeReview();
	next.restore(r.snapshot());
	assert.equal(next.view().status, "blocked");
	assert.equal(next.settle(true).notify, false);
	assert.equal(next.guard("edit", { path: "x.ts" }, cwd, "edit"), undefined);
});
test("interrupted checks are not restored as successful", () => {
	const r = armed();
	r.start("check", "bash", checkInput, cwd, true);
	const next = new RuntimeReview();
	next.restore(r.snapshot());
	assert.equal(next.view().status, "blocked");
	execute(next, "retry", "bash", checkInput, false, true);
	assert.equal(next.view().status, "verified");
});
test("corrupt snapshots fail closed instead of resetting to idle", () => {
	const r = new RuntimeReview();
	r.restore({ version: 2 });
	assert.equal(r.view().status, "blocked");
	assert.match(r.guard("her_goal_complete", {}, cwd, "done") ?? "", /review failed/);
});
test("snapshots contain hashes rather than raw commands or file contents", () => {
	const input = { command: "unique-private-command-fixture" };
	const r = armed({ checks: [{ name: "private", tool: "bash", input }] });
	r.start("check", "bash", input, cwd, true);
	assert.ok(!JSON.stringify(r.snapshot()).includes(input.command));
});

// Contract harness for the extension adapter; this is not the real Pi/QuickJS host.
type Event = Record<string, unknown>;
type Handler = (event: Event, ctx: HarnessContext) => unknown;
interface HarnessContext {
	cwd: string;
	hasUI: boolean;
	signal: AbortSignal;
	hasPendingMessages(): boolean;
	waitForIdle(): Promise<void>;
	sessionManager: { getBranch(): Event[] };
	ui: { setStatus(...args: unknown[]): void; notify(...args: unknown[]): void };
}
function harness() {
	const handlers = new Map<string, Handler[]>();
	const entries: Event[] = [];
	const messages: unknown[] = [];
	let failPersistence = false;
	let command: ((args: string, ctx: HarnessContext) => Promise<void>) | undefined;
	const abort = new AbortController();
	const ctx: HarnessContext = {
		cwd, hasUI: true, signal: abort.signal, hasPendingMessages: () => false,
		waitForIdle: async () => {}, sessionManager: { getBranch: () => entries },
		ui: { setStatus: () => {}, notify: () => {} },
	};
	const pi = {
		on: (event: string, fn: Handler) => { const list = handlers.get(event) ?? []; list.push(fn); handlers.set(event, list); },
		appendEntry: (customType: string, data: unknown) => {
			if (failPersistence) throw new Error("fixture persistence failure");
			entries.push({ type: "custom", customType, data: structuredClone(data) });
		},
		registerCommand: (_name: string, spec: { handler: typeof command }) => { command = spec.handler; },
		sendMessage: (message: unknown) => { messages.push(message); },
		events: { emit: (_name: string, data: unknown) => { messages.push(data); } },
	};
	registerRuntimeReview(pi as unknown as ExtensionAPI, (tool) => !["read", "her_goal_complete", "her_task_update"].includes(tool));
	const emit = async (name: string, event: Event): Promise<Event | undefined> => {
		let result: Event | undefined;
		for (const handler of handlers.get(name) ?? []) {
			const returned = await handler({ type: name, ...event }, ctx);
			if (returned && typeof returned === "object") result = returned as Event;
			if (result?.block) break;
		}
		return result;
	};
	return { ctx, emit, entries, messages, abort,
		failPersistence: () => { failPersistence = true; },
		command: async (text: string) => { assert.ok(command); await command(text, ctx); },
		call: async (id: string, tool: string, input: Event, error = false, parent?: string) => {
			await emit("tool_execution_start", { toolCallId: id, toolName: tool, args: input, parentToolCallId: parent });
			const gate = await emit("tool_call", { toolCallId: id, toolName: tool, input });
			await emit("tool_result", { toolCallId: id, toolName: tool, input, isError: error || Boolean(gate?.block) });
			await emit("tool_execution_end", { toolCallId: id, toolName: tool, isError: error || Boolean(gate?.block) });
			return gate;
		},
	};
}
test("adapter registers real lifecycle boundaries and blocks both direct and nested completion", async () => {
	const h = harness();
	await h.emit("session_start", {});
	await h.command(`begin ${JSON.stringify(contract)}`);
	assert.equal((await h.call("done", "her_goal_complete", {}))?.block, true);
	await h.call("c", "bash", checkInput, true);
	assert.equal((await h.call("cm/1", "her_task_update", { status: "done" }, false, "cm"))?.block, true);
	await h.call("retry", "bash", checkInput);
	assert.equal(await h.call("done2", "her_goal_complete", {}), undefined);
	assert.ok(h.entries.some((e) => e.customType === REVIEW_ENTRY));
});
test("adapter UI failure does not disable checks; persistence failure does", async () => {
	const h = harness();
	h.ctx.ui.setStatus = () => { throw new Error("fixture disconnected UI"); };
	await h.command(`begin ${JSON.stringify(contract)}`);
	await h.call("c", "bash", checkInput);
	assert.equal(await h.call("done", "her_goal_complete", {}), undefined);
	h.failPersistence();
	assert.equal((await h.call("next", "write", { path: "x" }))?.block, true);
});
test("adapter publishes structured headless results and never continues after cancellation", async () => {
	const h = harness();
	h.ctx.hasUI = false;
	await h.command(`begin ${JSON.stringify({ ...contract, maxContinuations: 1 })}`);
	h.abort.abort();
	const result = await h.emit("agent_before_settle", { entries: [], outcome: "aborted", context: { canContinue: true } });
	assert.notEqual(result?.continue, true);
	assert.ok(Array.isArray(result?.entries));
	const entry = (result.entries as Event[])[0];
	assert.equal((entry.details as Event).status, "needs-evidence");
});
test("adapter does not trust arguments rewritten after execution-start", async () => {
	const h = harness();
	await h.command(`begin ${JSON.stringify(contract)}`);
	await h.emit("tool_execution_start", { toolCallId: "c", toolName: "bash", args: checkInput });
	await h.emit("tool_result", { toolCallId: "c", toolName: "bash", input: { command: "echo fake" }, isError: false });
	await h.emit("tool_execution_end", { toolCallId: "c", toolName: "bash", isError: false });
	assert.equal((await h.call("done", "her_goal_complete", {}))?.block, true);
});
test("adapter restores only current-branch state and deduplicates settlement after reload", async () => {
	const h = harness();
	await h.command(`begin ${JSON.stringify(contract)}`);
	const first = await h.emit("agent_before_settle", { entries: [], outcome: "completed", context: { canContinue: true } });
	assert.ok(first);
	await h.emit("session_tree", {});
	assert.equal(await h.emit("agent_before_settle", { entries: [], outcome: "completed", context: { canContinue: true } }), undefined);
	h.entries.length = 0;
	await h.emit("session_switch", {});
	assert.equal(await h.call("done", "her_goal_complete", {}), undefined);
});

test("an older concurrent success cannot erase a later failure", () => {
	const r = armed();
	r.start("older", "bash", checkInput, cwd, true);
	r.start("newer", "bash", checkInput, cwd, true);
	r.finish("newer", true);
	r.finish("older", false);
	assert.equal(r.view().status, "blocked");
	execute(r, "causal-retry", "bash", checkInput, false, true);
	assert.equal(r.view().status, "verified");
});
test("malformed counters in snapshots fail closed", () => {
	const r = armed();
	const snapshot = r.snapshot() as unknown as Record<string, unknown>;
	delete snapshot.calls;
	r.restore(snapshot);
	assert.equal(r.view().status, "blocked");
	assert.ok(r.view().fault);
});

test("completion prepared before a later sibling still cannot finalize a parallel batch", async () => {
	const h = harness();
	await h.command(`begin ${JSON.stringify(contract)}`);
	await h.call("c", "bash", checkInput);
	await h.emit("message_end", { message: { role: "assistant", content: [
		{ type: "toolCall", id: "done", name: "her_goal_complete", arguments: {} },
		{ type: "toolCall", id: "later-write", name: "write", arguments: { path: "x" } },
	] } });
	assert.equal((await h.call("done", "her_goal_complete", {}))?.block, true);
});
test("settlement preserves entries proposed by earlier extensions", async () => {
	const h = harness();
	await h.command(`begin ${JSON.stringify(contract)}`);
	const prior = { type: "custom", customType: "other-extension", data: { keep: true } };
	const result = await h.emit("agent_before_settle", { entries: [prior], outcome: "completed", context: { canContinue: true } });
	assert.deepEqual((result?.entries as unknown[])[0], prior);
});

test("begin tells the model which exact checks the operator pinned", async () => {
	const h = harness();
	await h.command(`begin ${JSON.stringify(contract)}`);
	assert.ok(h.messages.some((m) => typeof m === "object" && m !== null && "content" in m &&
		typeof m.content === "string" && m.content.includes(checkInput.command)));
});
