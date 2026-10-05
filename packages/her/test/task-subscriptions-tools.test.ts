import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPendingRecord, saveBgTask } from "../src/her-core/bg-task-record.ts";
import { evaluate, policyEnvelope } from "../src/lib/cedar.ts";
import { resolveGovernedTool } from "../src/lib/governed-tools.ts";
import { TaskSubscriptionRuntime } from "../src/task-subscriptions/runtime.ts";
import { registerTaskSubscriptionTools } from "../src/task-subscriptions/tools.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const root = await mkdtemp(join(tmpdir(), "her-watch-tools-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const task = createPendingRecord({ objective: "demo", worker: "test", command: ["test"], ownerSessionId: "owner" });
	await saveBgTask(root, task);
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		on() {},
		registerMessageRenderer() {},
	} as unknown as ExtensionAPI;
	const runtime = new TaskSubscriptionRuntime(pi, root, { allowed: () => true });
	registerTaskSubscriptionTools(pi, root, runtime);
	const ctx = { mode: "tui", sessionManager: { getSessionId: () => "owner" } } as unknown as ExtensionContext;
	const call = (name: string, params: Record<string, unknown>, context = ctx) =>
		tools.get(name)!.execute("call", params, undefined, undefined, context);
	return { root, task, tools, call, ctx };
}

test("registered tools create, list, pause, resume and cancel the same durable subscription", async (t) => {
	const f = await fixture(t);
	await f.call("her_task_watch", { taskId: f.task.id, instruction: "盯着任务，完成时通知我" });
	const listed = await f.call("her_task_watch_list", {});
	const rows = JSON.parse((listed.content[0] as { text: string }).text);
	for (const [action, state] of [
		["pause", "paused"],
		["resume", "active"],
		["cancel", "cancelled"],
	]) {
		const result = await f.call("her_task_watch_update", { id: rows[0].id, action });
		assert.equal((result.details as { subscription: { state: string } }).subscription.state, state);
	}
});

test("one-shot entry refuses subscription creation and result requires active lease", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		f.call("her_task_watch", { taskId: f.task.id, instruction: "watch" }, {
			...f.ctx,
			mode: "rpc",
		} as ExtensionContext),
		/resident/,
	);
	await assert.rejects(f.call("her_task_watch_result", { summary: "fake", evidence: ["fake"] }), /active/);
});

test("management tools require default named permission and stay denied in heartbeat and plan", () => {
	for (const name of ["her_task_watch", "her_task_watch_update", "her_task_watch_list", "her_task_watch_result"]) {
		const tool = resolveGovernedTool(name);
		assert.equal(tool.registered, true);
		for (const profile of ["default", "heartbeat", "plan"] as const) {
			const result = evaluate({
				principal: { type: "Agent", id: "samantha" },
				action: { type: "Action", id: "CallTool" },
				resource: { type: "Tool", id: name },
				context: {},
				entities: [
					{ uid: { type: "Agent", id: "samantha" }, attrs: {}, parents: [] },
					{ uid: { type: "Tool", id: name }, attrs: { name, destructive: tool.destructive }, parents: [] },
				],
				...policyEnvelope(profile),
			});
			assert.equal(
				result.decision,
				profile === "default" || !tool.destructive ? "allow" : "deny",
				`${name}/${profile}`,
			);
		}
	}
});
