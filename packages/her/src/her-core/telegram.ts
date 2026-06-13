import { join } from "node:path";
import { StorePaths } from "./paths.ts";
import { frontmatter, writeText } from "./store.ts";

export interface TelegramUser {
	first_name?: string;
	id?: number | string;
	username?: string;
}

export interface TelegramMessage {
	chat?: { id?: number | string };
	date?: number;
	from?: TelegramUser;
	message_id?: number;
	text?: string;
}

export interface TelegramUpdate {
	message?: TelegramMessage;
	update_id?: number;
}

export interface QueueTelegramInboundOptions {
	allowedChatId: string;
	now?: string;
	update: TelegramUpdate;
}

export interface TelegramQueueResult {
	path?: string;
	reason?: string;
	status: "queued" | "ignored" | "rejected";
	updateId?: number;
}

export interface AttentionItem {
	asked?: boolean;
	created: string;
	id: string;
	kind?: "completion" | "discovery" | "fyi";
	recentlyRejectedSimilar?: boolean;
	tags?: string[];
	title: string;
}

export interface ScoredAttentionItem extends AttentionItem {
	score: number;
	urgent: boolean;
}

export interface AttentionDigest {
	daily: ScoredAttentionItem[];
	dailyLimit: number;
	urgent: ScoredAttentionItem[];
}

export interface AttentionDigestOptions {
	dailyLimit?: number;
	now?: string;
	replyRate?: number;
}

const urgentSignals = ["urgent", "blocker", "blocked", "tier2", "guardrail", "circuit"];

export async function queueTelegramInbound(
	root: string,
	opts: QueueTelegramInboundOptions,
): Promise<TelegramQueueResult> {
	const message = opts.update.message;
	if (!message) return { status: "ignored", reason: "no message", updateId: opts.update.update_id };
	const chatId = message.chat?.id === undefined ? undefined : String(message.chat.id);
	if (chatId !== opts.allowedChatId) {
		return { status: "rejected", reason: "chat id is not allowlisted", updateId: opts.update.update_id };
	}
	const text = message.text?.trim();
	if (!text) return { status: "ignored", reason: "message has no text", updateId: opts.update.update_id };
	const now = opts.now ?? new Date().toISOString();
	const updateId = opts.update.update_id ?? Date.now();
	const paths = new StorePaths(root);
	const fileName = `${safeTimestamp(now)}-telegram-${updateId}.md`;
	const path = `tasks/inbox/${fileName}`;
	await writeText(
		join(paths.inboxTasks, fileName),
		[
			frontmatter({
				type: "her_telegram_inbox",
				source: "telegram",
				status: "queued",
				created: now,
				update_id: updateId,
				message_id: message.message_id ?? null,
				chat_id: chatId,
				from_id: message.from?.id === undefined ? null : String(message.from.id),
				from_username: message.from?.username ?? null,
			}).trimEnd(),
			"",
			"# Telegram Inbox Item",
			"",
			"Inbound Telegram message (queued, not executed).",
			"",
			"## Text",
			"",
			text,
			"",
		].join("\n"),
	);
	return { status: "queued", path, updateId };
}

export function selectAttentionDigest(items: AttentionItem[], opts: AttentionDigestOptions = {}): AttentionDigest {
	const dailyLimit = opts.replyRate !== undefined && opts.replyRate < 0.3 ? 1 : (opts.dailyLimit ?? 2);
	const nowDate = (opts.now ?? new Date().toISOString()).slice(0, 10);
	const scored = items.map((item) => scoreAttentionItem(item, nowDate));
	const urgent = scored.filter((item) => item.urgent).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	const daily = scored
		.filter((item) => !item.urgent)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, dailyLimit);
	return { urgent, daily, dailyLimit };
}

export function scoreAttentionItem(item: AttentionItem, today: string): ScoredAttentionItem {
	const tagText = `${item.title} ${(item.tags ?? []).join(" ")}`.toLowerCase();
	const urgent = urgentSignals.some((signal) => tagText.includes(signal));
	let score = urgent ? 90 : item.kind === "fyi" ? 20 : 50;
	if (item.created.slice(0, 10) === today) score += 10;
	if (item.asked) score += 30;
	if (item.recentlyRejectedSimilar) score -= 15;
	return { ...item, score, urgent };
}

function safeTimestamp(value: string): string {
	return value.replace(/[.:]/g, "-");
}
