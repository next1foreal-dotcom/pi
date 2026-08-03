import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_UI_BASE_URL = "http://127.0.0.1:3000";
export const REQUEST_TIMEOUT_MS = 5000;
/**
 * Driving the live browser is slower than the panel endpoints, so every tool that
 * reaches /api/browser/* waits on this tier rather than the panel's 5s:
 *   - navigate runs `page.goto`, which has no explicit host timeout and therefore
 *     inherits Playwright's own 30s navigation budget — a 5s client gave up on
 *     perfectly healthy loads (observed live: cold navigations died on the panel
 *     timeout while read/act on this tier were fine);
 *   - act waits up to the host's REF_ACT_TIMEOUT_MS (5s) for an element to become
 *     actionable, so a 5s client races the server it is waiting on;
 *   - read runs a full ariaSnapshot, past 5s on its own (7.2s measured on
 *     example.com under load).
 * 30s matches Playwright's navigation budget, the longest of the three.
 */
export const BROWSER_REQUEST_TIMEOUT_MS = 30_000;

export interface PreviewToolDeps {
	/** Override for tests; defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Override for tests so timeout cases don't need to wait the real 5s. Defaults to 5000. */
	timeoutMs?: number;
	/** Overrides only the browser-driving tier; falls back to timeoutMs, then the 30s default. */
	browserTimeoutMs?: number;
}

interface PreviewApiBody {
	ok?: boolean;
	error?: string;
	slug?: string;
	seq?: number;
	/** Host detail behind an `error` reason (agent-act). */
	message?: string;
	/** Page-read fields (agent-read). */
	url?: string;
	title?: string;
	generation?: number;
	refCount?: number;
	truncated?: boolean;
	tree?: string;
	/** Echo of what an act applied (agent-act). */
	ref?: string;
	action?: string;
}

export function registerPreviewTools(pi: ExtensionAPI, deps: PreviewToolDeps = {}): void {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
	// deps.timeoutMs still moves both tiers together, so existing callers keep one knob;
	// deps.browserTimeoutMs isolates the driving tier when a test needs them to differ.
	const browserTimeoutMs = deps.browserTimeoutMs ?? deps.timeoutMs ?? BROWSER_REQUEST_TIMEOUT_MS;

	pi.registerTool({
		name: "preview_open_review",
		label: "Preview Open Review",
		description:
			"Open a whitelisted local review page inside Fei's preview panel 'review' view so he can annotate it " +
			"(e.g. the default Roughdraft viewer at http://localhost:7300/?path=<absolute md path, forward slashes>). " +
			"The url must be one of the origins in HER_REVIEW_ALLOWED_ORIGINS on the UI host, which enforces the " +
			"whitelist server-side. Call with no url to clear the review target and leave the review view.",
		parameters: Type.Object({ url: Type.Optional(Type.String()) }),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			return await postJson(fetchImpl, base, "/api/preview/review", { url: params.url ?? null }, signal, timeoutMs, {
				successText: () => (params.url ? `Review pane target set: ${params.url}` : "Review pane target cleared."),
			});
		},
	});

	pi.registerTool({
		name: "browser_navigate",
		label: "Browser Navigate",
		description:
			"Navigate the shared co-drive live browser to a URL. The navigation goes through the UI host's " +
			"control-owner gate: if Fei currently holds control, the request is denied.",
		parameters: Type.Object({ url: Type.String() }),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			return await postJson(
				fetchImpl,
				base,
				"/api/browser/agent-navigate",
				{ url: params.url },
				signal,
				browserTimeoutMs,
				{
					successText: () => `Navigated to ${params.url}`,
					controlOwnerDeniedText: () =>
						"Navigation denied: control is with Fei right now. Ask him to hand control back (handback), then try again.",
				},
			);
		},
	});

	pi.registerTool({
		name: "browser_read_page",
		label: "Browser Read Page",
		description:
			"Read the structure of whatever the shared co-drive live browser is showing: a YAML accessibility tree " +
			"where every actionable node carries a handle like [ref=s7e5]. Those refs are the ONLY way to point " +
			"browser_act at an element. A ref belongs to the read that issued it — your next read, any navigation, or " +
			"the element leaving the page retires it, so read again rather than reusing an old ref. Reading is NOT " +
			"blocked while Fei holds control (the gate stops you acting, not seeing), so this is also how you catch up " +
			"after a handback. Optional maxChars caps the tree (default 20000, clamped to 500..100000); a truncated " +
			"tree says so on its last line, and any ref the cut removed is NOT actionable — raise maxChars rather " +
			"than guess at what was dropped. When the tree shows a password, verification-code, payment or agreement " +
			"field, do not plan to fill it — read the browser-discipline skill and ask Fei to take over.",
		parameters: Type.Object({ maxChars: Type.Optional(Type.Number()) }),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			const body = params.maxChars === undefined ? {} : { maxChars: params.maxChars };
			return await postJson(fetchImpl, base, "/api/browser/agent-read", body, signal, browserTimeoutMs, {
				successText: (parsed) => renderPageRead(parsed),
			});
		},
	});

	pi.registerTool({
		name: "browser_act",
		label: "Browser Act",
		description:
			"Act on ONE element from your latest browser_read_page, by its ref: click, type (text required — an empty " +
			"string clears the field), press (put the key name in text, e.g. Enter or Control+a), or scroll_to. Then " +
			"read the page again — 'I clicked' is not evidence, 'the page now shows X' is. The act goes through the " +
			"UI host's control-owner gate: while Fei holds the wheel OR the browser is paused you get " +
			"control-owner-denied, which is a guardrail working, " +
			"not a fault — stop and wait for his handback instead of retrying. You have no takeover or handback tool " +
			"BY DESIGN: handing the wheel over is always Fei's move, never yours. Never use this on a password, " +
			"verification-code, payment-confirm or terms-agreement control — those three classes are his to press; " +
			"read the browser-discipline skill and ask him to take over.",
		parameters: Type.Object({
			ref: Type.String(),
			action: Type.Union([
				Type.Literal("click"),
				Type.Literal("type"),
				Type.Literal("press"),
				Type.Literal("scroll_to"),
			]),
			text: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			// `text: ""` is a legitimate "clear this field", so only an absent text is dropped.
			const body = {
				ref: params.ref,
				action: params.action,
				...(params.text === undefined ? {} : { text: params.text }),
			};
			return await postJson(fetchImpl, base, "/api/browser/agent-act", body, signal, browserTimeoutMs, {
				successText: (parsed) =>
					`${parsed?.action ?? params.action} applied on ${parsed?.ref ?? params.ref}. ` +
					"Call browser_read_page again to see what it actually did.",
				errorTexts: {
					"control-owner-denied": (parsed) =>
						`${errorLine(parsed)} Control is with Fei right now (or the browser is paused) — the gate is ` +
						"doing its job, this is not a failure to retry. Stop here and wait for him to hand control back.",
					// The host puts Playwright's real diagnosis in `message` and only "error" in `error`,
					// so the generic fallback would report nothing usable.
					error: (parsed) =>
						`${errorLine(parsed)} The element would not take that act. Call browser_read_page again to ` +
						"see its current state before trying anything else.",
					"stale-ref": (parsed) =>
						`${errorLine(parsed)} That ref came from an earlier read. Call browser_read_page again and act ` +
						"on a ref from that fresh read.",
					"unknown-ref": (parsed) =>
						`${errorLine(parsed)} The current read has no such element. Call browser_read_page again and ` +
						"pick a ref from it.",
					"invalid-ref": (parsed) =>
						`${errorLine(parsed)} A ref must be one browser_read_page handed you (they look like s7e5).`,
				},
			});
		},
	});

	pi.registerTool({
		name: "artifact_publish",
		label: "Artifact Publish",
		description:
			"Publish an HTML file you have already written (give its absolute local path) to Fei's preview panel " +
			"'artifacts' view, where it renders sandboxed via srcdoc. Re-publishing the same source path updates that " +
			"artifact in place instead of creating a duplicate. Write the path with FORWARD slashes " +
			"(C:/Users/... not C:\\Users\\...) — backslashes risk invalid JSON escapes in the tool call.",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			return await postJson(fetchImpl, base, "/api/preview/artifact", { path: params.path }, signal, timeoutMs, {
				successText: (parsed) => `已发布到作品面板: ${parsed?.slug ?? ""}`,
				notConfiguredText: () =>
					"Her UI has no artifacts directory (set HER_MEMORY_DIR for her-memory/published, " +
					"or HER_ARTIFACTS_DIR to override). Ask Fei to configure the UI host, then try again.",
			});
		},
	});
}

function uiBase(): string {
	return process.env.HER_UI_BASE_URL ?? DEFAULT_UI_BASE_URL;
}

/**
 * One page read, as she reads it: where she is, then the tree itself. The header
 * repeats the read number because refs are only valid within their own read, and
 * flags a truncation up front — the host also marks the cut inline, but a note at
 * the bottom of a long tree is a note she may act before reaching.
 */
function renderPageRead(parsed: PreviewApiBody | undefined): string {
	const title = parsed?.title ? ` — ${parsed.title}` : "";
	const header =
		`Page read #${parsed?.generation ?? "?"}: ${parsed?.url ?? "(unknown url)"}${title} ` +
		`(${parsed?.refCount ?? 0} refs). Act on a [ref=…] below with browser_act; these refs die on your next ` +
		"read or navigation.";
	const truncation = parsed?.truncated
		? "\nNOTE: truncated — this is only part of the page. Raise maxChars or narrow the page before concluding."
		: "";
	return `${header}${truncation}\n\n${parsed?.tree ?? "(empty tree)"}`;
}

/** The host's own error reason and detail, verbatim — never paraphrased away. */
function errorLine(parsed: PreviewApiBody | undefined): string {
	const detail = parsed?.message ? `: ${parsed.message}` : "";
	return `${parsed?.error ?? "error"}${detail}.`;
}

async function postJson(
	fetchImpl: typeof fetch,
	base: string,
	path: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	opts: {
		successText: (parsed: PreviewApiBody | undefined) => string;
		/** Per-`error`-reason text: the host's own words, plus what to do about it. */
		errorTexts?: Record<string, (parsed: PreviewApiBody | undefined) => string>;
		controlOwnerDeniedText?: () => string;
		notConfiguredText?: () => string;
	},
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
	let parsed: PreviewApiBody | undefined;
	try {
		parsed = raw ? (JSON.parse(raw) as PreviewApiBody) : undefined;
	} catch {
		return textResult(`Her UI at ${base} returned a non-JSON response (HTTP ${response.status}) for ${path}.`);
	}

	if (response.status === 401) {
		return textResult(
			"Her UI is in LAN mode and requires a token; v1 does not support LAN token injection " +
				"(loopback-only). Run Her UI in local/loopback mode to use this tool.",
		);
	}
	const errorText = parsed?.error ? opts.errorTexts?.[parsed.error] : undefined;
	if (errorText) {
		return textResult(errorText(parsed), { status: response.status });
	}
	if (parsed?.error === "control-owner-denied" && opts.controlOwnerDeniedText) {
		return textResult(opts.controlOwnerDeniedText());
	}
	if (parsed?.error === "artifacts_dir_not_configured" && opts.notConfiguredText) {
		return textResult(opts.notConfiguredText());
	}
	if (!response.ok || parsed?.ok === false) {
		return textResult(`Her UI rejected the request (HTTP ${response.status}): ${parsed?.error ?? "unknown error"}`);
	}
	return textResult(opts.successText(parsed), { status: response.status });
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
