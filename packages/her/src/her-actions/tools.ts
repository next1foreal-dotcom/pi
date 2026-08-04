import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_UI_BASE_URL = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = 5000;
const RECEIPT_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 250;

export interface HerActToolDeps {
	fetchImpl?: typeof fetch;
	requestTimeoutMs?: number;
	receiptTimeoutMs?: number;
	pollIntervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
	idFactory?: () => string;
}

interface CatalogBody {
	ok?: boolean;
	actions?: Array<{ action?: string; channel?: string }>;
}

interface InvokeBody {
	ok?: boolean;
	channel?: string;
	action?: string;
	result?: unknown;
	id?: string;
	pending?: boolean;
	error?: string;
	detail?: string;
	available?: string[];
}

interface ReceiptPollBody {
	ok?: boolean;
	settled?: boolean;
	receipt?: { ok?: boolean; error?: string; state?: Record<string, unknown> };
}

/**
 * her_act — unified Action 面 (G-153). Calls samantha-ui POST /api/her/actions so
 * server domain actions and UI chrome actions share one catalog with Studio.
 * UI-channel invokes enqueue + poll the existing receipt ring (same as her_ui_act).
 */
export function registerHerActTools(pi: ExtensionAPI, deps: HerActToolDeps = {}): void {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
	const receiptTimeoutMs = deps.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
	const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const idFactory = deps.idFactory ?? randomUUID;

	pi.registerTool({
		name: "her_act",
		label: "Her Act",
		description:
			"Invoke a Her Action from the unified Action 面 (G-153). Prefer this for capabilities " +
			"that Studio can also trigger: memory.recall, memory.surface, task.list, and UI chrome " +
			"(set_output_view, switch_mode, toggle_sidebar, open_drawer, new_conversation, toggle_fullscreen). " +
			"Pass action name + params. Server actions return the result immediately; UI actions wait for " +
			"a panel receipt (same honesty as her_ui_act).",
		parameters: Type.Object({
			action: Type.String(),
			params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			const actionName = params.action;
			const actionParams = (params.params ?? {}) as Record<string, unknown>;

			let catalog: CatalogBody;
			try {
				const res = await fetchImpl(`${base}/api/her/actions`, {
					signal: combineSignals(signal, requestTimeoutMs),
				});
				catalog = (await res.json()) as CatalogBody;
			} catch (error) {
				return textResult(networkErrorText(error, base, requestTimeoutMs), { ok: false });
			}
			const available = (catalog.actions ?? [])
				.map((a) => a.action)
				.filter((a): a is string => typeof a === "string");
			if (!available.includes(actionName)) {
				return textResult(`Unknown Her action "${actionName}". Available: ${available.join(", ") || "(none)"}.`, {
					ok: false,
					available,
				});
			}

			const id = idFactory();
			let invoke: InvokeBody;
			let status: number;
			try {
				const res = await fetchImpl(`${base}/api/her/actions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						id,
						action: actionName,
						params: actionParams,
						source: "agent",
					}),
					signal: combineSignals(signal, requestTimeoutMs),
				});
				status = res.status;
				invoke = (await res.json().catch(() => ({}))) as InvokeBody;
			} catch (error) {
				return textResult(networkErrorText(error, base, requestTimeoutMs), { ok: false });
			}
			if (status >= 400 || invoke.ok === false) {
				const detail = invoke.detail ? ` — ${invoke.detail}` : "";
				return textResult(
					`Her action "${actionName}" rejected (HTTP ${status}): ${invoke.error ?? "unknown"}${detail}`,
					{ ok: false, error: invoke.error, available: invoke.available },
				);
			}

			if (invoke.channel === "server") {
				return textResult(JSON.stringify({ action: actionName, result: invoke.result }, null, 2), {
					ok: true,
					channel: "server",
					action: actionName,
					result: invoke.result,
				});
			}

			// UI channel — poll receipt on the legacy ui-action ring.
			const deadline = Date.now() + receiptTimeoutMs;
			while (Date.now() < deadline) {
				let poll: ReceiptPollBody;
				try {
					const res = await fetchImpl(`${base}/api/ui/action?id=${encodeURIComponent(id)}`, {
						signal: combineSignals(signal, requestTimeoutMs),
					});
					poll = (await res.json()) as ReceiptPollBody;
				} catch (error) {
					return textResult(networkErrorText(error, base, requestTimeoutMs), { ok: false });
				}
				if (poll.settled) {
					const receipt = poll.receipt;
					if (!receipt || receipt.ok !== true) {
						return textResult(`UI action "${actionName}" failed: ${receipt?.error ?? "unknown error"}`, {
							ok: false,
							error: receipt?.error,
						});
					}
					const state = receipt.state ?? {};
					const summary = Object.entries(state)
						.map(([k, v]) => `${k}=${String(v)}`)
						.join(", ");
					return textResult(`UI action "${actionName}" applied. Current state: ${summary || "(no snapshot)"}`, {
						ok: true,
						channel: "ui",
						state,
					});
				}
				await sleep(pollIntervalMs);
			}
			return textResult(
				`Her UI did not confirm "${actionName}" within ${receiptTimeoutMs / 1000}s (no ack). Is the panel running?`,
				{ ok: false },
			);
		},
	});
}

function uiBase(): string {
	return process.env.HER_UI_BASE_URL ?? DEFAULT_UI_BASE_URL;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function networkErrorText(error: unknown, base: string, timeoutMs: number): string {
	if (error instanceof Error && error.name === "TimeoutError") {
		return `Her UI at ${base} did not respond within ${timeoutMs / 1000}s (timeout).`;
	}
	const detail = errorMessage(error);
	if (/ECONNREFUSED|fetch failed/i.test(detail)) {
		return `Cannot reach Her UI at ${base} (connection refused). Is samantha-ui running?`;
	}
	return `Request to ${base} failed: ${detail}`;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as Error & { cause?: unknown }).cause;
		const causeText = cause instanceof Error ? `: ${cause.message}` : "";
		return `${error.message}${causeText}`;
	}
	return String(error);
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}
