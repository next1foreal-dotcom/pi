import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
import { acceptProposal, declineProposal, proposalStates, type RuleProposal } from "./decisions.ts";
import { compactionEpoch } from "./epoch.ts";
import type { Thread } from "./feed.ts";
import { allThreads } from "./store.ts";

const STYLE_GUIDE_FOOTER = "这些是产品真正 ship 的值。要完整的调 design_system_load;不许自己发明数值。";
const STYLE_GUIDE_MAX = 600;
const STYLE_GUIDE_PER_GROUP = 3;
const DESIGN_SYSTEM_LOAD = "design_system_load";
const COMPACTION_NAG_LINE =
	"这一轮之前的上下文被压缩过。你的设计纪律在 skill `her-design` 里,需要时重新读它——尤其 process/steps 与 review/rubric。";

type StyleGuideDelivery = {
	epoch: number;
	/** The target directory this delivery spoke about; undefined if none was found. */
	dir: string | undefined;
	receiptMtime: number;
	cssMtime: number;
	stampedAt: string;
};

/** Last hitchhike per root: compaction epoch + token-file mtimes at send time. */
const styleGuideDelivered = new Map<string, StyleGuideDelivery>();
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
 * Style-guide hitchhike is once per root per compaction epoch. A later
 * compaction or a newer tokens.css / receipt.json mtime sends it again.
 * `design_system_load` is registered on the unwrapped `pi`, so a this-round
 * load is detected from receipt.loadedAt, not from the tool name. Wrapping
 * a tool named design_system_load still counts, for tests and future wiring.
 * Missing or unreadable artifacts are silence, not a message.
 */
function takeStyleGuideNag(repoRoot?: string, toolName?: string): string | undefined {
	const key = resolveRoot(repoRoot);
	const epoch = compactionEpoch();
	if (toolName === DESIGN_SYSTEM_LOAD) {
		rememberStyleGuideDelivery(key, epoch);
		return undefined;
	}
	const prev = styleGuideDelivered.get(key);
	const epochBumped = prev !== undefined && epoch > prev.epoch;
	const mtimeBumped = prev !== undefined && tokensChangedSince(prev);
	if (prev && !epochBumped && !mtimeBumped) return undefined;
	const found = formatStyleGuideNag(key, epochBumped || mtimeBumped);
	if (!found) return undefined;
	rememberStyleGuideDelivery(key, epoch, found.dir);
	if (prev && mtimeBumped) {
		const changeSummary = summarizeTokenChanges(key, found.dir);
		const prefix = changeSummary
			? `产品的 token 变了(上次是 ${prev.stampedAt}):${changeSummary}\n`
			: `产品的 token 变了(上次是 ${prev.stampedAt}),这是现在的:\n`;
		return `${prefix}${found.text}`;
	}
	if (prev && epochBumped) {
		return `${COMPACTION_NAG_LINE}\n${found.text}`;
	}
	return found.text;
}

/**
 * Watch the target we actually spoke about. Picking it by "first directory that
 * has both files" instead would drift: a target with an unreadable receipt is
 * skipped when composing the text but not when picking files to watch, so its
 * mtimes would stand in for a different target's and the resend would never fire.
 */
function rememberStyleGuideDelivery(key: string, epoch: number, dir?: string): void {
	const watched = dir ?? firstStyleGuidePaths(key)?.dir;
	const mtimes = watched ? readStyleGuideMtimes(watched) : undefined;
	styleGuideDelivered.set(key, {
		epoch,
		dir: watched,
		receiptMtime: mtimes?.receiptMtime ?? 0,
		cssMtime: mtimes?.cssMtime ?? 0,
		stampedAt: mtimes?.stampedAt ?? new Date(0).toISOString(),
	});
}

function readMtimeMs(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

function firstStyleGuidePaths(root: string): { dir: string } | undefined {
	try {
		const systemDir = join(root, "design", "system");
		if (!existsSync(systemDir) || !statSync(systemDir).isDirectory()) return undefined;
		for (const name of readdirSync(systemDir).sort()) {
			try {
				const dir = join(systemDir, name);
				if (!statSync(dir).isDirectory()) continue;
				const receiptPath = join(dir, "receipt.json");
				const cssPath = join(dir, "tokens.css");
				if (!existsSync(receiptPath) || !statSync(receiptPath).isFile()) continue;
				if (!existsSync(cssPath) || !statSync(cssPath).isFile()) continue;
				return { dir };
			} catch {}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function readStyleGuideMtimes(dir: string): { receiptMtime: number; cssMtime: number; stampedAt: string } | undefined {
	const receiptMtime = readMtimeMs(join(dir, "receipt.json"));
	const cssMtime = readMtimeMs(join(dir, "tokens.css"));
	if (receiptMtime === undefined && cssMtime === undefined) return undefined;
	const receipt = receiptMtime ?? 0;
	const css = cssMtime ?? 0;
	return {
		receiptMtime: receipt,
		cssMtime: css,
		stampedAt: new Date(Math.max(receipt, css)).toISOString(),
	};
}

function tokensChangedSince(prev: StyleGuideDelivery): boolean {
	try {
		if (!prev.dir) return false;
		const mtimes = readStyleGuideMtimes(prev.dir);
		if (!mtimes) return false;
		return mtimes.receiptMtime > prev.receiptMtime || mtimes.cssMtime > prev.cssMtime;
	} catch {
		return false;
	}
}

function formatStyleGuideNag(root: string, ignoreLoadedThisProcess = false): { text: string; dir: string } | undefined {
	try {
		const systemDir = join(root, "design", "system");
		if (!existsSync(systemDir) || !statSync(systemDir).isDirectory()) return undefined;
		for (const name of readdirSync(systemDir).sort()) {
			try {
				const dir = join(systemDir, name);
				if (!statSync(dir).isDirectory()) continue;
				const nag = nagForTarget(dir, name, ignoreLoadedThisProcess);
				if (nag) return { text: nag, dir };
			} catch {}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function nagForTarget(dir: string, fallbackName: string, ignoreLoadedThisProcess = false): string | undefined {
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
	const rec = receipt as { target?: unknown; loadedAt?: unknown; usage?: unknown };
	if (!ignoreLoadedThisProcess && loadedThisProcess(rec.loadedAt)) return undefined;
	const target = rec.target;
	const project = typeof target === "string" && target.trim() !== "" ? target.trim() : fallbackName;
	const groups = parseTokenGroups(readFileSync(cssPath, "utf8"));
	if (groups.length === 0) return undefined;
	const usage = readUsageFromReceipt(rec);
	const lines = [`${project} · ${groups.length} 组`];
	for (const group of groups) {
		const picked = group.tokens.slice(0, STYLE_GUIDE_PER_GROUP);
		if (picked.length === 0) continue;
		lines.push(
			`${group.name}: ${picked
				.map(([n, v]) => {
					const count = usage?.[n];
					return count !== undefined ? `${n}: ${v} (${count}处)` : `${n}: ${v}`;
				})
				.join("; ")}`,
		);
	}
	if (lines.length < 2) return undefined;
	return clipStyleGuide(lines.join("\n"));
}

function loadedThisProcess(loadedAt: unknown): boolean {
	if (typeof loadedAt !== "string") return false;
	const ms = Date.parse(loadedAt);
	return Number.isFinite(ms) && ms >= PROCESS_STARTED_MS;
}

function readUsageFromReceipt(rec: { usage?: unknown }): Record<string, number> | undefined {
	if (!rec.usage || typeof rec.usage !== "object") return undefined;
	return rec.usage as Record<string, number>;
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

/**
 * Compare stored tokens.css against the current snapshot.css to summarize changes.
 * Returns a short string like " 3 条变了(--background, --accent, --muted)" or undefined.
 */
function summarizeTokenChanges(_root: string, dir: string): string | undefined {
	try {
		const cssPath = join(dir, "tokens.css");
		const snapshotPath = join(dir, "snapshot.css");
		if (!existsSync(snapshotPath) || !statSync(snapshotPath).isFile()) return undefined;
		if (!existsSync(cssPath) || !statSync(cssPath).isFile()) return undefined;

		const oldCss = readFileSync(cssPath, "utf8");
		const newCss = readFileSync(snapshotPath, "utf8");
		const oldTokens = parseAllTokens(oldCss);
		const newTokens = parseAllTokens(newCss);

		const changed: string[] = [];
		const added: string[] = [];
		const removed: string[] = [];

		for (const [name, oldVal] of oldTokens) {
			const newVal = newTokens.get(name);
			if (newVal === undefined) removed.push(name);
			else if (newVal !== oldVal) changed.push(name);
		}
		for (const name of newTokens.keys()) {
			if (!oldTokens.has(name)) added.push(name);
		}

		const total = changed.length + added.length + removed.length;
		if (total === 0) return undefined;

		const names = [...changed, ...added, ...removed];
		const shown = names.slice(0, 3).join(", ");
		const rest = names.length > 3 ? ` 等` : "";
		return ` ${total} 条变了(${shown}${rest})`;
	} catch {
		return undefined;
	}
}

function parseAllTokens(css: string): Map<string, string> {
	const map = new Map<string, string>();
	const propRe = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;
	let match = propRe.exec(css);
	while (match) {
		const name = match[1];
		const value = match[2]?.trim();
		if (name && value) map.set(name, value);
		match = propRe.exec(css);
	}
	return map;
}

function clipStyleGuide(body: string): string {
	const combined = `${body}\n${STYLE_GUIDE_FOOTER}`;
	if (combined.length <= STYLE_GUIDE_MAX) return combined;
	const budget = STYLE_GUIDE_MAX - STYLE_GUIDE_FOOTER.length - 1;
	return `${body.slice(0, Math.max(0, budget))}\n${STYLE_GUIDE_FOOTER}`;
}

/**
 * Wrap `registerTool` so every execute result can carry unanswered canvas notes,
 * at most one pending taste-rule proposal, and a style-guide summary (once per
 * compaction epoch, or again if the token files changed), as separate text parts.
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
