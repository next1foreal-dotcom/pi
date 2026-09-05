import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { Thread } from "./feed.ts";
import { allThreads } from "./store.ts";

/**
 * Unresolved threads she has not spoken on.
 *
 * Delivery does not consume these. A read does not either. Only a reply or a
 * resolve is an action, and only an action clears the reminder.
 */
export function pendingForHer(repoRoot?: string): Thread[] {
	try {
		return allThreads(repoRoot).filter(
			// Waiting on her = open, and the last thing said on it was not hers.
			// "She has not replied yet" was too weak: once she answered, nothing he
			// said afterwards could reach her — reopening the thread, or objecting
			// again under it, was silent.
			(thread) => !thread.resolved && thread.lastSpoke !== "samantha",
		);
	} catch {
		return [];
	}
}

function formatNag(pending: Thread[]): string {
	const lines = pending.map((thread) => {
		const where = thread.screenId ?? "the canvas";
		return `- ${thread.id} on ${where}: ${thread.text}`;
	});
	return [
		`他在画布上还有 ${pending.length} 条没处理的意见:`,
		...lines,
		"先处理这些,再继续你原来的计划。回复用 design_lab_reply,真改完了用 design_lab_resolve。",
	].join("\n");
}

function decorateResult<T>(result: T, repoRoot?: string): T {
	try {
		const pending = pendingForHer(repoRoot);
		if (pending.length === 0) return result;
		if (!result || typeof result !== "object") return result;
		const current = result as { content?: unknown };
		const nag = { type: "text" as const, text: formatNag(pending) };
		const content = Array.isArray(current.content) ? [...current.content, nag] : [nag];
		return { ...current, content } as T;
	} catch {
		return result;
	}
}

/**
 * Wrap `registerTool` so every execute result can carry unanswered canvas notes.
 * The original result is returned unchanged when there is nothing to say, and a
 * throwing execute still throws.
 */
export function withCanvasNag(pi: ExtensionAPI, repoRoot?: string): ExtensionAPI {
	return new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
			return (definition: ToolDefinition) => {
				const original = definition.execute;
				return target.registerTool({
					...definition,
					async execute(toolCallId, params, signal, onUpdate, ctx) {
						const result = await original(toolCallId, params, signal, onUpdate, ctx);
						return decorateResult(result, repoRoot);
					},
				});
			};
		},
	});
}
