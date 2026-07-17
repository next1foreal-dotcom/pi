import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_UI_BASE_URL = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = 5000;

export interface ShowWidgetToolDeps {
	/** Override for tests; defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Override for tests so timeout cases don't need to wait the real 5s. Defaults to 5000. */
	timeoutMs?: number;
}

interface ShowWidgetApiBody {
	ok?: boolean;
	error?: string;
}

export function registerShowWidgetTools(pi: ExtensionAPI, deps: ShowWidgetToolDeps = {}): void {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

	pi.registerTool({
		name: "her_show_widget",
		label: "Show Widget",
		description:
			"Render a self-contained visual sketch (inline HTML/SVG) inside Fei's preview panel 'widget' view — " +
			"a quick canvas for showing him a diagram, layout, or concept while discussing it, instead of only words. " +
			"The html must be fully self-contained: inline styles/scripts only, no external resources (a strict CSP " +
			"blocks all network requests), and at most 256KB. This is a throwaway sketch for Fei to look at, not a " +
			"deliverable. Pass html:null to clear the widget view. focus defaults to false — the panel shows an unread " +
			"badge without stealing Fei's workspace; set focus:true only when he must see it enlarged right now.",
		parameters: Type.Object({
			html: Type.Union([Type.String(), Type.Null()]),
			title: Type.Optional(Type.String()),
			focus: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			return await postJson(
				fetchImpl,
				base,
				"/api/preview/widget",
				{ html: params.html, title: params.title, focus: params.focus ?? false },
				signal,
				timeoutMs,
				{
					successText: () =>
						params.html === null
							? "Widget view cleared."
							: `Sketch${params.title ? ` “${params.title}”` : ""} is now showing in Fei's preview panel widget view.`,
					tooLargeText: () =>
						"Widget rejected: the html exceeds the 256KB limit. Trim it to a smaller self-contained sketch.",
				},
			);
		},
	});
}

function uiBase(): string {
	return process.env.HER_UI_BASE_URL ?? DEFAULT_UI_BASE_URL;
}

async function postJson(
	fetchImpl: typeof fetch,
	base: string,
	path: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	opts: { successText: () => string; tooLargeText?: () => string },
) {
	let response: Response;
	try {
		response = await fetchImpl(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: combineSignals(signal, timeoutMs),
		});
	} catch (error) {
		return textResult(networkErrorText(error, base, timeoutMs));
	}

	const raw = await response.text();
	let parsed: ShowWidgetApiBody | undefined;
	try {
		parsed = raw ? (JSON.parse(raw) as ShowWidgetApiBody) : undefined;
	} catch {
		return textResult(`Her UI at ${base} returned a non-JSON response (HTTP ${response.status}) for ${path}.`);
	}

	if (response.status === 401) {
		return textResult(
			"Her UI is in LAN mode and requires a token; v1 does not support LAN token injection " +
				"(loopback-only). Run Her UI in local/loopback mode to use this tool.",
		);
	}
	if (parsed?.error === "too-large" && opts.tooLargeText) {
		return textResult(opts.tooLargeText());
	}
	if (!response.ok || parsed?.ok === false) {
		return textResult(`Her UI rejected the request (HTTP ${response.status}): ${parsed?.error ?? "unknown error"}`);
	}
	return textResult(opts.successText(), { status: response.status });
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
