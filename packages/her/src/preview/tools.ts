import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_UI_BASE_URL = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = 5000;

export interface PreviewToolDeps {
	/** Override for tests; defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Override for tests so timeout cases don't need to wait the real 5s. Defaults to 5000. */
	timeoutMs?: number;
}

interface PreviewApiBody {
	ok?: boolean;
	error?: string;
	slug?: string;
	seq?: number;
}

export function registerPreviewTools(pi: ExtensionAPI, deps: PreviewToolDeps = {}): void {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

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
			return await postJson(fetchImpl, base, "/api/browser/agent-navigate", { url: params.url }, signal, timeoutMs, {
				successText: () => `Navigated to ${params.url}`,
				controlOwnerDeniedText: () =>
					"Navigation denied: control is with Fei right now. Ask him to hand control back (handback), then try again.",
			});
		},
	});

	pi.registerTool({
		name: "artifact_publish",
		label: "Artifact Publish",
		description:
			"Publish an HTML file you have already written (give its absolute local path) to Fei's preview panel " +
			"'artifacts' view, where it renders sandboxed via srcdoc. Re-publishing the same source path updates that " +
			"artifact in place instead of creating a duplicate.",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			return await postJson(fetchImpl, base, "/api/preview/artifact", { path: params.path }, signal, timeoutMs, {
				successText: (parsed) => `已发布到作品面板: ${parsed?.slug ?? ""}`,
				notConfiguredText: () =>
					"Her UI has not configured HER_ARTIFACTS_DIR, so it cannot save published artifacts yet. " +
					"Ask Fei to set HER_ARTIFACTS_DIR on the UI host, then try again.",
			});
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
	opts: {
		successText: (parsed: PreviewApiBody | undefined) => string;
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
