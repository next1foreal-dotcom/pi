export type DesignMode = "discuss" | "build";

/** Returned when discuss mode blocks a tool. `block` is always true — never `{ block: false }`. */
export type DesignToolCallGate = { block: true; reason: string };

/**
 * Silent default must match today: she has the hands that change the product.
 * Switching the default to discuss would quietly disable existing behaviour.
 */
export const DEFAULT_DESIGN_MODE: DesignMode = "build";

let current: DesignMode = DEFAULT_DESIGN_MODE;

export function designMode(): DesignMode {
	return current;
}

export function setDesignMode(mode: DesignMode): void {
	current = mode;
}

/**
 * Tools that change the product (code, canvas, workshop manifests, tokens, assets).
 *
 * This is not the same list as `packages/her/src/lib/governed-tools.ts` `destructive`.
 * That list answers "will this hurt an anchor?" — `design_project_create` is `false` there.
 * This list answers "will this change the product?" The two lists evolve separately.
 * Do not merge them.
 *
 * `bash` / `powershell` are blocked wholesale on purpose: parsing a command line to
 * decide whether it writes is a losing game. Anyone who wants to allow "safe" shells
 * in discuss mode has to beat that, not just drop the names from this set.
 */
export const PRODUCT_MUTATING_TOOLS: ReadonlySet<string> = new Set([
	"edit",
	"write",
	"bash",
	"powershell",
	"design_lab_reply",
	"design_lab_resolve",
	"design_project_create",
	"design_project_set_stage",
	"design_project_gate",
	"design_version_name",
	"design_system_load",
	"design_system_apply",
	"design_asset_shot",
]);

/**
 * `design_*` tools that do not change the product. Paired with
 * `PRODUCT_MUTATING_TOOLS` as the closed classification the drift test enforces.
 * `design_mode` lives here so discuss can still be left.
 */
export const READONLY_DESIGN_TOOLS: ReadonlySet<string> = new Set([
	"design_lab_notes",
	"design_lab_open",
	"design_lab_still",
	"design_project_get",
	"design_project_list",
	"design_project_audit",
	"design_version_list",
	"design_version_show",
	"design_version_since",
	"design_mode",
]);

/**
 * Discuss-mode gate for a single tool call.
 * Build mode (and unknown names) return `undefined` — not `{ block: false }` —
 * so other `tool_call` handlers are not short-circuited.
 * `design_mode` is never blocked; otherwise discuss cannot be left.
 */
export function interceptDesignToolCall(toolName: string): DesignToolCallGate | undefined {
	if (current !== "discuss") return undefined;
	if (toolName === "design_mode") return undefined;
	if (!PRODUCT_MUTATING_TOOLS.has(toolName)) return undefined;
	return {
		block: true,
		reason:
			`Discuss mode is on, so ${toolName} is blocked — it would change the product. ` +
			`Call design_mode with mode "build" when you actually want those hands.`,
	};
}
