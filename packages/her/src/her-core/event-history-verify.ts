import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eventHistoryPath, eventHistoryStatePath, readEventHistory } from "./event-history.ts";
import { writeJson } from "./store.ts";
import { sendTelegramMessage } from "./telegram.ts";

export type VerifyAlertSender = (text: string) => Promise<unknown>;

export interface VerifyResult {
	ok: boolean;
	reason?: string;
}

interface ProbeState {
	prefixLength: number;
	prefixSha256: string;
	lastId: string;
}

export function eventHistoryAlertPath(root: string): string {
	return join(root, ".her", "event-history-alert.json");
}

export async function verifyEventHistoryPrefix(opts: {
	root: string;
	sendAlert?: VerifyAlertSender;
}): Promise<VerifyResult> {
	const file = await readHistoryBytes(opts.root);
	const state = await readProbeState(opts.root);
	if (!state) {
		await writeProbeState(opts.root, await snapshotState(opts.root, file));
		return { ok: true };
	}
	const red = findProbeFailure(file, state, await lastEventId(opts.root));
	if (red) {
		await raiseProbeAlert(opts, red);
		return red;
	}
	await writeProbeState(opts.root, await snapshotState(opts.root, file));
	return { ok: true };
}

async function readHistoryBytes(root: string): Promise<Buffer> {
	try {
		return await readFile(eventHistoryPath(root));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return Buffer.alloc(0);
		}
		throw error;
	}
}

async function readProbeState(root: string): Promise<ProbeState | undefined> {
	try {
		const raw = await readFile(eventHistoryStatePath(root), "utf8");
		const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
		if (!value || typeof value !== "object") return undefined;
		const rec = value as Record<string, unknown>;
		if (
			typeof rec.prefixLength !== "number" ||
			typeof rec.prefixSha256 !== "string" ||
			typeof rec.lastId !== "string"
		) {
			return undefined;
		}
		return { prefixLength: rec.prefixLength, prefixSha256: rec.prefixSha256, lastId: rec.lastId };
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function findProbeFailure(file: Buffer, state: ProbeState, lastId: string): VerifyResult | undefined {
	if (file.byteLength < state.prefixLength) {
		return { ok: false, reason: "truncated" };
	}
	const prefixHash = sha256(file.subarray(0, state.prefixLength));
	if (prefixHash !== state.prefixSha256) {
		return { ok: false, reason: "prefix_mismatch" };
	}
	if (state.lastId && lastId < state.lastId) {
		return { ok: false, reason: "last_id_regressed" };
	}
	return undefined;
}

async function snapshotState(root: string, file: Buffer): Promise<ProbeState> {
	return {
		prefixLength: file.byteLength,
		prefixSha256: sha256(file),
		lastId: await lastEventId(root),
	};
}

async function lastEventId(root: string): Promise<string> {
	const { events } = await readEventHistory(root);
	return events.length === 0 ? "" : events[events.length - 1].id;
}

async function writeProbeState(root: string, state: ProbeState): Promise<void> {
	await writeJson(eventHistoryStatePath(root), state);
}

async function raiseProbeAlert(
	opts: { root: string; sendAlert?: VerifyAlertSender },
	red: VerifyResult,
): Promise<void> {
	await writeJson(eventHistoryAlertPath(opts.root), {
		ts: new Date().toISOString(),
		reason: red.reason,
	});
	const sender = opts.sendAlert ?? defaultSendAlert;
	try {
		await sender(`Her event-history probe RED: ${red.reason}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[her] event-history telegram alert failed: ${message}`);
	}
}

async function defaultSendAlert(text: string): Promise<void> {
	await sendTelegramMessage({
		token: process.env.HER_TELEGRAM_BOT_TOKEN ?? "",
		chatId: process.env.HER_TELEGRAM_CHAT_ID ?? "",
		baseUrl: process.env.HER_TELEGRAM_BASE_URL,
		text,
	});
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
