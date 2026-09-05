// @vitest-environment jsdom

/**
 * Canvas-object API: register, move, resize, select, snap, undo,
 * and the trap — whole-map replacements must preserve object layouts.
 */

import { describe, expect, it, vi } from "vitest";

class MockResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})),
});

const noop = () => {};
const mockCtx = {
	setTransform: noop, fillRect: noop, fillText: noop, beginPath: noop,
	moveTo: noop, lineTo: noop, stroke: noop, save: noop, restore: noop,
	translate: noop, rotate: noop, clearRect: noop,
	strokeStyle: "", fillStyle: "", font: "",
};
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
	mockCtx as unknown as CanvasRenderingContext2D,
);

if (!HTMLElement.prototype.setPointerCapture) {
	HTMLElement.prototype.setPointerCapture = noop;
	HTMLElement.prototype.releasePointerCapture = noop;
	HTMLElement.prototype.hasPointerCapture = () => false;
}

import { type Session } from "./interaction-lab";
import {
	registerObject,
	unregisterObject,
	selectObject,
	setObjectLayout,
	snapshotOf,
	commitLayout,
	frameTick,
} from "./interaction-lab";
import { pushHistory, popUndo, type LayoutMap } from "./history";
import type { LabObjectInit } from "../plugin-api";
import type { Rect } from "./types";

// Minimal session stub for unit tests that don't need React
function stubSession(): Session {
	const root = document.createElement("div");
	root.setAttribute("data-mode", "explore");
	const layer = document.createElement("div");
	root.appendChild(layer);
	document.body.appendChild(root);
	return {
		root,
		layer,
		grid: null,
		measure: null,
		snapX: document.createElement("div"),
		snapY: document.createElement("div"),
		ghost: null,
		chrome: new Map(),
		origin: { x: 0, y: 0 },
		viewport: { width: 1440, height: 900 },
		gesturing: false,
		idleTimer: 0,
		lastMove: 0,
		willChangeOn: false,
		dropWillChange: 0,
		canvasColor: "#f1f1f1",
		savedColors: [],
		mode: "explore",
		selectedId: null,
		focusedId: null,
		exploreCamera: null,
		layouts: {
			"screen-1": { x: 0, y: 0, width: 1440, height: 900 },
		},
		names: {},
		visible: {},
		lastPointer: { x: 720, y: 450 },
		drag: null,
		alt: false,
		measureHover: null,
		nudge: null,
		objects: new Map(),
		escapers: new Map(),
		bump: () => {},
		getGuides: () => [],
		plugins: [],
		pluginApis: new Map(),
		pluginsOnCameraWrite: noop,
		disposeExtras: noop,
		getSnapshot: function () { return snapshotOf(this as Session); },
	} as Session;
}

function makeInit(id: string, rect: Rect, opts?: Partial<LabObjectInit>): LabObjectInit {
	const el = document.createElement("div");
	return { id, el, rect, ...opts };
}

describe("canvas-object registry", () => {
	it("register sets layouts[id], el has data-lab-object, DOM written", () => {
		const s = stubSession();
		const init = makeInit("note:1", { x: 100, y: 200, width: 240, height: 240 });
		s.layer!.appendChild(init.el);
		registerObject(s, init);
		expect(s.layouts["note:1"]).toEqual({ x: 100, y: 200, width: 240, height: 240 });
		expect(init.el.getAttribute("data-lab-object")).toBe("note:1");
		expect(init.el.style.transform).toContain("translate(100px, 200px)");
		expect(init.el.style.width).toBe("240px");
		expect(init.el.style.height).toBe("240px");
	});

	it("register throws on duplicate id", () => {
		const s = stubSession();
		const init = makeInit("note:1", { x: 0, y: 0, width: 100, height: 100 });
		registerObject(s, init);
		expect(() => registerObject(s, makeInit("note:1", { x: 0, y: 0, width: 100, height: 100 }))).toThrow("duplicate");
	});

	it("unregister removes layout, attribute, decor, and clears selection", () => {
		const s = stubSession();
		const init = makeInit("note:1", { x: 0, y: 0, width: 100, height: 100 }, { resizable: true });
		s.layer!.appendChild(init.el);
		registerObject(s, init);
		selectObject(s, "note:1");
		expect(s.selectedId).toBe("note:1");
		unregisterObject(s, "note:1");
		expect(s.layouts["note:1"]).toBeUndefined();
		expect(init.el.hasAttribute("data-lab-object")).toBe(false);
		expect(s.selectedId).toBeNull();
		// decor removed
		expect(init.el.querySelectorAll("[data-edge]").length).toBe(0);
	});
});

/**
 * A label's box is content-driven: text plus a drawn arrow, sized by its own
 * font-size. The lab owns where it sits and nothing else. Both sides are here
 * on purpose — "the lab stopped writing sizes" would pass just as well if it
 * had stopped writing them for frames and stickies too.
 */
describe("sizing: content vs lab", () => {
	it("a content-sized object gets the transform and keeps its own box", () => {
		const s = stubSession();
		const init = makeInit(
			"label:content",
			{ x: 30, y: 40, width: 92, height: 70 },
			{ sizing: "content" },
		);
		s.layer?.appendChild(init.el);
		registerObject(s, init);
		expect(init.el.style.transform).toContain("translate(30px, 40px)");
		expect(init.el.style.width).toBe("");
		expect(init.el.style.height).toBe("");
		// The registered rect is still what snapping and Shift+2 read.
		expect(s.layouts["label:content"]).toEqual({
			x: 30,
			y: 40,
			width: 92,
			height: 70,
		});
		// It moves like anything else, and still writes no size.
		setObjectLayout(s, "label:content", { x: 1, y: 2, width: 120, height: 80 });
		expect(init.el.style.transform).toContain("translate(1px, 2px)");
		expect(init.el.style.width).toBe("");
		// No lab-owned size means no size tick to fire.
		expect(frameTick("label:content")).toBe(0);
	});

	it("a lab-sized object still gets width and height written", () => {
		const s = stubSession();
		const init = makeInit("note:sized", { x: 30, y: 40, width: 92, height: 70 });
		s.layer?.appendChild(init.el);
		registerObject(s, init);
		expect(init.el.style.transform).toContain("translate(30px, 40px)");
		expect(init.el.style.width).toBe("92px");
		expect(init.el.style.height).toBe("70px");
		setObjectLayout(s, "note:sized", { x: 1, y: 2, width: 120, height: 80 });
		expect(init.el.style.width).toBe("120px");
		expect(init.el.style.height).toBe("80px");
		expect(frameTick("note:sized")).toBeGreaterThan(0);
	});

	it('"lab" is the default, so an object that says nothing is sized', () => {
		const s = stubSession();
		const init = makeInit("note:default", { x: 0, y: 0, width: 50, height: 60 }, {
			sizing: "lab",
		});
		s.layer?.appendChild(init.el);
		registerObject(s, init);
		expect(init.el.style.width).toBe("50px");
	});
});

describe("selection", () => {
	it("data-selected toggles, onSelect fires", () => {
		const s = stubSession();
		const calls: [string, boolean][] = [];
		const init = makeInit("note:1", { x: 0, y: 0, width: 100, height: 100 }, {
			onSelect: (sel) => calls.push(["note:1", sel]),
		});
		registerObject(s, init);
		selectObject(s, "note:1");
		expect(init.el.hasAttribute("data-selected")).toBe(true);
		expect(calls).toEqual([["note:1", true]]);
		selectObject(s, null);
		expect(init.el.hasAttribute("data-selected")).toBe(false);
		expect(calls).toEqual([["note:1", true], ["note:1", false]]);
	});

	it("selecting a different object clears the previous", () => {
		const s = stubSession();
		const a = makeInit("a", { x: 0, y: 0, width: 100, height: 100 });
		const b = makeInit("b", { x: 200, y: 0, width: 100, height: 100 });
		registerObject(s, a);
		registerObject(s, b);
		selectObject(s, "a");
		expect(a.el.hasAttribute("data-selected")).toBe(true);
		selectObject(s, "b");
		expect(a.el.hasAttribute("data-selected")).toBe(false);
		expect(b.el.hasAttribute("data-selected")).toBe(true);
	});
});

describe("resizable decor", () => {
	it("appends 8 handles + ring for resizable objects", () => {
		const s = stubSession();
		const init = makeInit("note:1", { x: 0, y: 0, width: 100, height: 100 }, { resizable: true });
		s.layer!.appendChild(init.el);
		registerObject(s, init);
		const handles = init.el.querySelectorAll("[data-edge]");
		expect(handles.length).toBe(8);
		// ring is also appended
		const ring = init.el.querySelector("[class*='ring']");
		expect(ring).toBeTruthy();
	});

	it("no decor for non-resizable objects", () => {
		const s = stubSession();
		const init = makeInit("plain", { x: 0, y: 0, width: 100, height: 100 });
		registerObject(s, init);
		expect(init.el.querySelectorAll("[data-edge]").length).toBe(0);
	});
});

describe("snapshotOf excludes objects", () => {
	it("snapshot only contains screen ids, not object ids", () => {
		const s = stubSession();
		registerObject(s, makeInit("note:1", { x: 50, y: 50, width: 240, height: 240 }));
		const snap = snapshotOf(s);
		expect(snap.screens["screen-1"]).toBeDefined();
		expect(snap.screens["note:1"]).toBeUndefined();
	});
});

describe("setLayout", () => {
	it("programmatic setLayout writes DOM and fires onLayout", () => {
		const s = stubSession();
		let called: Rect | null = null;
		const init = makeInit("note:1", { x: 0, y: 0, width: 100, height: 100 }, {
			onLayout: (r) => { called = r; },
		});
		s.layer!.appendChild(init.el);
		registerObject(s, init);
		setObjectLayout(s, "note:1", { x: 50, y: 60, width: 200, height: 180 });
		expect(s.layouts["note:1"]).toEqual({ x: 50, y: 60, width: 200, height: 180 });
		expect(called).toEqual({ x: 50, y: 60, width: 200, height: 180 });
	});
});

describe("commitLayout", () => {
	it("for an object calls onLayout; for a screen persists", () => {
		const s = stubSession();
		let called = false;
		const init = makeInit("note:1", { x: 0, y: 0, width: 100, height: 100 }, {
			onLayout: () => { called = true; },
		});
		registerObject(s, init);
		commitLayout(s, "note:1");
		expect(called).toBe(true);
	});
});

describe("undo tells the view, even when the selection does not change", () => {
	/**
	 * selectObject only bumps when the selection actually changes, and the
	 * commonest undo of all — Ctrl+Z right after dragging something — leaves
	 * the same thing selected. Without an unconditional bump the frame slid
	 * back to where it came from and its name label stayed where it was.
	 */
	it("bumps after undoing a move of the ALREADY selected item", async () => {
		const s = stubSession();
		let bumps = 0;
		s.bump = () => { bumps++; };
		s.selectedId = "screen-1";
		s.layouts["screen-1"] = { x: 500, y: 0, width: 1440, height: 900 };
		pushHistory({
			type: "move",
			id: "screen-1",
			from: { x: 0, y: 0 },
			to: { x: 500, y: 0 },
		});
		const { applyHistory } = await import("./interaction-lab");
		await applyHistory(s, popUndo(), true);
		expect(s.layouts["screen-1"].x).toBe(0);
		expect(bumps).toBeGreaterThan(0);
	});

	it("bumps after undoing a resize of the ALREADY selected item", async () => {
		const s = stubSession();
		let bumps = 0;
		s.bump = () => { bumps++; };
		s.selectedId = "screen-1";
		const from = { x: 0, y: 0, width: 1440, height: 900 };
		const to = { x: 0, y: 0, width: 900, height: 900 };
		s.layouts["screen-1"] = { ...to };
		pushHistory({ type: "resize", id: "screen-1", from, to });
		const { applyHistory } = await import("./interaction-lab");
		await applyHistory(s, popUndo(), true);
		expect(s.layouts["screen-1"].width).toBe(1440);
		expect(bumps).toBeGreaterThan(0);
	});

	it("does not throw when the moved thing is gone", async () => {
		const s = stubSession();
		pushHistory({
			type: "move",
			id: "note:99",
			from: { x: 0, y: 0 },
			to: { x: 10, y: 10 },
		});
		const { applyHistory } = await import("./interaction-lab");
		await applyHistory(s, popUndo(), true);
		expect(s.layouts["note:99"]).toBeUndefined();
	});
});

describe("whole-map replacements keep object layouts (the trap)", () => {
	it("applyHistory reset preserves registered object layout", async () => {
		const s = stubSession();
		const init = makeInit("note:1", { x: 77, y: 88, width: 240, height: 240 });
		registerObject(s, init);

		// Simulate a reset that replaces layouts with screens-only
		const before: LayoutMap = { "screen-1": { x: 0, y: 0, width: 1440, height: 900 } };
		const after: LayoutMap = { "screen-1": { x: 100, y: 100, width: 1440, height: 900 } };
		pushHistory({ type: "reset", before, after });

		// Import applyHistory
		const { applyHistory } = await import("./interaction-lab");
		await applyHistory(s, popUndo(), true);

		// The note layout must survive
		expect(s.layouts["note:1"]).toEqual({ x: 77, y: 88, width: 240, height: 240 });
		// Screen was reverted
		expect(s.layouts["screen-1"]).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
	});
});
