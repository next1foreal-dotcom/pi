import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { acceptProposal, declineProposal, proposalStates, type RuleProposal } from "./decisions.ts";
import type { Thread } from "./feed.ts";
import { allThreads } from "./store.ts";

export type Proposal = RuleProposal;
export { acceptProposal, declineProposal };

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

/** Pending taste-rule proposals, oldest first. */
export function pendingProposals(repoRoot?: string): Proposal[] {
	try {
		return proposalStates(repoRoot).filter((row) => row.status === "pending");
	} catch {
		return [];
	}
}

/**
 * Hand her the record and let her read it.
 *
 * This deliberately does NOT state a rule. Nothing on this side is in a
 * position to generalise a taste out of what he said, and a machine-made
 * summary of his judgement is worse than his judgement — the earlier version
 * joined his complaints with " | ", called it a rule, and looked finished
 * while producing nothing anyone could act on. She is the model, and she is
 * the one reading this; naming the pattern is her job, said in her own words,
 * in front of him, where he can agree or refuse.
 */
function formatProposalNag(proposal: Proposal): string {
	const where = proposal.screenId ?? "the canvas";
	return [
		`他在 ${where} 上提过 ${proposal.items.length} 次同一带的意见,你都改了:`,
		...proposal.items.map((item) => `  他:${item.his}  →  你:${item.hers}`),
		"看看这几条背后是不是同一条口味。是的话,下次跟他聊的时候用你自己的话说出来,让他确认。",
		"别自己当规矩用,也别写进任何 skill 文件——没经他点头的口味不算数。",
	].join("\n");
}

function decorateResult<T>(result: T, repoRoot?: string): T {
	try {
		if (!result || typeof result !== "object") return result;
		const current = result as { content?: unknown };
		const extras: Array<{ type: "text"; text: string }> = [];
		const pending = pendingForHer(repoRoot);
		if (pending.length > 0) extras.push({ type: "text", text: formatNag(pending) });
		const oldest = pendingProposals(repoRoot)[0];
		if (oldest) extras.push({ type: "text", text: formatProposalNag(oldest) });
		if (extras.length === 0) return result;
		const content = Array.isArray(current.content) ? [...current.content, ...extras] : extras;
		return { ...current, content } as T;
	} catch {
		return result;
	}
}

/**
 * Wrap `registerTool` so every execute result can carry unanswered canvas notes
 * and at most one pending taste-rule proposal, as separate text parts.
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
