import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskSubscriptionRuntime } from "./runtime.ts";
import { createTaskSubscription, listTaskSubscriptions, updateTaskSubscription } from "./store.ts";

export function registerTaskSubscriptionTools(pi: ExtensionAPI, root: string, runtime: TaskSubscriptionRuntime): void {
	pi.registerTool({
		name: "her_task_watch",
		label: "Watch Task",
		description:
			"When the user explicitly asks to monitor a running background task, persist their exact request and report its terminal outcome. Resident TUI only. Read-only analysis/reporting; never automatically spawn fixes. One watch per task; manage it with her_task_watch_update.",
		parameters: Type.Object({
			taskId: Type.String(),
			instruction: Type.String({ description: "Exact user monitoring request; preserve wording" }),
			expiresAt: Type.Optional(
				Type.String({ description: "Optional ISO expiry; omit to watch until terminal outcome" }),
			),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			runtime.assertCanManage(ctx);
			const row = await createTaskSubscription(root, {
				...params,
				ownerSessionId: ctx.sessionManager.getSessionId(),
			});
			return {
				content: [
					{
						type: "text",
						text: `已订阅 ${row.taskId}，状态：${row.state}。只读分析并报告终态；需保持或重新打开本 TUI 会话。`,
					},
				],
				details: { subscription: row },
			};
		},
	});
	pi.registerTool({
		name: "her_task_watch_list",
		label: "Task Watches",
		description:
			"List this session's durable task subscriptions, terminal events, processing state, blockers, and saved reports. Listing never starts a task or acknowledges delivery.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			const rows = await listTaskSubscriptions(root, ctx.sessionManager.getSessionId());
			return { content: [{ type: "text", text: JSON.stringify(rows) }], details: { subscriptions: rows } };
		},
	});
	pi.registerTool({
		name: "her_task_watch_update",
		label: "Manage Task Watch",
		description:
			"Pause, resume or cancel this session's task subscription at the user's request. Pause preserves events; cancel invalidates in-flight handling. Resuming explicitly resets exhausted handling attempts. Cancellation does not stop the underlying background task.",
		parameters: Type.Object({
			id: Type.String(),
			action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("cancel")]),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			runtime.assertCanManage(ctx);
			const row = await updateTaskSubscription(root, params.id, ctx.sessionManager.getSessionId(), params.action);
			return { content: [{ type: "text", text: `订阅 ${row.id}：${row.state}` }], details: { subscription: row } };
		},
	});
	pi.registerTool({
		name: "her_task_watch_result",
		label: "Save Task Watch Result",
		description:
			"After reading the watched task's actual output, save its report and evidence in the active subscription wake. Explain unverified claims. This saves a result receipt, not independent acceptance; unavailable outside the active fenced lease. The report is displayed separately, so do not repeat it in the final response.",
		parameters: Type.Object({
			summary: Type.String(),
			evidence: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const row = await runtime.complete(ctx, params.summary, params.evidence);
			return {
				content: [{ type: "text", text: "报告已保存，将单独展示。" }],
				details: { subscriptionId: row.id, eventId: row.event?.id, report: row.delivery.result },
			};
		},
	});
}
