import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import {
	DESIGN_LAB_PORT,
	DESIGN_LAB_URL,
	type DesignLabOpenDeps,
	ensureDesignLabReady,
	resolveStudioUiBase,
} from "./design-lab-open.ts";

const DEFAULT_UI_BASE_URL = "http://localhost:3000";
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

const BATCHABLE_BROWSER_TOOL_NAMES = [
	"browser_navigate",
	"browser_read_page",
	"browser_act",
	"browser_find",
	"browser_get_text",
	"browser_console",
	"browser_network",
	"browser_screenshot",
	"browser_computer",
	"browser_form_input",
	"browser_eval",
	"browser_viewport",
	"browser_history",
] as const;

const BATCHABLE_BROWSER_TOOL_NAME_SET: ReadonlySet<string> = new Set(BATCHABLE_BROWSER_TOOL_NAMES);
const BROWSER_BATCH_MAX_STEPS = 20;

export interface PreviewToolDeps {
	/** Override for tests; defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Override for tests so timeout cases don't need to wait the real 5s. Defaults to 5000. */
	timeoutMs?: number;
	/** Overrides only the browser-driving tier; falls back to timeoutMs, then the 30s default. */
	browserTimeoutMs?: number;
	/** Test seams for design_lab_open (probe/start/base). */
	designLab?: DesignLabOpenDeps;
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
	/** Find results (agent-find). */
	hits?: Array<{ ref: string; line: string }>;
	total?: number;
	/** Page text (agent-page-text). */
	text?: string;
	/** Console/network entries (agent-console, agent-network). */
	entries?: unknown[];
	droppedUnread?: number;
	counts?: Record<string, unknown>;
	/** Network response body (agent-network with requestId). */
	body?: string;
	base64Encoded?: boolean;
	/** Screenshot (agent-screenshot). */
	base64?: string;
	width?: number;
	height?: number;
	frozen?: boolean;
	/** Eval result (agent-eval). */
	value?: unknown;
	/** Viewport emulation state (agent-viewport). */
	state?: Record<string, unknown>;
	/** Control-owner gate refusal (act-class routes). */
	reason?: string;
	/** Computer act note (agent-computer). */
	note?: string;
}

export function registerPreviewTools(pi: ExtensionAPI, deps: PreviewToolDeps = {}): void {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
	// deps.timeoutMs still moves both tiers together, so existing callers keep one knob;
	// deps.browserTimeoutMs isolates the driving tier when a test needs them to differ.
	const browserTimeoutMs = deps.browserTimeoutMs ?? deps.timeoutMs ?? BROWSER_REQUEST_TIMEOUT_MS;

	const batchableBrowserTools = new Map<string, ToolDefinition>();
	function registerTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void {
		pi.registerTool(tool);
		if (BATCHABLE_BROWSER_TOOL_NAME_SET.has(tool.name)) {
			batchableBrowserTools.set(tool.name, tool as ToolDefinition);
		}
	}

	registerTool({
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

	registerTool({
		name: "browser_navigate",
		label: "Browser Navigate",
		description:
			"Navigate the shared co-drive live browser to a URL. The navigation goes through the UI host's " +
			"control-owner gate: if Fei currently holds control, the request is denied.",
		parameters: Type.Object({ url: Type.String() }),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			return await navigateStudioBrowser(fetchImpl, base, params.url, signal, browserTimeoutMs);
		},
	});

	registerTool({
		name: "browser_read_page",
		label: "Browser Read Page",
		description:
			"Read the structure of whatever the shared co-drive live browser is showing: a YAML accessibility tree " +
			"where every actionable node carries a handle like [ref_7]. Each line looks like: " +
			'role "name" [ref_7] href="..." — the ref is the ONLY way to point browser_act, browser_computer, or ' +
			"browser_form_input at an element. Refs are bound to the DOM element itself (via WeakRef): the same " +
			"element keeps the same ref across multiple reads, and a ref only expires when the element truly leaves " +
			"the DOM (navigation, page change, or the element being removed). Reading is NOT blocked while Fei holds " +
			"control (the gate stops you acting, not seeing — Fei's screencast already shows every pixel), so this is " +
			"also how you catch up after a handback. Optional maxChars caps the tree (default 20000, clamped to " +
			"500..100000); a truncated tree says so on its last line, and any ref the cut removed is NOT actionable — " +
			"raise maxChars rather than guess at what was dropped. When the tree shows a password, verification-code, " +
			"payment or agreement field, do not plan to fill it — read the browser-discipline skill and ask Fei to " +
			"take over. If the response is an error mentioning 'browser not started', the live browser has not been " +
			"launched yet — ask Fei to open a page or use browser_navigate first.",
		parameters: Type.Object({ maxChars: Type.Optional(Type.Number()) }),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			const body = params.maxChars === undefined ? {} : { maxChars: params.maxChars };
			return await postJson(fetchImpl, base, "/api/browser/agent-read", body, signal, browserTimeoutMs, {
				successText: (parsed) => renderPageRead(parsed),
			});
		},
	});

	registerTool({
		name: "browser_act",
		label: "Browser Act",
		description:
			"Act on ONE element from a browser_read_page, by its ref: click, type (text required — an empty " +
			"string clears the field), press (put the key name in text, e.g. Enter or Control+a), or scroll_to. " +
			"Refs are bound to the DOM element (WeakRef) and survive across reads — they only expire when the element " +
			"leaves the DOM. Then read the page again — 'I clicked' is not evidence, 'the page now shows X' is. " +
			"This tool covers ref-targeted actions (click/type/press/scroll_to). For coordinate-based clicks, " +
			"right-click, double/triple click, drag, hover, scrolling, key repeat, or wait, use browser_computer " +
			"instead. The act goes through the UI host's control-owner gate: while Fei holds the wheel OR the " +
			"browser is paused you get control-owner-denied, which is a guardrail working, not a fault — stop and " +
			"wait for his handback instead of retrying. You have no takeover or handback tool BY DESIGN: handing " +
			"the wheel over is always Fei's move, never yours. Never use this on a password, verification-code, " +
			"payment-confirm or terms-agreement control — those four classes are his to press; read the " +
			"browser-discipline skill and ask him to take over.",
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

	// ── new browser tools (task-E) ────────────────────────────────────────────

	registerTool({
		name: "browser_find",
		label: "Browser Find",
		description:
			"Search the latest browser_read_page tree for elements matching a text query (case-insensitive " +
			"substring match on role, name, and value). Returns up to 20 matching refs with their tree lines. " +
			"This searches the ALREADY-READ tree, not the live page — call browser_read_page first if you have " +
			"not read recently. Fei holding the wheel does NOT block this (the gate stops acting, not searching). " +
			"When the result says truncated: true, your query matched more than 20 elements — narrow it. " +
			"If nothing matches, the query may be wrong, the element may not be on screen, or the page may " +
			"have changed since your last read — read the page again and retry before concluding it is absent.",
		parameters: Type.Object({ query: Type.String() }),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			return await postJson(
				fetchImpl,
				base,
				"/api/browser/agent-find",
				{ query: params.query },
				signal,
				browserTimeoutMs,
				{
					successText: (parsed) => {
						const hits = parsed?.hits as Array<{ ref: string; line: string }> | undefined;
						const total = parsed?.total ?? 0;
						const truncated = parsed?.truncated ?? false;
						if (!hits || hits.length === 0)
							return `No elements matching "${params.query}" in the current page read.`;
						const lines = hits.map((h) => `  ${h.ref}: ${h.line}`).join("\n");
						const cap = truncated ? ` (showing ${hits.length} of ${total} — narrow your query)` : "";
						return `Found ${total} match${total === 1 ? "" : "es"} for "${params.query}"${cap}:\n${lines}`;
					},
				},
			);
		},
	});

	registerTool({
		name: "browser_get_text",
		label: "Browser Get Text",
		description:
			"Extract the visible text content of the current page (article/main content first, falls back to " +
			"body innerText). Useful when you need raw text rather than the accessibility tree structure. " +
			"Fei holding the wheel does NOT block this (the gate stops acting, not reading). " +
			"Optional maxChars limits the response length. When truncated is true, the text was cut — raise " +
			"maxChars to see more. If the response mentions 'browser not started', ask Fei to open a page first.",
		parameters: Type.Object({ maxChars: Type.Optional(Type.Number()) }),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			const body = params.maxChars === undefined ? {} : { maxChars: params.maxChars };
			return await postJson(fetchImpl, base, "/api/browser/agent-page-text", body, signal, browserTimeoutMs, {
				successText: (parsed) => {
					const truncation = parsed?.truncated ? "\n[truncated — raise maxChars to see more]" : "";
					return `${parsed?.text ?? "(empty page)"}${truncation}`;
				},
			});
		},
	});

	registerTool({
		name: "browser_console",
		label: "Browser Console",
		description:
			"Read captured console output (log, info, warn, error, debug) from the live page. " +
			"Fei holding the wheel does NOT block this (the gate stops acting, not reading). " +
			"Optional filter: 'all' (default), 'error', or 'warn'. " +
			"The response includes droppedUnread — the number of console entries that were evicted from the " +
			"ring buffer before you read them. When droppedUnread > 0, the returned entries are NOT the " +
			"complete log — some were pushed out before you got here. Do not treat a partial buffer as evidence " +
			"that no errors occurred. If the entries array is empty and droppedUnread is 0, the page genuinely " +
			"has no console output of that type.",
		parameters: Type.Object({
			filter: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("error"), Type.Literal("warn")])),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			const body = params.filter ? { filter: params.filter } : {};
			return await postJson(fetchImpl, base, "/api/browser/agent-console", body, signal, browserTimeoutMs, {
				successText: (parsed) => {
					const entries = (parsed?.entries ?? []) as unknown[];
					const dropped = parsed?.droppedUnread ?? 0;
					const dropNote =
						dropped > 0
							? `\n[WARNING: ${dropped} entries were evicted before you read them — this is not the full log]`
							: "";
					if (entries.length === 0) return `No console entries.${dropNote}`;
					return `${entries.length} console entries:\n${JSON.stringify(entries, null, 2)}${dropNote}`;
				},
			});
		},
	});

	registerTool({
		name: "browser_network",
		label: "Browser Network",
		description:
			"Read captured network requests from the live page, or fetch a specific response body by requestId. " +
			"Fei holding the wheel does NOT block this (the gate stops acting, not reading). " +
			"Optional filter: 'all' (default) or 'failed'. Pass requestId to fetch the response body of a " +
			"specific request instead of listing. The listing includes droppedUnread — the number of network " +
			"entries evicted from the ring buffer before you read them. When droppedUnread > 0, the returned " +
			"entries are NOT the complete request log — some were pushed out. Do not treat a partial buffer " +
			"as evidence that no failed requests occurred.",
		parameters: Type.Object({
			filter: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("failed")])),
			requestId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			const body: Record<string, unknown> = {};
			if (params.filter) body.filter = params.filter;
			if (params.requestId) body.requestId = params.requestId;
			return await postJson(fetchImpl, base, "/api/browser/agent-network", body, signal, browserTimeoutMs, {
				successText: (parsed) => {
					// Response body mode
					if (params.requestId) {
						return `Response body for ${params.requestId}:\n${parsed?.body ?? "(empty)"}`;
					}
					// Listing mode
					const entries = (parsed?.entries ?? []) as unknown[];
					const dropped = parsed?.droppedUnread ?? 0;
					const dropNote =
						dropped > 0
							? `\n[WARNING: ${dropped} entries were evicted before you read them — this is not the full request log]`
							: "";
					if (entries.length === 0) return `No network entries.${dropNote}`;
					return `${entries.length} network entries:\n${JSON.stringify(entries, null, 2)}${dropNote}`;
				},
			});
		},
	});

	registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description:
			"Capture a screenshot of the live browser viewport. Returns a base64-encoded PNG image. " +
			"Fei holding the wheel does NOT block this (the gate stops acting, not reading). " +
			"Optional scale (0.1 to 1.0, default 1) reduces the image; optional region " +
			"({ x, y, width, height }) crops to a rectangle. The response includes a frozen flag: when " +
			"frozen is true, Fei has paused the browser feed and the image is a stale frame — do NOT treat " +
			"it as the current page state. If the response mentions 'browser not started', ask Fei to open " +
			"a page first. Do not use this when you only need text or structure — browser_read_page and " +
			"browser_get_text are faster and cheaper for those.",
		parameters: Type.Object({
			scale: Type.Optional(Type.Number()),
			region: Type.Optional(
				Type.Object({
					x: Type.Number(),
					y: Type.Number(),
					width: Type.Number(),
					height: Type.Number(),
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			const body: Record<string, unknown> = {};
			if (params.scale !== undefined) body.scale = params.scale;
			if (params.region !== undefined) body.region = params.region;
			return await postJson(fetchImpl, base, "/api/browser/agent-screenshot", body, signal, browserTimeoutMs, {
				successText: (parsed) => {
					const frozenNote = parsed?.frozen
						? " [FROZEN: Fei paused the feed — this is a stale frame, not the current page]"
						: "";
					return `Screenshot captured (${parsed?.width ?? "?"}x${parsed?.height ?? "?"}).${frozenNote}`;
				},
			});
		},
	});

	registerTool({
		name: "browser_computer",
		label: "Browser Computer",
		description:
			"Low-level mouse and keyboard automation in the live browser. Use this for actions that " +
			"browser_act cannot do: coordinate-based clicks (left/right/double/triple), hover, scrolling, " +
			"key presses with repeat, drag, and wait. For ref-targeted click/type/press/scroll_to, use " +
			"browser_act instead — it is simpler and safer. The act is a ComputerAct union: " +
			"left_click / right_click / double_click / triple_click / hover (with optional modifiers), " +
			"key (text + optional repeat), scroll (direction + optional amount), left_click_drag (with to), " +
			"or wait (with duration up to 10s). Target is { ref } (from browser_read_page) or " +
			"{ coordinate: [x, y] } (viewport pixels) or absent. " +
			"Act-class: gated by the control owner. When Fei holds the wheel or the browser is paused, " +
			"you get control-owner-denied — that is the guardrail working, not a fault. Stop and wait for " +
			"him to hand control back; do not retry. Never use this to type into a password, verification-code, " +
			"payment-confirm, or terms-agreement control — those are Fei's; read the browser-discipline skill " +
			"and ask him to take over.",
		parameters: Type.Object({
			act: Type.Object({
				action: Type.String(),
				text: Type.Optional(Type.String()),
				repeat: Type.Optional(Type.Number()),
				direction: Type.Optional(Type.String()),
				amount: Type.Optional(Type.Number()),
				modifiers: Type.Optional(Type.String()),
				to: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() })),
				duration: Type.Optional(Type.Number()),
			}),
			target: Type.Optional(
				Type.Union([
					Type.Object({ ref: Type.String() }),
					Type.Object({
						// Not Type.Tuple. It emits the draft-07 spelling of a tuple,
						// `items: [ ... ]`, and the provider validates tool schemas as
						// 2020-12, where a tuple is `prefixItems` and an array-valued
						// `items` is a hard error. Every request carries every tool's
						// schema, so one bad shape here is rejected before the model sees
						// the call — measured 2026-09-09: she could not take a single turn
						// for the three days this stood. Unsafe keeps the [x, y] type on
						// the TypeScript side while emitting a shape both drafts accept.
						coordinate: Type.Unsafe<[number, number]>({
							type: "array",
							items: { type: "number" },
							minItems: 2,
							maxItems: 2,
						}),
					}),
				]),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			const body: Record<string, unknown> = { act: params.act };
			if (params.target !== undefined) body.target = params.target;
			return await postJson(fetchImpl, base, "/api/browser/agent-computer", body, signal, browserTimeoutMs, {
				successText: () =>
					"Action applied. Call browser_read_page or browser_screenshot to see what it actually did.",
				controlOwnerDeniedText: () =>
					"Control is with Fei right now (or the browser is paused) — the gate is doing its job, " +
					"this is not a failure to retry. Stop here and wait for him to hand control back.",
			});
		},
	});

	registerTool({
		name: "browser_form_input",
		label: "Browser Form Input",
		description:
			"Set the value of a form element (input, textarea, select, checkbox, contenteditable) " +
			"identified by a ref from browser_read_page. Pass the ref and the value to set. For checkboxes " +
			"use a boolean, for selects use the option value or text, for other inputs use a string or number. " +
			"Act-class: gated by the control owner. When Fei holds the wheel or the browser is paused, " +
			"you get control-owner-denied — that is the guardrail working, not a fault. Stop and wait for " +
			"him to hand control back; do not retry. Never use this on a password, verification-code, " +
			"payment-confirm, or terms-agreement control — those are Fei's; read the browser-discipline skill " +
			"and ask him to take over. If the ref is stale (the element left the DOM), you get stale-ref — " +
			"call browser_read_page again and use a fresh ref.",
		parameters: Type.Object({
			ref: Type.String(),
			value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			return await postJson(
				fetchImpl,
				base,
				"/api/browser/agent-form-input",
				{ ref: params.ref, value: params.value },
				signal,
				browserTimeoutMs,
				{
					successText: (parsed) => `Value set on ${parsed?.ref ?? params.ref}. Call browser_read_page to verify.`,
					controlOwnerDeniedText: () =>
						"Control is with Fei right now (or the browser is paused) — the gate is doing its job, " +
						"this is not a failure to retry. Stop here and wait for him to hand control back.",
					errorTexts: {
						"stale-ref": (parsed) =>
							`${errorLine(parsed)} That ref is stale — the element left the DOM. Call browser_read_page ` +
							"again and use a fresh ref.",
						"unknown-ref": (parsed) =>
							`${errorLine(parsed)} No such element in the current read. Call browser_read_page again.`,
						"invalid-ref": (parsed) => `${errorLine(parsed)} A ref must be one browser_read_page handed you.`,
					},
				},
			);
		},
	});

	registerTool({
		name: "browser_eval",
		label: "Browser Eval",
		description:
			"Execute JavaScript in the live page context. The code runs with REPL semantics: write the " +
			"expression you want and its value is returned — do NOT write 'return'. Top-level await works. " +
			"The default timeout is 45 seconds; pass timeoutMs to override. This can change the page as " +
			"freely as a click, so it is act-class. When Fei holds the wheel or the browser is paused, " +
			"you get control-owner-denied — that is the guardrail working, not a fault. Stop and wait for " +
			"him to hand control back; do not retry. Use this for debugging and data extraction only — " +
			"do not implement UI changes via eval; edit source code instead. If the result mentions " +
			"'browser not started', ask Fei to open a page first.",
		parameters: Type.Object({
			code: Type.String(),
			timeoutMs: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			const body: Record<string, unknown> = { code: params.code };
			if (params.timeoutMs !== undefined) body.timeoutMs = params.timeoutMs;
			return await postJson(fetchImpl, base, "/api/browser/agent-eval", body, signal, browserTimeoutMs, {
				successText: (parsed) => {
					const val = parsed?.value;
					if (val === undefined) return "(undefined)";
					try {
						return typeof val === "string" ? val : JSON.stringify(val, null, 2);
					} catch {
						return String(val);
					}
				},
				controlOwnerDeniedText: () =>
					"Control is with Fei right now (or the browser is paused) — the gate is doing its job, " +
					"this is not a failure to retry. Stop here and wait for him to hand control back.",
			});
		},
	});

	registerTool({
		name: "browser_viewport",
		label: "Browser Viewport",
		description:
			"Change the viewport size and/or colour-scheme emulation of the live browser. This changes what " +
			"Fei is looking at, so it is act-class. Use preset 'mobile' (375x812), 'tablet' (768x1024), or " +
			"'desktop' (clears size emulation, returns to the pane's own responsive size). For custom sizes " +
			"pass both width and height. colorScheme ('light' or 'dark') emulates prefers-color-scheme. " +
			"When Fei holds the wheel or the browser is paused, you get control-owner-denied — that is the " +
			"guardrail working, not a fault. Stop and wait for him to hand control back; do not retry. " +
			"Reset to preset 'desktop' when you are done testing responsive layouts — leaving a mobile " +
			"emulation on would change Fei's view without him expecting it.",
		parameters: Type.Object({
			preset: Type.Optional(Type.Union([Type.Literal("mobile"), Type.Literal("tablet"), Type.Literal("desktop")])),
			width: Type.Optional(Type.Number()),
			height: Type.Optional(Type.Number()),
			colorScheme: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")])),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			const body: Record<string, unknown> = {};
			if (params.preset !== undefined) body.preset = params.preset;
			if (params.width !== undefined) body.width = params.width;
			if (params.height !== undefined) body.height = params.height;
			if (params.colorScheme !== undefined) body.colorScheme = params.colorScheme;
			return await postJson(fetchImpl, base, "/api/browser/agent-viewport", body, signal, browserTimeoutMs, {
				successText: (parsed) => {
					const s = parsed?.state as Record<string, unknown> | undefined;
					if (!s) return "Viewport updated.";
					const size = s.width != null ? `${s.width}x${s.height}` : "responsive (no emulation)";
					const scheme = s.colorScheme ? ` (${s.colorScheme})` : "";
					return `Viewport: ${size}${scheme}${s.mobile ? " (mobile)" : ""}`;
				},
				controlOwnerDeniedText: () =>
					"Control is with Fei right now (or the browser is paused) — the gate is doing its job, " +
					"this is not a failure to retry. Stop here and wait for him to hand control back.",
			});
		},
	});

	registerTool({
		name: "browser_history",
		label: "Browser History",
		description:
			"Navigate back or forward in the browser's session history. Pass direction 'back' or 'forward'. " +
			"A 'no-entry' response means there is nothing to go back/forward to — that is a normal answer, " +
			"not a failure. Act-class: gated by the control owner. When Fei holds the wheel or the browser " +
			"is paused, you get control-owner-denied — that is the guardrail working, not a fault. Stop and " +
			"wait for him to hand control back; do not retry. After a successful history navigation, all " +
			"refs from previous reads are invalidated (the page changed) — call browser_read_page to get " +
			"fresh refs.",
		parameters: Type.Object({
			direction: Type.Union([Type.Literal("back"), Type.Literal("forward")]),
		}),
		async execute(_toolCallId, params, signal) {
			const base = uiBase();
			return await postJson(
				fetchImpl,
				base,
				"/api/browser/agent-history",
				{ direction: params.direction },
				signal,
				browserTimeoutMs,
				{
					successText: (parsed) =>
						`Navigated ${params.direction} to ${parsed?.url ?? "(unknown)"}. Refs from previous reads are ` +
						"now invalid — call browser_read_page to get fresh refs.",
					controlOwnerDeniedText: () =>
						"Control is with Fei right now (or the browser is paused) — the gate is doing its job, " +
						"this is not a failure to retry. Stop here and wait for him to hand control back.",
				},
			);
		},
	});

	registerTool({
		name: "browser_batch",
		label: "Browser Batch",
		description:
			"Run several registered browser tools in one call, in order. Use this when the steps are " +
			"predictable and you do not need to see an intermediate result before deciding the next " +
			"step — for example navigate to a known URL, then read the page, then click a ref you " +
			"already know will be there. Do NOT use this when the next step depends on what the " +
			"previous step showed: do not guess a chain; call the tools one at a time so you can " +
			"read the result before choosing. Actions run strictly in sequence, never in parallel " +
			"(there is only one browser; overlapping actions would race). Stops at the first " +
			"failure: the return lists completed steps, the failed step with its original error, " +
			"and the names of steps that were not run. Nested browser_batch is rejected before any " +
			"step runs. Unknown tool names are rejected before any step runs (the unknown name is " +
			"named in the error). actions must be non-empty and at most 20 steps. Each action's " +
			"input is passed through to that tool unchanged — this tool does not pick or rewrite " +
			"parameters. Allowed names: browser_navigate, browser_read_page, browser_act, " +
			"browser_find, browser_get_text, browser_console, browser_network, browser_screenshot, " +
			"browser_computer, browser_form_input, browser_eval, browser_viewport, browser_history. " +
			"If a step returns control-owner-denied, that is the control-owner gate working, not a " +
			"fault: Fei currently holds the wheel (or the browser is paused). Stop and wait for him " +
			"to hand control back — do not retry the batch.",
		parameters: Type.Object({
			actions: Type.Array(
				Type.Object({
					name: Type.String(),
					input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const actions = params.actions;
			if (actions.length === 0) {
				return textResult("browser_batch rejected: actions is empty. Pass at least one step.");
			}
			if (actions.length > BROWSER_BATCH_MAX_STEPS) {
				return textResult(
					`browser_batch rejected: ${actions.length} steps exceeds the ${BROWSER_BATCH_MAX_STEPS}-step limit.`,
				);
			}
			if (actions.some((action) => action.name === "browser_batch")) {
				return textResult(
					"browser_batch rejected: nested browser_batch is not allowed. Flatten the steps into a single batch.",
				);
			}
			const unknownNames = [
				...new Set(
					actions.map((action) => action.name).filter((name) => !BATCHABLE_BROWSER_TOOL_NAME_SET.has(name)),
				),
			];
			if (unknownNames.length > 0) {
				return textResult(
					`browser_batch rejected: unknown tool name${unknownNames.length === 1 ? "" : "s"}: ${unknownNames.join(", ")}. ` +
						`Allowed: ${BATCHABLE_BROWSER_TOOL_NAMES.join(", ")}.`,
				);
			}

			const total = actions.length;
			const lines: string[] = [];
			for (let i = 0; i < actions.length; i++) {
				const action = actions[i];
				const tool = batchableBrowserTools.get(action.name);
				if (!tool) {
					return textResult(`browser_batch rejected: unknown tool name: ${action.name}.`);
				}
				const result = (await tool.execute(
					_toolCallId,
					(action.input ?? {}) as never,
					signal,
					undefined,
					undefined as never,
				)) as {
					content: Array<{ type?: string; text?: string }>;
					details?: { status?: unknown; controlOwnerDenied?: unknown };
				};
				const stepText = result.content[0]?.text ?? "";
				const denied = result.details?.controlOwnerDenied === true;
				if (!denied && batchStepSucceeded(result.details)) {
					lines.push(`step ${i + 1}/${total}  ${action.name}   ok`);
					continue;
				}
				const reason = denied ? "control-owner-denied" : batchFailureReason(stepText);
				lines.push(`step ${i + 1}/${total}  ${action.name}   FAILED — ${reason}`);
				if (stepText.trim()) lines.push(stepText);
				const leftover = actions.slice(i + 1).map((next) => next.name);
				if (denied) {
					const leftoverNote = leftover.length > 0 ? ` Remaining steps were not run: ${leftover.join(", ")}.` : "";
					lines.push(
						`          (Fei took the wheel; this is the control-owner gate working, not a fault. ` +
							`Stop and wait for him to hand control back — do not retry the batch.${leftoverNote})`,
					);
				} else if (leftover.length > 0) {
					const verb = leftover.length === 1 ? "was" : "were";
					lines.push(`          (${leftover.join(", ")} ${verb} not run)`);
				}
				break;
			}
			return textResult(lines.join("\n"));
		},
	});

	registerTool({
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

	registerTool({
		name: "design_lab_open",
		label: "Design Lab Open",
		description:
			`Open the her design-lab canvas in Fei's Studio live browser pane at ${DESIGN_LAB_URL}. ` +
			`Probes port ${DESIGN_LAB_PORT} and reuses a running lab; otherwise starts it detached via a nested cmd start. ` +
			"Ready in a log is not success — the port must be listening. Opens the pane directly, no " +
			"handback needed: the destination is fixed to the design lab and the tool takes no parameters, " +
			"so it cannot steer the pane anywhere else. All other browser driving stays gated.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			const ready = await ensureDesignLabReady({ ...deps.designLab, signal });
			if (!ready.ok) {
				return textResult(`failed: ${ready.reason}`, { status: "failed", reason: ready.reason });
			}
			const base = resolveStudioUiBase();
			// Human-path navigate on purpose (Fei 2026-08-31: the canvas pops open
			// without a handback). The exception is safe because DESIGN_LAB_URL is a
			// fixed constant and the tool takes no parameters — it cannot steer the
			// pane anywhere else. Every other browser tool stays behind the
			// control-owner gate.
			const nav = await postJson(
				fetchImpl,
				base,
				"/api/browser/navigate",
				{ url: DESIGN_LAB_URL },
				signal,
				browserTimeoutMs,
				{ successText: () => `Navigated to ${DESIGN_LAB_URL}` },
			);
			const navText = nav.content[0]?.text ?? "";
			if (navText.startsWith(`Navigated to ${DESIGN_LAB_URL}`)) {
				const text =
					ready.status === "already-running"
						? `already-running: Design lab already listening on ${DESIGN_LAB_URL}. ${navText}`
						: `opened: Design lab opened at ${DESIGN_LAB_URL}`;
				return textResult(text, { status: ready.status });
			}
			return {
				content: nav.content,
				details: { ...nav.details, status: "failed" as const },
			};
		},
	});
}

function batchStepSucceeded(details: { status?: unknown } | undefined): boolean {
	return typeof details?.status === "number" && details.status >= 200 && details.status < 300;
}

function isControlOwnerDeniedText(text: string): boolean {
	return /control-owner-denied|control is with Fei|gate is doing its job/i.test(text);
}

function batchFailureReason(text: string): string {
	if (isControlOwnerDeniedText(text)) return "control-owner-denied";
	const first = text.trim().split(/\r?\n/, 1)[0] ?? text;
	return first;
}

function uiBase(): string {
	return process.env.HER_UI_BASE_URL ?? DEFAULT_UI_BASE_URL;
}

/** Same path and control-owner gate as browser_navigate. */
async function navigateStudioBrowser(
	fetchImpl: typeof fetch,
	base: string,
	url: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
) {
	return await postJson(fetchImpl, base, "/api/browser/agent-navigate", { url }, signal, timeoutMs, {
		successText: () => `Navigated to ${url}`,
		controlOwnerDeniedText: () =>
			"Navigation denied: control is with Fei right now. Ask him to hand control back (handback), then try again.",
	});
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
		`(${parsed?.refCount ?? 0} refs). Act on a [ref_N] below with browser_act or browser_computer; refs ` +
		"stay valid as long as the element is in the DOM.";
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
	if (parsed?.error === "control-owner-denied" || parsed?.reason === "control-owner-denied") {
		// Flag it structurally, not in prose. `browser_batch` decides "stop, and say
		// it was the guardrail" from this field; deriving that by regex over the
		// text meant any tool rewording its refusal silently fell out of the branch,
		// and nothing would have reported the loss. The default below also covers
		// tools that never supplied their own wording.
		return textResult(
			opts.controlOwnerDeniedText?.() ??
				"Refused: Fei holds the wheel (control-owner-denied). That is the gate working, not a fault — " +
					"stop and wait for him to hand control back instead of retrying.",
			{ controlOwnerDenied: true },
		);
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
