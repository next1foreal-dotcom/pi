// Generated from cua-driver 0.33.3 describe; host owns session identity.
export const browserSchemas = {
	browser_prepare: {
		description:
			"Explicitly prepare an owned DevTools endpoint for a browser. pid is required for an existing process or existing-profile attachment, and optional only for allow_launch=true with an isolated profile. Existing endpoints are detected without side effects. Acting setup for an isolated profile follows the runtime permission mode and optional capability manifest. It requires allow_launch=true, launches a separate browser, and never copies, modifies, or terminates the requested user profile. Without pid, only a platform-attested system Chrome/Edge installation (or a root-owned package payload on Linux) is eligible; redirects and user-controlled locations fail closed. Existing-profile attachment is explicit and follows the runtime's immutable permission mode: standard requires an explicit --grant existing-profile launch grant or an embedding authorization host, bounded requires a launch-approved exact resource manifest, and unrestricted requires explicit trusted startup risk acceptance. Ordinary MCP transport approval never proves profile authorization. On proven platforms, an authorized request also permits one bounded exact-window setup: open the recognized browser product's fixed remote-debugging page, toggle its uniquely matched per-instance checkbox, prove the PID-owned loopback endpoint, and close the temporary tab. Every visible effect is reported; ambiguity is refused.",
		schema: {
			additionalProperties: false,
			properties: {
				allow_launch: {
					description: "Allow a separate driver-owned isolated Chromium process to be launched (default false).",
					type: "boolean",
				},
				pid: {
					description:
						"Browser process id to prepare. Required except for a driver-owned isolated_new/isolated_named launch with allow_launch=true.",
					type: "integer",
				},
				profile: {
					additionalProperties: false,
					description:
						"Driver-owned isolated Chromium profile to launch with allow_launch=true. mode=isolated_new creates a fresh throwaway profile; mode=isolated_named reuses the named driver-owned profile. Never an existing user profile.",
					properties: {
						mode: { enum: ["isolated_new", "isolated_named"], type: "string" },
						name: {
							description: "Required only for isolated_named; 1-64 path-safe ASCII characters.",
							type: "string",
						},
					},
					required: ["mode"],
					type: "object",
				},
				strategy: {
					additionalProperties: false,
					description:
						"Attach to an already-running browser instead of launching one. kind=existing_profile attaches to the user's running profile at pid/window_id and requires explicit profile authorization.",
					properties: { kind: { enum: ["existing_profile"], type: "string" } },
					required: ["kind"],
					type: "object",
				},
				window_id: {
					description: "Exact native window approval anchor; required for strategy.kind=existing_profile.",
					type: "integer",
				},
			},
			required: [],
			type: "object",
		},
	},
	get_browser_state: {
		description:
			"Read-only browser inspection. Mode 1 (bind): pass pid + window_id of a native browser window to classify it, correlate it to a CDP target (exact-or-refuse), and mint a session-scoped target id plus tab ids. Mode 2 (snapshot): pass target_id + tab_id. The dom_refs_v1 compatibility format returns composed DOM refs. semantic_v2 joins accessibility, DOM, layout, and viewport state; ranks visible content before retained/offscreen state; and returns a semantic outline, typed action refs, content refs, scoped reads, and opaque continuation. Never performs setup — a missing endpoint is a structured browser_requires_setup refusal pointing at browser_prepare.",
		schema: {
			additionalProperties: false,
			properties: {
				continuation: {
					description: "Opaque continuation minted by an earlier semantic_v2 response.",
					type: "string",
				},
				include_screenshot: {
					default: false,
					description:
						"Capture the exact tab viewport as PNG through CDP without selecting the tab or foregrounding its native window. The request refuses if capture cannot be completed.",
					type: "boolean",
				},
				pid: { description: "Native browser process id (bind mode).", type: "integer" },
				query: {
					description: "Read-only semantic match over role, accessible name, and visible text.",
					type: "string",
				},
				scope_ref: {
					description: "Current semantic/content ref whose subtree should be observed.",
					type: "string",
				},
				snapshot_format: {
					description: "Versioned snapshot contract. dom_refs_v1 remains the compatibility default.",
					enum: ["dom_refs_v1", "semantic_v2"],
					type: "string",
				},
				tab_id: { description: "Opaque tab id from get_browser_state (session-scoped).", type: "string" },
				target_id: {
					description: "Opaque browser target id minted by get_browser_state (session-scoped; never a CDP id).",
					type: "string",
				},
				window_id: { description: "Native window id owned by pid (bind mode).", type: "integer" },
			},
			type: "object",
		},
	},
	browser_navigate: {
		description:
			"Navigate one tab of an exactly-bound browser target to a new URL (http/https/about only). Refused for heuristic bindings. Navigation invalidates all p<snapshot>:<index> refs for the tab.",
		schema: {
			additionalProperties: false,
			properties: {
				tab_id: { description: "Opaque tab id from get_browser_state (session-scoped).", type: "string" },
				target_id: {
					description: "Opaque browser target id minted by get_browser_state (session-scoped; never a CDP id).",
					type: "string",
				},
				url: { description: "Destination URL (http:, https:, or about:).", type: "string" },
			},
			required: ["target_id", "tab_id", "url"],
			type: "object",
		},
	},
	browser_click: {
		description:
			'Click a page element (by ref) or viewport coordinates in an exactly-bound tab. Default route is trusted hardware-like input (Input.dispatchMouseEvent), and refuses where that route cannot preserve standalone-browser background posture unless delivery_mode="foreground" accepts that the browser window may activate (Linux Chromium; for example a browser inside a sandbox). input_route="dom_event" (synthetic el.click(), ref required) is used only when explicitly requested; it proves dispatch, not control activation, because trust-gated controls may ignore synthetic events. Refused for heuristic bindings.',
		schema: {
			additionalProperties: false,
			properties: {
				delivery_mode: {
					default: "background",
					description:
						"background (default) refuses trusted input where it would activate the browser window (Linux Chromium). foreground accepts that activation, for a browser whose window nobody else is using (for example inside a sandbox).",
					enum: ["background", "foreground"],
					type: "string",
				},
				input_route: {
					description:
						'"trusted" (default): Input.dispatchMouseEvent. It refuses rather than foregrounding a standalone browser. "dom_event": synthetic full-background DOM click, only when explicitly requested. Dispatch does not prove the control activated; refresh page state and verify the expected postcondition.',
					enum: ["trusted", "dom_event"],
					type: "string",
				},
				ref: {
					description:
						"Page element ref in the p<snapshot>:<index> namespace from get_browser_state. Refs are invalidated by navigation and by newer snapshots of the same tab.",
					type: "string",
				},
				tab_id: { description: "Opaque tab id from get_browser_state (session-scoped).", type: "string" },
				target_id: {
					description: "Opaque browser target id minted by get_browser_state (session-scoped; never a CDP id).",
					type: "string",
				},
				x: { description: "Viewport x (CSS px) — alternative to ref.", type: "number" },
				y: { description: "Viewport y (CSS px) — alternative to ref.", type: "number" },
			},
			required: ["target_id", "tab_id"],
			type: "object",
		},
	},
	browser_type: {
		description:
			'Type text into an exactly-bound tab via the Input domain. mode="insert_text" (default) uses Input.insertText; mode="keystrokes" dispatches per-character key events. Both insert at the caret, so typing into a field that already holds text appends to it; pass replace=true to set the field instead, or to clear it by typing an empty string. Pass a ref to an editable element from the latest snapshot. A ref is required; heuristic bindings are refused.',
		schema: {
			additionalProperties: false,
			properties: {
				mode: {
					description:
						"insert_text (default): bulk Input.insertText. keystrokes: per-character Input.dispatchKeyEvent.",
					enum: ["insert_text", "keystrokes"],
					type: "string",
				},
				ref: {
					description:
						"Page element ref in the p<snapshot>:<index> namespace from get_browser_state. Refs are invalidated by navigation and by newer snapshots of the same tab.",
					type: "string",
				},
				replace: {
					description:
						"false (default): insert at the caret, appending to whatever the field already holds. true: select the element's whole content first so the text replaces it — with an empty text this clears the field. Replacement goes through the selection, so beforeinput/input still fire and framework state stays consistent.",
					type: "boolean",
				},
				tab_id: { description: "Opaque tab id from get_browser_state (session-scoped).", type: "string" },
				target_id: {
					description: "Opaque browser target id minted by get_browser_state (session-scoped; never a CDP id).",
					type: "string",
				},
				text: { description: "Text to type.", type: "string" },
			},
			required: ["target_id", "tab_id", "ref", "text"],
			type: "object",
		},
	},
	browser_pointer: {
		description:
			"Perform hover, right-click, double-click, scroll, or drag in an exactly-bound browser tab. Semantic refs must declare pointer for hover, right-click, double-click, and drag; scroll accepts a scroll or pointer capability. The trusted route uses CDP Input events and refuses if standalone background posture cannot be preserved. The explicit dom_event route requires a page ref and synthesizes full-background DOM events. Never activates or brings a tab to the foreground.",
		schema: {
			additionalProperties: false,
			properties: {
				action: {
					description:
						"Pointer gesture. scroll needs delta_x or delta_y; drag needs destination_ref or to_x/to_y.",
					enum: ["hover", "right_click", "double_click", "scroll", "drag"],
					type: "string",
				},
				delivery_mode: {
					default: "background",
					description:
						"background (default) refuses trusted input where it would activate the browser window (Linux Chromium). foreground accepts that activation, for a browser whose window nobody else is using (for example inside a sandbox).",
					enum: ["background", "foreground"],
					type: "string",
				},
				delta_x: { description: "Horizontal scroll delta in CSS pixels.", type: "number" },
				delta_y: { description: "Vertical scroll delta in CSS pixels.", type: "number" },
				destination_ref: { description: "Drag destination page ref in the exact same frame.", type: "string" },
				input_route: {
					default: "trusted",
					description:
						"trusted sends CDP Input events; dom_event synthesizes DOM events in the page and requires ref.",
					enum: ["trusted", "dom_event"],
					type: "string",
				},
				ref: { description: "Origin page ref. Alternative to x/y.", type: "string" },
				tab_id: { description: "Opaque tab id minted by get_browser_state.", type: "string" },
				target_id: { description: "Opaque target id minted by get_browser_state.", type: "string" },
				to_x: { description: "Drag destination viewport x in CSS pixels.", type: "number" },
				to_y: { description: "Drag destination viewport y in CSS pixels.", type: "number" },
				x: { description: "Origin viewport x in CSS pixels.", type: "number" },
				y: { description: "Origin viewport y in CSS pixels.", type: "number" },
			},
			required: ["target_id", "tab_id", "action"],
			type: "object",
		},
	},
	browser_dialog: {
		description:
			"Inspect or resolve a page-owned JavaScript alert, confirm, prompt, or beforeunload dialog on one exactly-bound tab. This never handles browser permission UI, extension UI, native dialogs, or file pickers. Inspect returns an opaque dialog_id; accept/dismiss require that exact current id. Resolution defaults to background delivery; Linux callers must explicitly request foreground delivery because Chromium's native modal cannot be resolved there without changing foreground posture.",
		schema: {
			additionalProperties: false,
			properties: {
				action: {
					description:
						"inspect returns the current dialog and its dialog_id; accept or dismiss resolves that exact dialog.",
					enum: ["inspect", "accept", "dismiss"],
					type: "string",
				},
				delivery_mode: {
					default: "background",
					description:
						"Requested foreground posture for accept/dismiss. Linux Chromium requires foreground; inspect is read-only.",
					enum: ["background", "foreground"],
					type: "string",
				},
				dialog_id: { description: "Opaque current dialog generation returned by action=inspect.", type: "string" },
				prompt_text: {
					description: "Sensitive response text, valid only when accepting a prompt dialog.",
					type: "string",
				},
				tab_id: { description: "Opaque tab id from get_browser_state (session-scoped).", type: "string" },
				target_id: {
					description: "Opaque browser target id minted by get_browser_state (session-scoped; never a CDP id).",
					type: "string",
				},
			},
			required: ["target_id", "tab_id", "action"],
			type: "object",
		},
	},
	browser_download: {
		description:
			"Trigger one download through an exact live browser ref and save it inside an explicitly approved directory. Requires MCP-host destructive-tool approval, refuses ambiguous or stale capabilities, and never returns the source URL, filename, or destination path.",
		schema: {
			additionalProperties: false,
			properties: {
				destination_root: {
					description: "Absolute, existing, canonical directory approved to receive the download.",
					type: "string",
				},
				ref: { description: "Live page ref whose activation initiates the download.", type: "string" },
				tab_id: { description: "Opaque exact tab id from get_browser_state.", type: "string" },
				target_id: { description: "Opaque exact browser target id from get_browser_state.", type: "string" },
			},
			required: ["target_id", "tab_id", "ref", "destination_root"],
			type: "object",
		},
	},
	browser_set_input_files: {
		description:
			"Assign one or more explicit absolute local files to an exact live <input type=file> ref through CDP. This bypasses native file pickers, rejects symlinks and non-regular files, and never returns local paths.",
		schema: {
			additionalProperties: false,
			properties: {
				files: {
					description: "Absolute paths of 1 to 32 local regular files to assign to the input.",
					items: { description: "Absolute path to one local regular file.", type: "string" },
					maxItems: 32,
					minItems: 1,
					type: "array",
				},
				ref: {
					description:
						"Page element ref in the p<snapshot>:<index> namespace from get_browser_state. Refs are invalidated by navigation and by newer snapshots of the same tab.",
					type: "string",
				},
				tab_id: { description: "Opaque tab id from get_browser_state (session-scoped).", type: "string" },
				target_id: {
					description: "Opaque browser target id minted by get_browser_state (session-scoped; never a CDP id).",
					type: "string",
				},
			},
			required: ["target_id", "tab_id", "ref", "files"],
			type: "object",
		},
	},
} as const;
