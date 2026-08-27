import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_UI_BASE_URL = "http://127.0.0.1:4321";
/** Chromium cold start + page load. her_act's 5s is too tight. */
export const PREVIEW_STILL_TIMEOUT_MS = 60_000;

export interface PreviewStillToolDeps {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	workspaceId?: string;
	uiBase?: string;
}

interface StillApiBody {
	ok?: boolean;
	skipped?: boolean;
	reason?: string;
	path?: string;
	error?: string;
}

/**
 * In-loop Design still (G-352). Shoots workspace index.html into
 * references/preview-01.png via samantha-ui. Does not touch Fei's live Browser.
 */
export function registerPreviewStillTools(pi: ExtensionAPI, deps: PreviewStillToolDeps = {}): void {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const timeoutMs = deps.timeoutMs ?? PREVIEW_STILL_TIMEOUT_MS;

	pi.registerTool({
		name: "her_preview_still",
		label: "Preview Still",
		description:
			"Shoot this workspace's index.html into references/preview-01.png with a one-shot Chromium. " +
			"Use during a screenshot Design build to compare the page you just wrote against the source frames. " +
			"Missing Chromium is skip, not failure. Do NOT use browser_navigate or Fei's live Browser for this.",
		parameters: Type.Object({
			workspaceId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal) {
			const workspaceId =
				(typeof params.workspaceId === "string" ? params.workspaceId.trim() : "") ||
				deps.workspaceId?.trim() ||
				process.env.HER_WORKSPACE_ID?.trim() ||
				"";
			if (!workspaceId) {
				return textResult("Missing workspaceId. Pass it, or run inside a Studio build (HER_WORKSPACE_ID).", {
					ok: false,
				});
			}
			const base = deps.uiBase ?? uiBase();
			let response: Response;
			try {
				response = await fetchImpl(`${base}/api/design/preview-still`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ workspaceId }),
					signal: combineSignals(signal, timeoutMs),
				});
			} catch (error) {
				return textResult(networkErrorText(error, base, timeoutMs), { ok: false });
			}
			const raw = await response.text();
			let parsed: StillApiBody | undefined;
			try {
				parsed = raw ? (JSON.parse(raw) as StillApiBody) : undefined;
			} catch {
				return textResult(
					`Her UI at ${base} returned a non-JSON response (HTTP ${response.status}) for /api/design/preview-still.`,
					{ ok: false },
				);
			}
			if (parsed?.skipped) {
				return textResult(
					`Preview still skipped (${parsed.reason ?? "unknown"}). Continue without a still — this is not a failure.`,
					{ ok: false, skipped: true, reason: parsed.reason },
				);
			}
			if (!response.ok || parsed?.ok === false) {
				return textResult(
					`Her UI rejected the still (HTTP ${response.status}): ${parsed?.error ?? "unknown error"}`,
					{ ok: false, error: parsed?.error },
				);
			}
			const path = parsed?.path ?? "references/preview-01.png";
			return textResult(`Wrote ${path}. Read it and close the visual gap before finishing.`, {
				ok: true,
				path,
			});
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
	const detail = error instanceof Error ? error.message : String(error);
	if (/ECONNREFUSED|fetch failed/i.test(detail)) {
		return `Cannot reach Her UI at ${base} (connection refused). Is samantha-ui running?`;
	}
	return `Request to ${base} failed: ${detail}`;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}
