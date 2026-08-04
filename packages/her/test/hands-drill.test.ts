import assert from "node:assert/strict";
import test from "node:test";
import { type DrillWindow, pickDrillTarget, shouldAutoConfirm } from "../tools/hands-l2-drill-target.ts";

// 2026-08-03 live fire: the drill's name/title match picked a pre-existing Notepad holding
// Fei's real file (TAPIX...). The drill may only ever touch the window of the pid it spawned.
test("T24 drill target lock: a same-named foreign Notepad is never selected", () => {
	const foreign: DrillWindow = {
		pid: 33056,
		window_id: 101,
		app_name: "Notepad.exe",
		title: "TAPIX软件功能优化7.29.txt - Notepad",
	};
	const own: DrillWindow = { pid: 41000, window_id: 102, app_name: "notepad.exe", title: "Untitled - Notepad" };

	assert.deepEqual(pickDrillTarget([foreign, own], 41000), own);
	// The spawned pid has no window (relaunch, crash, store-notepad handoff): the picker must
	// come back empty so the drill fails loud - never fall back to the foreign window.
	assert.equal(pickDrillTarget([foreign], 41000), undefined);
	assert.equal(pickDrillTarget([], 41000), undefined);
	assert.equal(pickDrillTarget([foreign, own], undefined), undefined);
	// Pid recycled onto a non-Notepad window (the L2 allowlist holds more than Notepad):
	// pid match alone must not be trusted - fail loud instead.
	const recycled: DrillWindow = { pid: 41000, window_id: 103, app_name: "applicationframehost.exe", title: "Files" };
	assert.equal(pickDrillTarget([foreign, recycled], 41000), undefined);
});

// HER_HANDS_DRILL_CONFIRM=1 once auto-approved a dialog while the target had resolved to a
// foreign window. Auto-confirm may only nod when the dialog's target line names the window
// the drill spawned; everything else is answered "no".
test("T25 drill auto-confirm only nods when the dialog names the drill-owned window", () => {
	const ownTitle = "Untitled - Notepad";
	const ownDialog = `target window: notepad.exe — ${ownTitle}\n1. type_text: Her hands L2 drill`;
	const foreignDialog =
		"target window: notepad.exe — TAPIX软件功能优化7.29.txt - Notepad\n1. type_text: Her hands L2 drill";

	assert.equal(shouldAutoConfirm(true, ownDialog, ownTitle), true);
	assert.equal(shouldAutoConfirm(true, foreignDialog, ownTitle), false);
	assert.equal(shouldAutoConfirm(false, ownDialog, ownTitle), false);
	assert.equal(shouldAutoConfirm(true, ownDialog, undefined), false);
	assert.equal(shouldAutoConfirm(true, ownDialog, ""), false);
	// The owned title showing up in the payload half must not count - only the target line speaks.
	const sneaky = `target window: notepad.exe — 机密预算.txt - Notepad\n1. type_text: ${ownTitle}`;
	assert.equal(shouldAutoConfirm(true, sneaky, ownTitle), false);
});
