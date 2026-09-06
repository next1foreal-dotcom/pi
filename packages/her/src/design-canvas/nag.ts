import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
import { acceptProposal, declineProposal, proposalStates, type RuleProposal } from "./decisions.ts";
import type { Thread } from "./feed.ts";
import { allThreads } from "./store.ts";

const STYLE_GUIDE_FOOTER = "这些是产品真正 ship 的值。要完整的调 design_system_load;不许自己发明数值。";
const STYLE_GUIDE_MAX = 600;
const STYLE_GUIDE_PER_GROUP = 3;
const DESIGN_SYSTEM_LOAD = "design_system_load";

/** Roots that already got a style-guide ride this process. Delivery is once. */
const styleGuideDelivered = new Set<string>();
const PROCESS_STARTED_MS = Date.now();

function resolveRoot(repoRoot?: string): string {
	return repoRoot ?? SAMANTHA_REPO_ROOT;
}

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

function decorateResult<T>(result: T, repoRoot?: string, toolName?: string): T {
	try {
		if (!result || typeof result !== "object") return result;
		const current = result as { content?: unknown };
		const extras: Array<{ type: "text"; text: string }> = [];
		const pending = pendingForHer(repoRoot);
		if (pending.length > 0) extras.push({ type: "text", text: formatNag(pending) });
		const oldest = pendingProposals(repoRoot)[0];
		if (oldest) extras.push({ type: "text", text: formatProposalNag(oldest) });
		const style = takeStyleGuideNag(repoRoot, toolName);
		if (style) extras.push({ type: "text", text: style });
		if (extras.length === 0) return result;
		const content = Array.isArray(current.content) ? [...current.content, ...extras] : extras;
		return { ...current, content } as T;
	} catch {
		return result;
	}
}

/**
 * At most one style-guide summary per process per root.
 * `design_system_load` is registered on the unwrapped `pi`, so a this-round
 * load is detected from receipt.loadedAt, not from the tool name. Wrapping
 * a tool named design_system_load still counts, for tests and future wiring.
 * Missing or unreadable artifacts are silence, not a message.
 */
function takeStyleGuideNag(repoRoot?: string, toolName?: string): string | undefined {
	const key = resolveRoot(repoRoot);
	if (toolName === DESIGN_SYSTEM_LOAD) {
		styleGuideDelivered.add(key);
		return undefined;
	}
	if (styleGuideDelivered.has(key)) return undefined;
	const text = formatStyleGuideNag(key);
	if (!text) return undefined;
	styleGuideDelivered.add(key);
	return text;
}

function formatStyleGuideNag(root: string): string | undefined {
	try {
		const systemDir = join(root, "design", "system");
		if (!existsSync(systemDir) || !statSync(systemDir).isDirectory()) return undefined;
		for (const name of readdirSync(systemDir).sort()) {
			try {
				const dir = join(systemDir, name);
				if (!statSync(dir).isDirectory()) continue;
				const nag = nagForTarget(dir, name);
				if (nag) return nag;
			} catch {}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function nagForTarget(dir: string, fallbackName: string): string | undefined {
	const receiptPath = join(dir, "receipt.json");
	const cssPath = join(dir, "tokens.css");
	if (!existsSync(receiptPath) || !statSync(receiptPath).isFile()) return undefined;
	if (!existsSync(cssPath) || !statSync(cssPath).isFile()) return undefined;
	let receipt: unknown;
	try {
		receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
	} catch {
		return undefined;
	}
	if (!receipt || typeof receipt !== "object") return undefined;
	const rec = receipt as { target?: unknown; loadedAt?: unknown };
	if (loadedThisProcess(rec.loadedAt)) return undefined;
	const target = rec.target;
	const project = typeof target === "string" && target.trim() !== "" ? target.trim() : fallbackName;
	const groups = parseTokenGroups(readFileSync(cssPath, "utf8"));
	if (groups.length === 0) return undefined;
	const lines = [`${project} · ${groups.length} 组`];
	for (const group of groups) {
		const picked = group.tokens.slice(0, STYLE_GUIDE_PER_GROUP);
		if (picked.length === 0) continue;
		lines.push(`${group.name}: ${picked.map(([n, v]) => `${n}: ${v}`).join("; ")}`);
	}
	if (lines.length < 2) return undefined;
	return clipStyleGuide(lines.join("\n"));
}

function loadedThisProcess(loadedAt: unknown): boolean {
	if (typeof loadedAt !== "string") return false;
	const ms = Date.parse(loadedAt);
	return Number.isFinite(ms) && ms >= PROCESS_STARTED_MS;
}

function parseTokenGroups(css: string): Array<{ name: string; tokens: Array<[string, string]> }> {
	const groups: Array<{ name: string; tokens: Array<[string, string]> }> = [];
	const blockRe = /(:root|\.dark)\s*\{([^}]*)\}/g;
	for (;;) {
		const match = blockRe.exec(css);
		if (!match) break;
		const selector = match[1];
		const body = match[2] ?? "";
		const tokens: Array<[string, string]> = [];
		const propRe = /(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g;
		for (;;) {
			const prop = propRe.exec(body);
			if (!prop) break;
			const tokenName = prop[1];
			const tokenValue = prop[2]?.trim();
			if (tokenName && tokenValue) tokens.push([tokenName, tokenValue]);
		}
		if (tokens.length === 0 || !selector) continue;
		const name = selector === ":root" ? "light" : selector === ".dark" ? "dark" : selector;
		groups.push({ name, tokens });
	}
	return groups;
}

function clipStyleGuide(body: string): string {
	const combined = `${body}\n${STYLE_GUIDE_FOOTER}`;
	if (combined.length <= STYLE_GUIDE_MAX) return combined;
	const budget = STYLE_GUIDE_MAX - STYLE_GUIDE_FOOTER.length - 1;
	return `${body.slice(0, Math.max(0, budget))}\n${STYLE_GUIDE_FOOTER}`;
}

/**
 * Wrap `registerTool` so every execute result can carry unanswered canvas notes,
 * at most one pending taste-rule proposal, and a one-shot style-guide summary,
 * as separate text parts.
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
						return decorateResult(result, repoRoot, definition.name);
					},
				});
			};
		},
	});
}
