import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const BROWSER_TAB_TOOL_NAMES = [
	"browser_tabs_context",
	"browser_tabs_create",
	"browser_tabs_select",
	"browser_tabs_close",
] as const;

type TabRequest = (
	body: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}>;

/** Reuse the host's tab lifecycle and co-drive gate; never transfer control here. */
export function registerBrowserTabTools(pi: Pick<ExtensionAPI, "registerTool">, request: TabRequest): void {
	pi.registerTool({
		name: "browser_tabs_context",
		label: "Browser Tabs Context",
		description:
			"List browser tabs with their IDs, URLs, titles and activeTabId. Read-only: available while Fei holds control or the browser is paused. Use the returned tabId explicitly in subsequent reads and actions; refs belong to that tab and may collide across tabs.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			return request({ action: "context" }, signal);
		},
	});
	pi.registerTool({
		name: "browser_tabs_create",
		label: "Browser Tabs Create",
		description:
			"Create a browser tab at an optional URL (default about:blank). foreground defaults to true; false opens it in the background. Returns tabId and activeTabId. Gated: if Fei holds control or the browser is paused, stop and wait for handback; do not retry. Keep the returned tabId for all work on this tab.",
		parameters: Type.Object({ url: Type.Optional(Type.String()), foreground: Type.Optional(Type.Boolean()) }),
		async execute(_id, params, signal) {
			return request({ action: "create", ...params }, signal);
		},
	});
	for (const action of ["select", "close"] as const) {
		pi.registerTool({
			name: `browser_tabs_${action}`,
			label: action === "select" ? "Browser Tabs Select" : "Browser Tabs Close",
			description:
				(action === "select"
					? "Make an existing tab active and visible in the browser pane. "
					: "Close the specified tab. Close only task-owned tabs or tabs Fei asked you to close. Closing the last tab creates a blank replacement. ") +
				"Use a tabId from browser_tabs_context or browser_tabs_create, never guess. Returns activeTabId. Gated: if Fei holds control or the browser is paused, stop and wait for handback; do not retry. If no-such-tab is returned, list tabs again.",
			parameters: Type.Object({ tabId: Type.String({ minLength: 1 }) }),
			async execute(_id, params, signal) {
				return request({ action, tabId: params.tabId }, signal);
			},
		});
	}
}
