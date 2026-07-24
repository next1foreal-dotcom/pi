import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_UI_BASE_URL = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = 120_000;

export interface RelayProviderToolDeps {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

interface AgentUpsertApiBody {
	ok?: boolean;
	error?: string;
	stage?: string;
	id?: string;
	resolvedBaseUrl?: string;
	modelsTotal?: number;
	favorited?: string[];
	smoke?: { ok?: boolean; skipped?: boolean; modelId?: string; latencyMs?: number };
	menuUpdated?: boolean;
}

/**
 * her_upsert_relay_provider — save an OpenAI-compatible 万金油 relay from chat:
 * probe /models → write manifest + .env.local → enable Composer favorites → live chat smoke.
 * OAuth subscriptions (Claude/Codex/Antigravity) still need Fei to log in in the browser; this tool
 * cannot mark those as connected.
 */
export function registerRelayProviderTools(pi: ExtensionAPI, deps: RelayProviderToolDeps = {}): void {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

	pi.registerTool({
		name: "her_upsert_relay_provider",
		label: "Add Relay Provider",
		description:
			"Add or update a custom OpenAI-compatible relay (万金油中转) in Fei's Her UI: name, base URL, and API key. " +
			"The UI probes /models, saves the provider without restart, favorites chat models for the Composer menu, " +
			"and runs a minimal live chat completion smoke test. Use when Fei asks to add a supplier like 兔子 / tu-zi / New API. " +
			"Does NOT connect OAuth subscription providers — those require browser login on /settings/providers.",
		parameters: Type.Object({
			name: Type.String({ description: "Display name, e.g. 兔子中转" }),
			baseUrl: Type.String({ description: "Relay origin or /v1 base, OpenAI-compatible" }),
			apiKey: Type.String({ description: "Bearer API key (stored server-side in .env.local only)" }),
			id: Type.Optional(Type.String({ description: "Stable slug when updating an existing relay" })),
			favoriteModelIds: Type.Optional(
				Type.Array(Type.String(), {
					description: "Model ids to favorite; default is the first chat model from /models",
				}),
			),
			smoke: Type.Optional(Type.Boolean({ description: "Run live chat smoke after save (default true)" })),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			let response: Response;
			try {
				response = await fetchImpl(`${base}/api/providers/agent-upsert`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						name: params.name,
						baseUrl: params.baseUrl,
						apiKey: params.apiKey,
						id: params.id,
						favoriteModelIds: params.favoriteModelIds,
						smoke: params.smoke,
					}),
					signal: combineSignals(signal, timeoutMs),
				});
			} catch (error) {
				return textResult(networkErrorText(error, base, timeoutMs), { ok: false });
			}

			const raw = await response.text();
			let parsed: AgentUpsertApiBody;
			try {
				parsed = raw ? (JSON.parse(raw) as AgentUpsertApiBody) : {};
			} catch {
				return textResult(`Her UI returned non-JSON (HTTP ${response.status}) for agent-upsert.`);
			}

			if (response.status === 401) {
				return textResult("Her UI is in LAN mode and requires a token; use loopback/local mode for this tool.");
			}

			if (!response.ok || parsed.ok === false) {
				const stage = parsed.stage ? ` [${parsed.stage}]` : "";
				return textResult(`Relay provider save failed${stage}: ${parsed.error ?? "unknown error"}`, {
					ok: false,
					status: response.status,
					stage: parsed.stage,
				});
			}

			const fav = parsed.favorited?.length ? parsed.favorited.join(", ") : "(none)";
			const smoke = parsed.smoke;
			const smokeLine = smoke?.skipped
				? "Live smoke skipped (no favorited chat model)."
				: smoke?.ok
					? `Live smoke OK on ${smoke.modelId ?? "model"}${smoke.latencyMs != null ? ` (${smoke.latencyMs}ms)` : ""}.`
					: "Live smoke not run.";

			return textResult(
				`Relay provider “${params.name}” saved as ${parsed.id}. Base: ${parsed.resolvedBaseUrl}. ` +
					`${parsed.modelsTotal ?? 0} models from /models; favorited: ${fav}. ${smokeLine} ` +
					`${parsed.menuUpdated ? "Composer menu updated." : ""}`.trim(),
				{
					ok: true,
					id: parsed.id,
					resolvedBaseUrl: parsed.resolvedBaseUrl,
					favorited: parsed.favorited,
					smoke: parsed.smoke,
				},
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
		return `Her UI at ${base} did not respond within ${timeoutMs / 1000}s (agent-upsert timeout).`;
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
