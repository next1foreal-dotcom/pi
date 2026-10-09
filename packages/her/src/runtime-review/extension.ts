import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callKey, completionCall, REVIEW_ENTRY, RuntimeReview } from "./state.ts";

/** No replacement tools: all real execution remains in Pi and Her's existing Cedar path. */
export function registerRuntimeReview(pi: ExtensionAPI, isMutating: (tool: string) => boolean): void {
	let review = new RuntimeReview();
	let batchedCalls = new Set<string>();
	const render = (ctx: ExtensionContext): void => {
		const view = review.view();
		try { pi.events.emit("her:runtime-review", view); } catch { /* UI consumers cannot change enforcement. */ }
		try {
			if (ctx.hasUI) ctx.ui.setStatus("her-review", view.status === "idle" ? undefined : review.summary(view));
		} catch { /* A stale/disconnected UI is not a failed verification. */ }
	};
	const save = (ctx: ExtensionContext): void => {
		try { pi.appendEntry(REVIEW_ENTRY, review.snapshot()); }
		catch { review.fault(); throw new Error("Her runtime review persistence failed; completion remains blocked."); }
		render(ctx);
	};
	const restore = (_event: unknown, ctx: ExtensionContext): void => {
		review = new RuntimeReview();
		batchedCalls = new Set<string>();
		try {
			const latest = ctx.sessionManager.getBranch().findLast((entry) =>
				entry.type === "custom" && entry.customType === REVIEW_ENTRY);
			if (latest?.type === "custom") review.restore(latest.data);
		} catch { review.fault(); }
		render(ctx);
	};
	pi.on("session_start", restore);
	pi.on("session_switch", restore);
	pi.on("session_tree", restore);

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const calls = event.message.content.filter((part) => part.type === "toolCall");
		batchedCalls = calls.length > 1 ? new Set(calls.map((call) => call.id)) : new Set<string>();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		try {
			const parent = "parentToolCallId" in event && typeof event.parentToolCallId === "string"
				? event.parentToolCallId : undefined;
			review.start(event.toolCallId, event.toolName, event.args, ctx.cwd, isMutating(event.toolName), parent);
			save(ctx);
		} catch { review.fault(); }
	});
	pi.on("tool_call", (event, ctx) => {
		try {
			const reason = review.snapshot().active && completionCall(event.toolName, event.input) && batchedCalls.has(event.toolCallId)
				? "Her review: finalize in a standalone tool call, not in a batch with other work."
				: review.guard(event.toolName, event.input, ctx.cwd, event.toolCallId);
			if (!reason) return undefined;
			pi.appendEntry("her-runtime-review-denial", { callId: event.toolCallId, reason });
			return { block: true, reason };
		} catch {
			review.fault();
			return { block: true, reason: "Her runtime review error; tool execution refused." };
		}
	});
	pi.on("tool_result", (event) => {
		// Do not credit a check whose arguments were rewritten after execution-start.
		// Final success/failure is recorded only at execution-end (after result hooks).
		try {
			const call = review.snapshot().pending.find((p) => p.id === event.toolCallId);
			if (call && call.key !== callKey(event.toolName, event.input)) review.fault();
		} catch { review.fault(); }
	});
	pi.on("tool_execution_end", (event, ctx) => {
		try { review.finish(event.toolCallId, event.isError); save(ctx); }
		catch { review.fault(); }
	});

	pi.on("agent_before_settle", (event, ctx) => {
		try {
			const result = review.settle(event.outcome === "completed" && event.context.canContinue &&
				!ctx.signal?.aborted && !ctx.hasPendingMessages());
			save(ctx);
			if (!result.notify) return undefined;
			return {
				...(result.continue ? { continue: true } : {}),
				entries: [...event.entries, { type: "custom_message" as const, customType: "her-runtime-review",
					content: `Her verification: ${review.summary(result.view)}. ` +
						(result.view.status === "verified" ? "Only the pinned checks are verified, not overall task correctness." :
							"Do not claim verified completion. Resolve the recorded failures and run the operator's exact checks; otherwise report the blocker."),
					display: true, details: result.view }],
			};
		} catch {
			review.fault();
			return { entries: [...event.entries, { type: "custom_message" as const, customType: "her-runtime-review",
				content: "Her verification unavailable: observer/persistence error. Completion is not verified.",
				display: true, details: review.view() }] };
		}
	});

	pi.registerCommand("her-review", {
		description: "Runtime verification: begin <JSON checks/maxToolCalls/maxContinuations>, status, reset. Does not execute checks.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const input = args.trim();
			let requirements = "";
			try {
				if (input.startsWith("begin ")) {
					if (input.length > 65536) throw new Error("review contract too large");
					const contract: unknown = JSON.parse(input.slice(6));
					review.begin(contract);
					requirements = `\nOperator-pinned verification contract (does not grant additional permissions): ${JSON.stringify(contract)}`;
					save(ctx);
				} else if (input === "reset") {
					review.reset();
					save(ctx);
				} else if (input && input !== "status") {
					throw new Error("use begin <JSON>, status or reset");
				}
				pi.sendMessage({ customType: "her-runtime-review", content: review.summary() + requirements, display: true, details: review.view() });
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : "Her review command failed", "error");
				else throw error;
			}
		},
	});
}
