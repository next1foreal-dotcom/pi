// Pinned from cua-driver 0.33.3 describe; session and file output are host-owned.
export const nativeSchemas = {
	list_windows: {
		description:
			'List every top-level window currently known to the window manager. Each record self-contains its owning app identity so the caller never has to join back against list_apps.\n\nUse this — not list_apps — for any window-level reasoning: "does this app have a visible window right now?", "which of this pid\'s windows is the main one?".\n\nPer-record fields: window_id (HWND), pid + app_name, title, bounds {x, y, width, height}, layer (always 0), z_index (integer or null; higher values are closer to the front; null means stacking order is unavailable and callers must not infer one), is_on_screen, minimized. To select a frontmost candidate, take the maximum integer z_index; if every value is null, use an explicit fallback instead of relying on array order. The macOS-specific on_current_space / space_ids fields are omitted on Windows; current_space_id is null.\n\nInputs: pid (optional pid filter), on_screen_only (bool, default false).',
		schema: {
			additionalProperties: false,
			properties: {
				on_screen_only: {
					description: "When true, drop windows that aren't currently on-screen. Default false.",
					type: "boolean",
				},
				pid: {
					description: "Optional pid filter. When set, only this pid's windows are returned.",
					type: "integer",
				},
			},
			type: "object",
		},
	},
	get_window_state: {
		description:
			"Walk a running app's UIA tree and return BOTH a structured `elements` array (preferred) AND a Markdown rendering of the same tree (back-compat). Every actionable element is tagged with [element_index N] in the markdown and as `element_index` in the structured array; pass each element's `element_token` to `click`, `type_text`, `scroll`, etc.\n\nINVARIANT: call `get_window_state` once per turn per (pid, window_id) before any element action against that window. The next snapshot of the same (pid, window_id) replaces this one, stales its element tokens, and lists the replaced ids in `invalidated_snapshot_ids`.\n\nPREFERRED CONSUMERS read `structuredContent.elements` (one entry per indexed row with `element_index`, `role`, `label`, `value`, `enabled`, `selected`, `actions` (names of UIA patterns exposed as actions, omitted when empty), `frame: {x,y,w,h}`, `parent_index`, `depth`). The markdown `tree_markdown` stays available and unchanged in shape for existing text-parsing callers — but new fields will only be added to the structured side.\n\nThe UIA tree walked is the window's tree (HWND-scoped); the screenshot and window bounds reported come from the same `window_id`. This is the source of truth for which window the caller intends to reason about — the driver never picks a window implicitly.\n\n`window_id` MUST belong to `pid`; the call returns `isError: true` otherwise. The driver does not auto-fall-back to a different window.\n\nSet `query` to a case-insensitive substring to project BOTH `tree_markdown` and `structuredContent.elements` to matching rows plus their ancestor chain. Original element indices are preserved. `total_element_count` reports the complete snapshot; `returned_element_count` reports the projection.\n\nAlways returns BOTH the element tree AND a screenshot — ground on both and cross-check (the tree lies on some surfaces). Choose the modality at ACTION time: an element ax action (element_token → accessibility rung) or an element px action (x,y → pixel rung off this screenshot). capture_mode is deprecated and ignored.\n\nThe mirror image: pass `include_accessibility_tree:false` to SKIP the UIA walk entirely and return just the screenshot plus window metadata (window_bounds, app_name, window_title) — the capture-only path for a live window preview / picture-in-picture. Setting BOTH `include_accessibility_tree:false` and `include_screenshot:false` is an error. Optional `max_image_dimension` overrides the configured screenshot long-edge limit for this call; pass 0 for native resolution. Legacy `max_dimension` remains a cap on the configured limit.\n\nUses `IUIAutomationCacheRequest` to batch-fetch all element properties in a single COM call (Chrome's ~5000-element tree returns in ~2-3s instead of timing out at 4s with per-property RPCs).\n\nOptional `max_elements` / `max_depth` bound the UIA walk to mitigate context-window blow-up on Electron / large web apps that produce 10k+ element trees. When applied, BOTH the markdown and the structured elements are truncated identically. Omit both for current default behaviour (≤5 000 elements, depth ≤25).\n\nCHROMIUM COVERAGE: a browser-owned permission bubble can be composited outside the requested native window. Chromium-family snapshots therefore describe this limit in structuredContent.capture_coverage. After a verified ineffective window action, call escalate_session, take a fresh get_desktop_state snapshot, act explicitly in desktop scope if needed, then verify with another fresh desktop snapshot. This is separate from page JavaScript dialogs, which remain on browser_dialog.\n\nWindows requires no special permissions.",
		schema: {
			additionalProperties: false,
			properties: {
				capture_mode: {
					description:
						'DEPRECATED and ignored. get_window_state always returns BOTH the element tree and a screenshot — ground on both. The modality is chosen at action time by how you address the target: an element ax action (element_token) or an element px action (x,y). Any value (including the old "som"/"screenshot" aliases) is accepted but has no effect.',
					enum: ["ax", "vision"],
					type: "string",
				},
				include_accessibility_tree: {
					description:
						"Default true — walk the UIA tree and return `elements` + `tree_markdown` alongside the screenshot. Set false to SKIP the UIA walk entirely and return just the screenshot plus window metadata (window_bounds, app_name, window_title) — the capture-only path for a live window preview / picture-in-picture. Mirrors include_screenshot. Setting BOTH include_accessibility_tree:false AND include_screenshot:false is an error (nothing to return).",
					type: "boolean",
				},
				include_screenshot: {
					description:
						"Default true — returns a grounding screenshot alongside the tree. Set false to skip the grab and return tree only (the cheap path for re-indexing before an element ax action).",
					type: "boolean",
				},
				max_depth: {
					description:
						"Cap on the UIA-tree walk depth. Nodes whose rendered indent would exceed this are omitted. Omit for the default (25). Lower for deep menu / Electron trees.",
					minimum: 1,
					type: "integer",
				},
				max_dimension: {
					description:
						"Legacy optional cap on the returned screenshot's long edge, in pixels (aspect ratio preserved). Applied on top of the configured max_image_dimension ceiling when max_image_dimension is omitted; the tighter wins.",
					minimum: 1,
					type: "integer",
				},
				max_elements: {
					description:
						"Cap on the total number of UIA nodes walked. Truncates depth-first; markdown and structured elements truncate together. Omit for the default (5 000). Lower for Electron / large web apps that produce 10k+ element trees.",
					minimum: 1,
					type: "integer",
				},
				max_image_dimension: {
					description:
						"Per-call long-edge limit for the returned screenshot, in pixels (aspect ratio preserved). Explicit values override configured behavior; 0 returns native resolution. Omit to preserve the configured default.",
					minimum: 0,
					type: "integer",
				},
				pid: {
					description: "Process ID from `list_apps`.",
					type: "integer",
				},
				query: {
					description:
						"Optional case-insensitive substring. Projects both tree_markdown and structured elements to matches plus ancestors while preserving original indices. Compare total_element_count with returned_element_count.",
					type: "string",
				},
				timeout_ms: {
					default: 1000,
					description:
						"Wall-clock budget in milliseconds for the accessibility-tree walk (default 1000, min 100, max 120000). Bounds the WHOLE walk. When the budget runs out the tool returns the PARTIAL tree it has, flagged with `truncated: true`, `truncation_reason`, `nodes_visited`, `nodes_pending` and `elements_complete: false`; retry with a larger value (e.g. 5000) or narrow with `query` / `max_depth`.",
					maximum: 120000,
					minimum: 100,
					type: "integer",
				},
				window_id: {
					description:
						"HWND of the target window. Must belong to `pid`. Enumerate via `list_windows` or read from `launch_app`'s `windows` array.",
					type: "integer",
				},
			},
			required: ["pid", "window_id"],
			type: "object",
		},
	},
	verify_state: {
		description:
			"Deterministically verify bounded predicates against one exact window. The driver evaluates structured window/accessibility state and may return the final screenshot as uninterpreted visual evidence for a multimodal caller. Predicate results are satisfied, unsatisfied, or unknown; unknown never implies success. Accessibility projections are conservative: absence remains unknown unless the observed search domain is proven exhaustive.",
		schema: {
			additionalProperties: false,
			properties: {
				expect: {
					description: "One to eight predicates, combined with logical AND.",
					items: {
						additionalProperties: false,
						properties: {
							element: {
								additionalProperties: false,
								properties: {
									enabled: {
										type: ["boolean", "null"],
									},
									exists: {
										description:
											"Assert that at least one trusted element matches the selector.\n\nElement walks are not yet exhaustive on every platform, so absence\ncannot be proven. `false` is rejected instead of returning an\nindefinitely-unknown predicate.",
										type: "boolean",
									},
									selected: {
										type: ["boolean", "null"],
									},
									selector: {
										additionalProperties: false,
										properties: {
											label_contains: {
												minLength: 1,
												type: "string",
											},
											role: {
												minLength: 1,
												type: "string",
											},
										},
										required: [],
										type: "object",
									},
									value_equals: {
										type: ["string", "null"],
									},
								},
								required: ["selector"],
								type: ["object", "null"],
							},
							window: {
								additionalProperties: false,
								properties: {
									bounds: {
										additionalProperties: false,
										properties: {
											height: {
												type: "number",
											},
											tolerance_px: {
												maximum: 100,
												minimum: 0,
												type: "number",
											},
											width: {
												type: "number",
											},
											x: {
												type: "number",
											},
											y: {
												type: "number",
											},
										},
										required: ["x", "y", "width", "height"],
										type: ["object", "null"],
									},
									exists: {
										type: ["boolean", "null"],
									},
								},
								type: ["object", "null"],
							},
						},
						required: [],
						type: "object",
					},
					maxItems: 8,
					minItems: 1,
					type: "array",
				},
				include_screenshot: {
					description:
						"Return the final window screenshot as image content for a multimodal\ncaller. The driver does not interpret that image.",
					type: ["boolean", "null"],
				},
				pid: {
					description: "Exact process whose window may be observed.",
					minimum: 1,
					type: "integer",
				},
				stable_samples: {
					default: 2,
					description: "Consecutive satisfied samples required before returning success.",
					maximum: 5,
					minimum: 1,
					type: "integer",
				},
				timeout_ms: {
					default: 5000,
					description: "Bounded wait. Zero performs one sample.",
					maximum: 10000,
					minimum: 0,
					type: "integer",
				},
				window_id: {
					description: "Exact native window identifier.",
					type: "integer",
				},
			},
			required: ["pid", "window_id", "expect"],
			type: "object",
		},
	},
} as const;
