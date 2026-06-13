import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { StorePaths } from "./paths.ts";
import { frontmatter, readJson, readText, writeJson, writeText } from "./store.ts";

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

export interface TelegramApiOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	token: string;
}

export interface SendTelegramMessageOptions extends TelegramApiOptions {
	chatId: string;
	text: string;
}

export interface PollTelegramInboxOptions extends TelegramApiOptions {
	allowedChatId: string;
	limit?: number;
	now?: string;
	offset?: number;
	timeoutSeconds?: number;
}

export interface TelegramPollResult {
	ignored: TelegramQueueResult[];
	nextOffset?: number;
	queued: TelegramQueueResult[];
	received: number;
	rejected: TelegramQueueResult[];
}

export interface PushTelegramOutboxOptions extends TelegramApiOptions {
	chatId: string;
	dryRun?: boolean;
	limit?: number;
	now?: string;
}

export interface TelegramOutboxDelivery {
	messageId?: number;
	path: string;
	sentAt: string;
}

export interface TelegramOutboxResult {
	sent: TelegramOutboxDelivery[];
	skipped: Array<{ path: string; reason: string }>;
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
const defaultTelegramBaseUrl = "https://api.telegram.org";
const telegramMessageLimit = 4096;

interface TelegramApiResponse<T> {
	description?: string;
	error_code?: number;
	ok: boolean;
	result?: T;
}

interface TelegramState {
	nextUpdateOffset?: number;
	sentOutbox: Record<string, { messageId?: number; sentAt: string }>;
}

export async function sendTelegramMessage(opts: SendTelegramMessageOptions): Promise<TelegramMessage> {
	const chatId = requireNonBlank(opts.chatId, "chat id");
	const text = requireNonBlank(opts.text, "message text");
	return callTelegramMethod<TelegramMessage>(opts, "sendMessage", { chat_id: chatId, text });
}

export async function pollTelegramInbox(root: string, opts: PollTelegramInboxOptions): Promise<TelegramPollResult> {
	const state = await readTelegramState(root);
	const offset = opts.offset ?? state.nextUpdateOffset;
	const updates = await callTelegramMethod<TelegramUpdate[]>(opts, "getUpdates", {
		allowed_updates: ["message"],
		limit: opts.limit ?? 20,
		timeout: opts.timeoutSeconds ?? 0,
		...(offset !== undefined ? { offset } : {}),
	});
	const result: TelegramPollResult = { ignored: [], queued: [], received: updates.length, rejected: [] };
	let nextOffset = offset;
	for (const update of updates) {
		if (typeof update.update_id === "number") {
			nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
		}
		const queued = await queueTelegramInbound(root, {
			allowedChatId: opts.allowedChatId,
			now: opts.now,
			update,
		});
		if (queued.status === "queued") result.queued.push(queued);
		if (queued.status === "ignored") result.ignored.push(queued);
		if (queued.status === "rejected") result.rejected.push(queued);
	}
	if (nextOffset !== undefined) {
		state.nextUpdateOffset = nextOffset;
		await writeTelegramState(root, state);
		result.nextOffset = nextOffset;
	}
	return result;
}

export async function pushTelegramOutbox(root: string, opts: PushTelegramOutboxOptions): Promise<TelegramOutboxResult> {
	const paths = new StorePaths(root);
	const state = await readTelegramState(root);
	const result: TelegramOutboxResult = { sent: [], skipped: [] };
	const files = await listMarkdownFiles(paths.outbox);
	const limit = opts.limit ?? 5;
	for (const file of files) {
		const relativePath = `outbox/${file}`;
		if (state.sentOutbox[relativePath]) {
			result.skipped.push({ path: relativePath, reason: "already sent" });
			continue;
		}
		if (result.sent.length >= limit) {
			result.skipped.push({ path: relativePath, reason: "limit reached" });
			continue;
		}
		const text = (await readText(join(paths.outbox, file)))?.trim();
		if (!text) {
			result.skipped.push({ path: relativePath, reason: "empty outbox item" });
			continue;
		}
		const sentAt = opts.now ?? new Date().toISOString();
		if (opts.dryRun) {
			result.sent.push({ path: relativePath, sentAt });
			continue;
		}
		const message = await sendTelegramMessage({
			baseUrl: opts.baseUrl,
			chatId: opts.chatId,
			fetch: opts.fetch,
			text: trimTelegramText(text),
			token: opts.token,
		});
		state.sentOutbox[relativePath] = { messageId: message.message_id, sentAt };
		await writeTelegramState(root, state);
		result.sent.push({ messageId: message.message_id, path: relativePath, sentAt });
	}
	return result;
}

export async function callTelegramMethod<T>(
	opts: TelegramApiOptions,
	method: string,
	payload: Record<string, unknown>,
): Promise<T> {
	const token = requireNonBlank(opts.token, "telegram bot token");
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(method)) throw new Error(`invalid Telegram method: ${method}`);
	const fetcher = opts.fetch ?? globalThis.fetch;
	if (!fetcher) throw new Error("global fetch is not available");
	const response = await fetcher(`${telegramBaseUrl(opts.baseUrl)}/bot${token}/${method}`, {
		body: JSON.stringify(payload),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	const raw = await response.text();
	let parsed: TelegramApiResponse<T>;
	try {
		parsed = JSON.parse(raw) as TelegramApiResponse<T>;
	} catch {
		throw new Error(`Telegram ${method} returned non-JSON response (${response.status})`);
	}
	if (!response.ok || !parsed.ok) {
		const detail = parsed.description ?? `HTTP ${response.status}`;
		throw new Error(`Telegram ${method} failed: ${detail}`);
	}
	if (!("result" in parsed)) throw new Error(`Telegram ${method} response did not include result`);
	return parsed.result as T;
}

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

async function listMarkdownFiles(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

async function readTelegramState(root: string): Promise<TelegramState> {
	const state = await readJson<Partial<TelegramState>>(telegramStatePath(root), {});
	return { ...state, sentOutbox: state.sentOutbox ?? {} };
}

async function writeTelegramState(root: string, state: TelegramState): Promise<void> {
	await writeJson(telegramStatePath(root), state);
}

function telegramStatePath(root: string): string {
	return join(new StorePaths(root).herDir, "telegram-state.json");
}

function telegramBaseUrl(value: string | undefined): string {
	return (value ?? defaultTelegramBaseUrl).replace(/\/+$/, "");
}

function trimTelegramText(text: string): string {
	if (text.length <= telegramMessageLimit) return text;
	const suffix = "\n\n[trimmed for Telegram message limit]";
	return `${text.slice(0, telegramMessageLimit - suffix.length)}${suffix}`;
}

function requireNonBlank(value: string | undefined, label: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new Error(`${label} cannot be blank`);
	return trimmed;
}
