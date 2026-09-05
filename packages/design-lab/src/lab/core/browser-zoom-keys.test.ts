import { describe, expect, it } from "vitest";
import { dispatchLabKey } from "./keyboard-dispatch";

/**
 * Ctrl/Cmd + = / - / 0 are the browser's page-zoom shortcuts. If the lab
 * lets them through, Chrome scales the whole page -- HUD, notes, everything.
 * That is what happened after selecting a note: its text takes focus, the
 * typing gate swallowed every shortcut, and Ctrl+- zoomed the browser.
 */

const base = {
	shiftKey: false,
	ctrlKey: false,
	metaKey: false,
	altKey: false,
};

const ctx = (over: Partial<Parameters<typeof dispatchLabKey>[1]> = {}) => ({
	mode: "explore" as const,
	selectedId: null,
	focusedId: null,
	hasScreens: true,
	isTypingTarget: false,
	...over,
});

const typing = () => ctx({ isTypingTarget: true });

describe("browser zoom keys while typing in a note", () => {
	it("ctrl+= zooms the canvas in, not the browser", () => {
		expect(
			dispatchLabKey({ ...base, key: "=", code: "Equal", ctrlKey: true }, typing()),
		).toEqual({ action: "zoom-step", direction: 1 });
	});

	it("ctrl+- zooms the canvas out, not the browser", () => {
		expect(
			dispatchLabKey({ ...base, key: "-", code: "Minus", ctrlKey: true }, typing()),
		).toEqual({ action: "zoom-step", direction: -1 });
	});

	it("ctrl+0 goes to 100%, not the browser's reset", () => {
		expect(
			dispatchLabKey({ ...base, key: "0", code: "Digit0", ctrlKey: true }, typing()),
		).toEqual({ action: "zoom-100" });
	});

	it("cmd works the same as ctrl", () => {
		expect(
			dispatchLabKey({ ...base, key: "=", code: "Equal", metaKey: true }, typing()),
		).toEqual({ action: "zoom-step", direction: 1 });
	});

	it("ctrl+shift+= (the '+' key on US layouts) is still zoom in", () => {
		expect(
			dispatchLabKey(
				{ ...base, key: "+", code: "Equal", ctrlKey: true, shiftKey: true },
				typing(),
			),
		).toEqual({ action: "zoom-step", direction: 1 });
	});

	it("a bare = or - while typing is still typing", () => {
		// The gate must keep doing its job for ordinary keys: you can type an
		// equals sign or a hyphen into a note.
		expect(dispatchLabKey({ ...base, key: "=", code: "Equal" }, typing())).toBeNull();
		expect(dispatchLabKey({ ...base, key: "-", code: "Minus" }, typing())).toBeNull();
		expect(dispatchLabKey({ ...base, key: "0", code: "Digit0" }, typing())).toBeNull();
	});

	it("ctrl+alt+= is not a zoom chord and is left alone", () => {
		expect(
			dispatchLabKey(
				{ ...base, key: "=", code: "Equal", ctrlKey: true, altKey: true },
				typing(),
			),
		).toBeNull();
	});
});

describe("browser zoom keys in the locked modes", () => {
	it("focus mode: ctrl+- still steps the zoom", () => {
		expect(
			dispatchLabKey(
				{ ...base, key: "-", code: "Minus", ctrlKey: true },
				ctx({ mode: "focus", focusedId: "a", isTypingTarget: true }),
			),
		).toEqual({ action: "zoom-step", direction: -1 });
	});

	it("fill mode: a zoom key backs out of fill, like a ctrl+wheel pinch", () => {
		// Before, this fell through to null in fill and the browser zoomed.
		expect(
			dispatchLabKey(
				{ ...base, key: "=", code: "Equal", ctrlKey: true },
				ctx({ mode: "fill", focusedId: "a" }),
			),
		).toEqual({ action: "exit-one" });
	});

	it("focus mode: ctrl+0 backs out to the canvas", () => {
		expect(
			dispatchLabKey(
				{ ...base, key: "0", code: "Digit0", ctrlKey: true },
				ctx({ mode: "focus", focusedId: "a" }),
			),
		).toEqual({ action: "exit-one" });
	});
});

describe("plain zoom keys are unchanged", () => {
	it("= and - on the canvas still step the zoom without a modifier", () => {
		expect(dispatchLabKey({ ...base, key: "=", code: "Equal" }, ctx())).toEqual({
			action: "zoom-step",
			direction: 1,
		});
		expect(dispatchLabKey({ ...base, key: "-", code: "Minus" }, ctx())).toEqual({
			action: "zoom-step",
			direction: -1,
		});
	});
});
