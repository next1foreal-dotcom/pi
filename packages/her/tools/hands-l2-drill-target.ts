// The only window the L2 drill may ever touch is the Notepad it spawned itself, identified
// by pid. 2026-08-03 live fire: a name/title match selected a pre-existing Notepad holding
// Fei's real file. Same-named windows are strangers; a missing pid means fail loud upstream,
// never fall back.
export interface DrillWindow {
	pid: number;
	window_id: number;
	app_name?: string;
	title?: string;
}

export function pickDrillTarget(windows: DrillWindow[], ownedPid: number | undefined): DrillWindow | undefined {
	if (ownedPid === undefined) return undefined;
	// Pid alone is not enough: pids recycle, and the L2 allowlist holds more than Notepad.
	// The drill's window must match BOTH the spawned pid and look like a Notepad window.
	return windows.find((item) => item.pid === ownedPid && /notepad/i.test(item.app_name ?? ""));
}

// HER_HANDS_DRILL_CONFIRM=1 may only approve a dialog whose target line names the window the
// drill spawned (2026-08-03: the env var once auto-approved while the target had resolved to a
// foreign window). Only the first line speaks - the payload half echoing the title must not
// count. Fail closed on a missing title or message.
export function shouldAutoConfirm(
	autoConfirmFlag: boolean,
	dialogMessage: string,
	ownedTitle: string | undefined,
): boolean {
	if (!autoConfirmFlag || !ownedTitle) return false;
	const targetLine = dialogMessage.split("\n")[0] ?? "";
	return targetLine.startsWith("target window: ") && targetLine.includes(ownedTitle);
}
