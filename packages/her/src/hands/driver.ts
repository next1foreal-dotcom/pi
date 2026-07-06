export const CUA_DRIVER_M0 = {
	version: "0.7.0",
	binary: "cua-driver",
	callCommand: "call",
	callArgShape: "cua-driver call <tool> <json-args>",
	powershellJsonMode: "pipe JSON via stdin on Windows PowerShell 5.1",
	snapshotTool: "get_window_state",
	snapshotRequiredArgs: ["pid", "window_id"],
	actionTools: {
		click: "click",
		doubleClick: "double_click",
		rightClick: "right_click",
		scroll: "scroll",
		typeText: "type_text",
		pressKey: "press_key",
		hotkey: "hotkey",
		drag: "drag",
	},
	defaultDeliveryMode: "background",
	backgroundUnavailableSignal: "background_unavailable",
	notepadSnapshotCommand:
		'\'{"pid":30048,"window_id":25103322,"include_screenshot":false,"max_elements":80}\' | cua-driver call get_window_state',
	evidenceFile: "pi-package/skills/her-hands-desktop/evidence/cua-driver-0.7.0-m0.txt",
} as const;

export type CuaDriverToolName =
	| typeof CUA_DRIVER_M0.snapshotTool
	| (typeof CUA_DRIVER_M0.actionTools)[keyof typeof CUA_DRIVER_M0.actionTools];
