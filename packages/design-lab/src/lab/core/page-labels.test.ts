// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screenToPage } from "./math";
import {
	cycleDirection,
	DEFAULT_LABELS_KEY,
	directionFromAim,
	Labels,
	MIRROR,
	type LabelDirection,
} from "./page-labels";
import type { LabObjectInit, LabObjects } from "../plugin-api";
import type { Rect } from "./types";

function key(
	init: KeyboardEventInit & { key: string },
): KeyboardEvent {
	return new KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		...init,
	});
}

const spawnAt = () => ({ x: 50, y: 60 });

/**
 * The lab, as far as one plugin can see it: a registry, a selection, and a
 * drag it takes over. Enough to assert what the plugin hands across the seam.
 * The real thing running the real pipeline is canvas-object-live.test.ts.
 */
type StubObjects = LabObjects & {
	inits: LabObjectInit[];
	moves: { id: string; opts?: { onClick?(): void } }[];
	setLayoutCalls: { id: string; rect: Rect }[];
};

function stubObjects(): StubObjects {
	const layouts = new Map<string, Rect>();
	const inits: LabObjectInit[] = [];
	const moves: { id: string; opts?: { onClick?(): void } }[] = [];
	const setLayoutCalls: { id: string; rect: Rect }[] = [];
	let sel: string | null = null;
	const find = (id: string | null) =>
		id == null ? undefined : inits.find((i) => i.id === id);
	const api: StubObjects = {
		inits,
		moves,
		setLayoutCalls,
		register(init) {
			inits.push(init);
			layouts.set(init.id, { ...init.rect });
			init.el.setAttribute("data-lab-object", init.id);
		},
		unregister(id) {
			layouts.delete(id);
			if (sel === id) api.select(null);
		},
		layout: (id) => layouts.get(id),
		setLayout(id, rect) {
			layouts.set(id, { ...rect });
			setLayoutCalls.push({ id, rect: { ...rect } });
			find(id)?.onLayout?.(rect);
		},
		beginMove(_e, id, opts) {
			moves.push({ id, opts });
		},
		beginResize() {},
		select(id) {
			if (sel === id) return;
			const prev = find(sel);
			if (prev) {
				prev.el.removeAttribute("data-selected");
				prev.onSelect?.(false);
			}
			sel = id;
			const next = find(id);
			if (next) {
				next.el.setAttribute("data-selected", "");
				next.onSelect?.(true);
			}
		},
		selectedId: () => sel,
	};
	return api;
}

const hosts: HTMLElement[] = [];
function host(): HTMLDivElement {
	const el = document.createElement("div");
	document.body.appendChild(el);
	hosts.push(el);
	return el;
}

afterEach(() => {
	for (const h of hosts.splice(0)) h.remove();
});

/** jsdom reports every box as 0x0; give one a size on purpose. */
function stubBox(el: Element, width: number, height: number) {
	Object.defineProperty(el, "getBoundingClientRect", {
		configurable: true,
		value: () => ({
			left: 0,
			top: 0,
			right: width,
			bottom: height,
			width,
			height,
			x: 0,
			y: 0,
		}),
	});
}

const labelEl = () => document.querySelector<HTMLElement>(".lb-label");
const labelCss = () =>
	document.querySelector<HTMLStyleElement>("style[data-label-overlay]")
		?.textContent ?? "";
const cssRule = (re: RegExp) => labelCss().match(re)?.[0] ?? "";

describe("quadrant recompose geometry", () => {
	it("cycles clockwise SE → SW → NW → NE", () => {
		expect(cycleDirection("dr")).toBe("dl");
		expect(cycleDirection("dl")).toBe("ul");
		expect(cycleDirection("ul")).toBe("ur");
		expect(cycleDirection("ur")).toBe("dr");
	});

	it("Alt-cycle is counter-clockwise", () => {
		expect(cycleDirection("dr", true)).toBe("ur");
		expect(cycleDirection("ur", true)).toBe("ul");
	});

	it("mirrors left/right without flipping up/down", () => {
		expect(MIRROR.dr).toBe("dl");
		expect(MIRROR.dl).toBe("dr");
		expect(MIRROR.ur).toBe("ul");
		expect(MIRROR.ul).toBe("ur");
	});

	it("aim pointer quadrant maps to arrow direction, with a dead zone", () => {
		expect(directionFromAim(10, 10)).toBe("dr");
		expect(directionFromAim(-10, 10)).toBe("dl");
		expect(directionFromAim(10, -10)).toBe("ur");
		expect(directionFromAim(-10, -10)).toBe("ul");
		expect(directionFromAim(0, 0)).toBeNull();
		expect(directionFromAim(8, 8)).toBeNull();
	});

	it("setDirection writes data-dir and the matching path", () => {
		const labels = new Labels({
			host: host(),
			getZoom: () => 1,
			objects: stubObjects(),
			storageKey: null,
		});
		const item = labels.spawn({ x: 0, y: 0, dir: "dr", text: "a" });
		labels.setDirection(item.id, "ul");
		expect(labelEl()?.getAttribute("data-dir")).toBe("ul");
		expect(labels.getLabels()[0]?.dir).toBe("ul");
		labels.destroy();
	});
});

describe("a label is a canvas object", () => {
	it("registers content-sized and not box-resizable", () => {
		const objects = stubObjects();
		const labels = new Labels({
			host: host(),
			getZoom: () => 1,
			objects,
			storageKey: null,
		});
		labels.spawn({ x: 0, y: 0, text: "a" });
		expect(objects.inits).toHaveLength(1);
		const init = objects.inits[0];
		expect(init.id).toBe("label:1");
		// Its box is text plus a drawn arrow: the lab owns the position only.
		expect(init.sizing).toBe("content");
		// An 8-way box resize means nothing for a line of text; the scale
		// handle and the aim handle are its real size and direction controls.
		expect(init.resizable).toBe(false);
		expect(init.el).toBe(labelEl());
		labels.destroy();
	});

	it("registers a real box even before layout, so it can be snapped to", () => {
		// jsdom (and a fresh mount) report 0x0 for everything. Snapping and
		// Shift+2 read the registered rect, so a 0x0 one would make a label
		// unsnappable and unreachable.
		const objects = stubObjects();
		const labels = new Labels({
			host: host(),
			getZoom: () => 1,
			objects,
			storageKey: null,
		});
		labels.spawn({ x: 0, y: 0, text: "a" });
		const rect = objects.layout("label:1");
		expect(rect?.width).toBeGreaterThan(0);
		expect(rect?.height).toBeGreaterThan(0);
		labels.destroy();
	});

	it("stores spawn coordinates as page units and writes no transform of its own", () => {
		const objects = stubObjects();
		const labels = new Labels({
			host: host(),
			getZoom: () => 2,
			objects,
			storageKey: null,
		});
		labels.spawn({ x: 190, y: 130, text: "here" });
		const item = labels.getLabels()[0];
		expect(item?.x).toBe(190);
		expect(item?.y).toBe(130);
		expect(objects.layout("label:1")).toMatchObject({ x: 190, y: 130 });
		// The core writes the transform now. A returning positionEl would put
		// the counter-scale back and the label would stop growing with the canvas.
		expect(labelEl()?.style.transform ?? "").toBe("");
		labels.destroy();
	});

	it("hands a press on the label to the lab instead of dragging it itself", () => {
		HTMLElement.prototype.setPointerCapture ??= function () {};
		HTMLElement.prototype.releasePointerCapture ??= function () {};
		const objects = stubObjects();
		const labels = new Labels({
			host: host(),
			getZoom: () => 2,
			objects,
			storageKey: null,
		});
		labels.spawn({ x: 100, y: 100, text: "drag" });
		const el = labelEl() as HTMLElement;
		(el.querySelector(".lb-text") as HTMLElement).blur();

		const down = new PointerEvent("pointerdown", {
			button: 0,
			clientX: 0,
			clientY: 0,
			pointerId: 1,
			bubbles: true,
			cancelable: true,
		});
		el.dispatchEvent(down);
		expect(objects.moves.map((m) => m.id)).toEqual(["label:1"]);
		expect(objects.moves[0]?.opts?.onClick).toBeTypeOf("function");
		// Native focus is suppressed, or a drag started on the text would
		// select letters instead of moving the label.
		expect(down.defaultPrevented).toBe(true);
		// Moves that the lab never reports do not move the label.
		el.dispatchEvent(
			new PointerEvent("pointermove", {
				clientX: 400,
				clientY: 400,
				pointerId: 1,
				bubbles: true,
			}),
		);
		expect(labels.getLabels()[0]?.x).toBe(100);
		labels.destroy();
	});

	it("unregisters on remove, clear and destroy", () => {
		const objects = stubObjects();
		const labels = new Labels({
			host: host(),
			getZoom: () => 1,
			objects,
			storageKey: null,
		});
		const a = labels.spawn({ x: 0, y: 0 });
		labels.spawn({ x: 20, y: 20 });
		labels.removeLabel(a.id);
		expect(objects.layout("label:1")).toBeUndefined();
		expect(objects.layout("label:2")).toBeDefined();
		labels.spawn({ x: 40, y: 40 });
		labels.clearLabels();
		expect(objects.layout("label:2")).toBeUndefined();
		expect(objects.layout("label:3")).toBeUndefined();
		const kept = labels.spawn({ x: 60, y: 60 });
		labels.destroy();
		expect(objects.layout(`label:${kept.id}`)).toBeUndefined();
	});

	it("hiding them all clears the lab's selection", () => {
		const objects = stubObjects();
		const labels = new Labels({
			host: host(),
			getZoom: () => 1,
			objects,
			storageKey: null,
		});
		labels.spawn({ x: 0, y: 0 });
		expect(objects.selectedId()).toBe("label:1");
		labels.setHidden(true);
		expect(objects.selectedId()).toBeNull();
		labels.destroy();
	});
});

describe("the box is re-measured, not remembered", () => {
	it("setScale and setDirection push the measured box through setLayout", () => {
		const objects = stubObjects();
		const labels = new Labels({
			host: host(),
			getZoom: () => 2,
			objects,
			storageKey: null,
		});
		const item = labels.spawn({ x: 0, y: 0, dir: "dr", text: "a" });
		const el = labelEl() as HTMLElement;

		// getBoundingClientRect is screen px; the rect is page units.
		stubBox(el, 240, 140);
		labels.setScale(item.id, 2);
		expect(objects.layout("label:1")).toEqual({
			x: 0,
			y: 0,
			width: 120,
			height: 70,
		});

		// Recomposing puts the arrow on the other side: a new shape.
		stubBox(el, 200, 300);
		labels.setDirection(item.id, "ul");
		expect(objects.layout("label:1")).toEqual({
			x: 0,
			y: 0,
			width: 100,
			height: 150,
		});
		expect(objects.setLayoutCalls.map((c) => c.id)).toEqual([
			"label:1",
			"label:1",
		]);
		labels.destroy();
	});

	it("the lab moving a label writes back position, never a size", () => {
		const objects = stubObjects();
		const labels = new Labels({
			host: host(),
			getZoom: () => 1,
			objects,
			storageKey: null,
		});
		const item = labels.spawn({ x: 0, y: 0, scale: 1, text: "a" });
		objects.inits[0].onLayout?.({
			x: 44,
			y: 55,
			width: 9999,
			height: 9999,
		});
		expect(labels.getLabels()[0]?.x).toBe(44);
		expect(labels.getLabels()[0]?.y).toBe(55);
		// A content-sized object's size never comes from the lab: the 9999s
		// above are ignored, and the next re-measure is the element's own box.
		expect(labels.getLabels()[0]?.scale).toBe(1);
		labels.setScale(item.id, 1.5);
		expect(objects.layout("label:1")?.width).toBeLessThan(9999);
		labels.destroy();
	});
});

describe("screen-sized controls on a page-sized label", () => {
	let labels: Labels;

	beforeEach(() => {
		labels = new Labels({
			host: host(),
			getZoom: () => 1,
			objects: stubObjects(),
			storageKey: null,
		});
	});

	afterEach(() => {
		labels.destroy();
	});

	it("the label itself does NOT counter-scale any more", () => {
		const rule = cssRule(/\.lb-label\{[^}]*\}/);
		expect(rule).toBeTruthy();
		expect(rule).not.toContain("inv-zoom");
	});

	it("the scale handle stays grabbable at any zoom", () => {
		const rule = cssRule(/\.lb-handle\{[^}]*\}/);
		expect(rule).toBeTruthy();
		expect(rule).toContain("width:calc(10px * var(--inv-zoom,1))");
		expect(rule).toContain("height:calc(10px * var(--inv-zoom,1))");
		expect(rule).toContain("right:calc(-6px * var(--inv-zoom,1))");
		expect(rule).toContain("bottom:calc(-6px * var(--inv-zoom,1))");
		expect(rule).toContain("border:calc(1px * var(--inv-zoom,1))");
	});

	it("the aim handle does too", () => {
		const rule = cssRule(/\.lb-aim\{[^}]*\}/);
		expect(rule).toBeTruthy();
		expect(rule).toContain("width:calc(10px * var(--inv-zoom,1))");
		expect(rule).toContain("right:calc(-16px * var(--inv-zoom,1))");
		expect(rule).toContain("margin-top:calc(-5px * var(--inv-zoom,1))");
		expect(rule).toContain("border:calc(1px * var(--inv-zoom,1))");
		// and the mirrored side, for arrows pointing left
		expect(cssRule(/\.lb-label\[data-dir="dl"\] \.lb-aim[^{]*\{[^}]*\}/)).toContain(
			"left:calc(-16px * var(--inv-zoom,1))",
		);
	});

	it("the selection outline stays a hairline at any zoom", () => {
		const rule = cssRule(/\.lb-label\[data-selected\]\{[^}]*\}/);
		expect(rule).toBeTruthy();
		expect(rule).toContain("outline:calc(1px * var(--inv-zoom,1))");
	});
});

describe("page ↔ viewport conversion", () => {
	it("viewport-center spawn point is the camera inverse (page units)", () => {
		const cam = { x: 10, y: 20, z: 2 };
		const origin = { x: 0, y: 0 };
		const vp = { width: 800, height: 600 };
		const center = screenToPage(
			{ x: origin.x + vp.width / 2, y: origin.y + vp.height / 2 },
			cam,
			origin,
		);
		expect(center).toEqual({ x: 190, y: 130 });
	});
});

describe("persistence shape", () => {
	const key = "interaction-lab:labels:test";

	beforeEach(() => {
		localStorage.removeItem(key);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		localStorage.removeItem(key);
	});

	it("writes v1 items with page x/y, scale, dir, text", () => {
		const labels = new Labels({
			host: host(),
			getZoom: () => 1,
			objects: stubObjects(),
			storageKey: key,
		});
		labels.spawn({ x: 10, y: 20, scale: 1.5, dir: "ul", text: "hi" });
		vi.advanceTimersByTime(200);
		const raw = localStorage.getItem(key);
		expect(raw).toBeTruthy();
		expect(JSON.parse(raw as string)).toEqual({
			v: 1,
			items: [{ x: 10, y: 20, s: 1.5, d: "ul", t: "hi" }],
		});
		labels.destroy();
	});

	it("reloads page coordinates without clamping, and registers them", () => {
		localStorage.setItem(
			key,
			JSON.stringify({
				v: 1,
				items: [{ x: 9999, y: -40, s: 2, d: "ur", t: "far" }],
			}),
		);
		const objects = stubObjects();
		const labels = new Labels({
			host: host(),
			getZoom: () => 1,
			objects,
			storageKey: key,
		});
		expect(labels.getLabels()).toEqual([
			{
				id: 1,
				x: 9999,
				y: -40,
				scale: 2,
				dir: "ur",
				text: "far",
			},
		]);
		// A reloaded label is canvas content too, not a ghost the lab cannot see.
		expect(objects.inits.map((i) => i.id)).toEqual(["label:1"]);
		expect(objects.layout("label:1")).toMatchObject({ x: 9999, y: -40 });
		labels.destroy();
	});

	it("default storage key follows notes convention", () => {
		expect(DEFAULT_LABELS_KEY).toBe("interaction-lab:labels:v1");
	});
});

describe("handleKey intercept vs passthrough", () => {
	let objects: StubObjects;
	let labels: Labels;

	beforeEach(() => {
		objects = stubObjects();
		labels = new Labels({
			host: host(),
			getZoom: () => 1,
			objects,
			storageKey: null,
		});
	});

	afterEach(() => {
		labels.destroy();
	});

	it("Shift+L always spawns at the provided page point", () => {
		const e = key({ key: "l", code: "KeyL", shiftKey: true });
		expect(labels.handleKey(e, spawnAt)).toBe(true);
		expect(e.defaultPrevented).toBe(true);
		expect(labels.getLabels()).toHaveLength(1);
		expect(labels.getLabels()[0]?.x).toBe(50);
		expect(labels.getLabels()[0]?.y).toBe(60);
	});

	it("Ctrl+Shift+L always toggles hidden", () => {
		labels.spawn({ x: 0, y: 0, text: "x" });
		const e = key({
			key: "l",
			code: "KeyL",
			ctrlKey: true,
			shiftKey: true,
		});
		expect(labels.handleKey(e, spawnAt)).toBe(true);
		expect(labels.hidden).toBe(true);
	});

	it("R / F / Delete / arrows / Esc pass through when nothing is selected", () => {
		const gated: Array<KeyboardEventInit & { key: string }> = [
			{ key: "r", code: "KeyR" },
			{ key: "r", code: "KeyR", altKey: true },
			{ key: "f", code: "KeyF" },
			{ key: "Delete" },
			{ key: "Backspace" },
			{ key: "ArrowLeft" },
			{ key: "ArrowRight" },
			{ key: "ArrowUp" },
			{ key: "ArrowDown" },
			{ key: "Escape" },
		];
		for (const init of gated) {
			expect(labels.handleKey(key(init), spawnAt)).toBe(false);
		}
	});

	it("R / F / Delete act on the LAB's selection, not a private one", () => {
		labels.spawn({ x: 0, y: 0, dir: "dr", text: "sel" });
		(labelEl()?.querySelector(".lb-text") as HTMLElement).blur();

		// The lab has something else selected: not our keys.
		objects.select("screen-1");
		expect(labels.handleKey(key({ key: "r", code: "KeyR" }), spawnAt)).toBe(
			false,
		);
		expect(labels.handleKey(key({ key: "Delete" }), spawnAt)).toBe(false);
		expect(labels.getLabels()[0]?.dir).toBe("dr");

		objects.select("label:1");
		expect(labels.handleKey(key({ key: "r", code: "KeyR" }), spawnAt)).toBe(
			true,
		);
		expect(labels.getLabels()[0]?.dir).toBe("dl");

		expect(
			labels.handleKey(key({ key: "r", code: "KeyR", altKey: true }), spawnAt),
		).toBe(true);
		expect(labels.getLabels()[0]?.dir).toBe("dr");

		expect(labels.handleKey(key({ key: "f", code: "KeyF" }), spawnAt)).toBe(
			true,
		);
		expect(labels.getLabels()[0]?.dir).toBe("dl");
	});

	it("arrow keys are the lab's nudge, not the plugin's", () => {
		labels.spawn({ x: 0, y: 0, text: "sel" });
		(labelEl()?.querySelector(".lb-text") as HTMLElement).blur();
		for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
			const e = key({ key: k, shiftKey: true });
			expect(labels.handleKey(e, spawnAt)).toBe(false);
			expect(e.defaultPrevented).toBe(false);
		}
		// One behaviour, one implementation: the plugin moved nothing.
		expect(labels.getLabels()[0]?.x).toBe(0);
		expect(labels.getLabels()[0]?.y).toBe(0);
	});

	it("Escape passes to the core's deselect when not editing", () => {
		labels.spawn({ x: 0, y: 0, text: "sel" });
		(labelEl()?.querySelector(".lb-text") as HTMLElement).blur();
		expect(labels.handleKey(key({ key: "Escape" }), spawnAt)).toBe(false);
		// and the plugin does not quietly deselect behind the core's back
		expect(objects.selectedId()).toBe("label:1");
	});

	it("Delete removes the selected label", () => {
		labels.spawn({ x: 0, y: 0, text: "bye" });
		(labelEl()?.querySelector(".lb-text") as HTMLElement).blur();
		expect(labels.handleKey(key({ key: "Delete" }), spawnAt)).toBe(true);
		expect(labels.getLabels()).toHaveLength(0);
	});

	it("Shift+R and Shift+F are not eaten (ruler / fill-toggle)", () => {
		labels.spawn({ x: 0, y: 0, dir: "dr" as LabelDirection, text: "x" });
		(labelEl()?.querySelector(".lb-text") as HTMLElement).blur();
		expect(
			labels.handleKey(key({ key: "R", code: "KeyR", shiftKey: true }), spawnAt),
		).toBe(false);
		expect(
			labels.handleKey(key({ key: "F", code: "KeyF", shiftKey: true }), spawnAt),
		).toBe(false);
		expect(labels.getLabels()[0]?.dir).toBe("dr");
	});

	it("contenteditable typing is not intercepted for R / Delete", () => {
		labels.spawn({ x: 0, y: 0, text: "edit" });
		const text = labelEl()?.querySelector(".lb-text") as HTMLElement;
		const r = key({ key: "r", code: "KeyR" });
		Object.defineProperty(r, "target", { value: text });
		expect(labels.handleKey(r, spawnAt)).toBe(false);
		const del = key({ key: "Delete" });
		Object.defineProperty(del, "target", { value: text });
		expect(labels.handleKey(del, spawnAt)).toBe(false);
		expect(labels.getLabels()).toHaveLength(1);
	});

	it("Escape still consumes while typing so lab does not steal it", () => {
		labels.spawn({ x: 0, y: 0, text: "edit" });
		const text = labelEl()?.querySelector(".lb-text") as HTMLElement;
		const e = key({ key: "Escape" });
		Object.defineProperty(e, "target", { value: text });
		expect(labels.handleKey(e, spawnAt)).toBe(true);
	});
});
