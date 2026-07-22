import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_UI_BASE_URL = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = 5000;
const RECEIPT_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 250;

export interface UiActionToolDeps {
	/** Override for tests; defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Per-HTTP-call timeout. Defaults to 5000. */
	requestTimeoutMs?: number;
	/** Total budget for the receipt poll (design: 8s). Defaults to 8000. */
	receiptTimeoutMs?: number;
	/** Delay between receipt polls. Defaults to 250. */
	pollIntervalMs?: number;
	/** Override so tests need not wait the real interval. Defaults to setTimeout. */
	sleep?: (ms: number) => Promise<void>;
	/** Override for deterministic ids in tests. Defaults to randomUUID. */
	idFactory?: () => string;
}

interface CatalogBody {
	ok?: boolean;
	actions?: Array<{ action?: string }>;
}
interface ActionApiBody {
	ok?: boolean;
	error?: string;
	detail?: string;
	settled?: boolean;
	receipt?: { ok?: boolean; error?: string; state?: Record<string, unknown> };
}

/**
 * her_ui_act — let Samantha operate Fei's samantha-ui panel (switch views, open
 * drawers, collapse the sidebar) and get a real receipt back. It talks to the UI over
 * the same loopback HTTP channel as her_show_widget: first it reads the capability
 * catalog (GET /api/ui/actions) to confirm the action exists, then POSTs the action
 * and polls its receipt (GET /api/ui/action?id=…) until the panel confirms or the 8s
 * budget elapses. It never reports success without an ok receipt — an unknown action,
 * a rejected param, a down UI, or a missing ack each return a clear error.
 */
export function registerUiActionTools(pi: ExtensionAPI, deps: UiActionToolDeps = {}): void {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
	const receiptTimeoutMs = deps.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
	const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const idFactory = deps.idFactory ?? randomUUID;

	pi.registerTool({
		name: "her_ui_act",
		label: "Her UI Act",
		description:
			"Operate Fei's samantha-ui workspace: switch the top view (switch_mode), toggle the project sidebar " +
			"(toggle_sidebar), switch the output panel sub-tab (set_output_view), open a bottom drawer (open_drawer), " +
			"start a new conversation (new_conversation), or toggle preview fullscreen (toggle_fullscreen). Pass the " +
			"action name and its params object. The tool confirms the action against the UI's live capability list, " +
			"runs it, and returns the panel's receipt (ok + the new mode/outputView/sidebar/drawer state). It reports a " +
			"clear error — never a false success — if the action is unknown, the params are wrong, the UI is not " +
			"running, or the panel does not confirm within 8 seconds.",
		parameters: Type.Object({
			action: Type.String(),
			params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			const actionName = params.action;
			const actionParams = (params.params ?? {}) as Record<string, unknown>;

			// 1) Capability check — an action not in the live catalog never gets posted.
			let catalog: CatalogBody;
			try {
				const res = await fetchImpl(`${base}/api/ui/actions`, { signal: combineSignals(signal, requestTimeoutMs) });
				catalog = (await res.json()) as CatalogBody;
			} catch (error) {
				return textResult(networkErrorText(error, base, requestTimeoutMs), { ok: false });
			}
			const available = (catalog.actions ?? [])
				.map((a) => a.action)
				.filter((a): a is string => typeof a === "string");
			if (!available.includes(actionName)) {
				return textResult(
					`Unknown UI action "${actionName}". Available actions: ${available.join(", ") || "(none)"}.`,
					{ ok: false, available },
				);
			}

			// 2) Post the action.
			const id = idFactory();
			let post: ActionApiBody;
			let postStatus: number;
			try {
				const res = await fetchImpl(`${base}/api/ui/action`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id, action: actionName, params: actionParams }),
					signal: combineSignals(signal, requestTimeoutMs),
				});
				postStatus = res.status;
				post = (await res.json().catch(() => ({}))) as ActionApiBody;
			} catch (error) {
				return textResult(networkErrorText(error, base, requestTimeoutMs), { ok: false });
			}
			if (postStatus >= 400 || post.ok === false) {
				const detail = post.detail ? ` — ${post.detail}` : "";
				return textResult(
					`Her UI rejected "${actionName}" (HTTP ${postStatus}): ${post.error ?? "unknown error"}${detail}`,
					{ ok: false, error: post.error },
				);
			}

			// 3) Poll the receipt until the panel confirms or the budget elapses.
			const deadline = Date.now() + receiptTimeoutMs;
			while (Date.now() < deadline) {
				let poll: ActionApiBody;
				try {
					const res = await fetchImpl(`${base}/api/ui/action?id=${encodeURIComponent(id)}`, {
						signal: combineSignals(signal, requestTimeoutMs),
					});
					poll = (await res.json()) as ActionApiBody;
				} catch (error) {
					return textResult(networkErrorText(error, base, requestTimeoutMs), { ok: false });
				}
				if (poll.settled) return receiptResult(actionName, poll.receipt);
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

/** Format a settled receipt — an ok:false receipt is a failure, never a false success. */
function receiptResult(action: string, receipt: ActionApiBody["receipt"]) {
	if (!receipt || receipt.ok !== true) {
		return textResult(`UI action "${action}" failed: ${receipt?.error ?? "unknown error"}`, {
			ok: false,
			error: receipt?.error,
		});
	}
	const state = receipt.state ?? {};
	const summary = Object.entries(state)
		.map(([k, v]) => `${k}=${String(v)}`)
		.join(", ");
	return textResult(`UI action "${action}" applied. Current state: ${summary || "(no snapshot)"}`, {
		ok: true,
		state,
	});
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
