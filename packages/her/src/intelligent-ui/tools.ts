import type { CustomMessageEntryDraft, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveStudioUiBase } from "../preview/design-lab-open.ts";
import { buildIntelligentUiMessage, INTELLIGENT_UI_TITLE_MAX } from "./message.ts";

const CATALOG_TIMEOUT_MS = 5_000;

export interface IntelligentUiToolDeps {
	fetchImpl?: typeof fetch;
	resolveUiBase?: () => string;
	requestTimeoutMs?: number;
}

interface PendingUiMessage {
	draft: CustomMessageEntryDraft;
	signal: AbortSignal | undefined;
}

/** A display tool only. Business actions remain in Studio's existing Action Gate. */
export function registerIntelligentUiTools(pi: ExtensionAPI, deps: IntelligentUiToolDeps = {}): void {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const resolveUiBase = deps.resolveUiBase ?? resolveStudioUiBase;
	const pendingBySession = new Map<string, Map<string, PendingUiMessage>>();
	pi.on("turn_end", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const pending = pendingBySession.get(sessionId);
		pendingBySession.delete(sessionId);
		if (!pending || event.outcome !== "completed" || ctx.signal?.aborted) return;
		const drafts: CustomMessageEntryDraft[] = [];
		for (const result of event.toolResults) {
			const message = pending.get(result.toolCallId);
			if (result.toolName !== "her_intelligent_ui" || result.isError || !message || message.signal?.aborted)
				continue;
			pending.delete(result.toolCallId);
			drafts.push(message.draft);
		}
		// Pi persists boundary drafts before emitting entry_appended. Keep earlier
		// handlers' entries and do not request an extra provider turn to deliver a UI.
		if (drafts.length > 0) return { entries: [...event.entries, ...drafts] };
	});
	pi.on("agent_end", () => pendingBySession.clear());
	pi.on("session_start", () => pendingBySession.clear());
	pi.on("session_shutdown", () => pendingBySession.clear());
	pi.on("session_tree", () => pendingBySession.clear());
	pi.registerTool({
		name: "her_intelligent_ui",
		label: "Her Intelligent UI",
		description:
			"Compose an interactive answer with Studio's own themed components. First call operation=catalog " +
			"to discover the component schemas and read-only action/continue contract. Then call operation=render " +
			"(the default) with a short title and OpenUI code, starting with root = as the first statement. " +
			"Studio previews code as the tool arguments stream and saves the final interface in this conversation. " +
			"Use only catalog components and listed read-only actions; continue with the current UI state. " +
			"This tool does not execute business actions or require a separate model.",
		parameters: Type.Object({
			operation: Type.Optional(Type.Union([Type.Literal("catalog"), Type.Literal("render")])),
			title: Type.Optional(Type.String({ maxLength: INTELLIGENT_UI_TITLE_MAX })),
			code: Type.Optional(Type.String({ description: "OpenUI Lang source; root must be the first assignment." })),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const operation = params.operation ?? "render";
			if (operation === "catalog") {
				const base = resolveUiBase().replace(/\/+$/, "");
				const timeout = AbortSignal.timeout(deps.requestTimeoutMs ?? CATALOG_TIMEOUT_MS);
				let response: Response;
				try {
					response = await fetchImpl(`${base}/api/her/intelligent-ui/catalog`, {
						method: "GET",
						signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
					});
				} catch (error) {
					throw new Error(
						`Intelligent UI catalog request failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				if (!response.ok) throw new Error(`Intelligent UI catalog request failed (HTTP ${response.status})`);
				let catalog: unknown;
				try {
					catalog = await response.json();
				} catch {
					throw new Error("Intelligent UI catalog returned invalid JSON");
				}
				if (
					!catalog ||
					typeof catalog !== "object" ||
					Array.isArray(catalog) ||
					(catalog as { ok?: unknown }).ok !== true
				) {
					throw new Error("Intelligent UI catalog is unavailable");
				}
				const fields = catalog as Record<string, unknown>;
				const spec = fields.spec as { root?: unknown; components?: unknown } | undefined;
				if (
					fields.version !== 1 ||
					typeof fields.systemPrompt !== "string" ||
					!fields.systemPrompt.trim() ||
					!spec ||
					typeof spec.root !== "string" ||
					!spec.root.trim() ||
					!spec.components ||
					typeof spec.components !== "object" ||
					Array.isArray(spec.components) ||
					Object.keys(spec.components).length === 0
				) {
					throw new Error("Intelligent UI catalog has an empty or unsupported component contract");
				}
				return { content: [{ type: "text", text: JSON.stringify(catalog) }], details: catalog };
			}
			if (operation !== "render") throw new Error("operation must be catalog or render");
			const message = buildIntelligentUiMessage(toolCallId, params);
			const sessionId = ctx.sessionManager.getSessionId();
			let pending = pendingBySession.get(sessionId);
			if (!pending) {
				pending = new Map();
				pendingBySession.set(sessionId, pending);
			}
			pending.set(toolCallId, {
				draft: { type: "custom_message", customType: "her-intelligent-ui", display: true, ...message },
				signal,
			});
			return {
				content: [
					{ type: "text", text: `交互界面已准备，将在本轮完成后保存到 Studio：${message.details.title}。` },
				],
				details: { uiId: message.details.uiId, version: 1, queued: true },
			};
		},
	});
}
