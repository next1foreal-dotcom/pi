// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCamera, setCameraExact } from "./camera";
import {
	bindCanvasInput,
	resolveZoomAnchor,
	ZOOM_ANCHOR_HOLD_MS,
} from "./canvas-input";
import { IDLE_MS } from "./interaction-lab";
import { screenToPage } from "./math";

/**
 * Zooming at the cursor keeps the page point under the cursor fixed. That is
 * right for frames, which scale, and wrong for a sticky, which does not: the
 * sticky's corner is what is pinned to the page, so the sticky slides out from
 * under the pointer. With the cursor over a sticky the zoom pivots on the
 * sticky's corner instead, and the sticky does not move at all.
 */

const ORIGIN = { x: 0, y: 0 };

function stubRect(el: Element, left: number, top: number, w = 96, h = 96) {
	Object.defineProperty(el, "getBoundingClientRect", {
		configurable: true,
		value: () => ({
			left,
			top,
			right: left + w,
			bottom: top + h,
			width: w,
			height: h,
			x: left,
			y: top,
		}),
	});
}

function ctrlWheel(
	target: Element,
	clientX: number,
	clientY: number,
	deltaY = -100,
) {
	target.dispatchEvent(
		new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			ctrlKey: true,
			deltaY,
			deltaMode: 0,
			clientX,
			clientY,
		}),
	);
}

describe("resolveZoomAnchor", () => {
	it("takes the annotation under the cursor", () => {
		const note = document.createElement("div");
		note.setAttribute("data-zoom-anchor", "");
		const inner = document.createElement("span");
		note.appendChild(inner);
		expect(resolveZoomAnchor(inner, null, 1000)?.el).toBe(note);
	});

	it("keeps the anchor through a gesture after the layer stops taking events", () => {
		const note = document.createElement("div");
		const root = document.createElement("div");
		const first = { el: note, at: 1000 };
		// The second notch 60ms later resolves to the root (the layer is
		// pointer-events: none by then), but the gesture is still going...
		const second = resolveZoomAnchor(root, first, 1060);
		expect(second?.el).toBe(note);
		// ...and each notch renews it, so a long steady scroll never drops it.
		const third = resolveZoomAnchor(
			root,
			second,
			1060 + ZOOM_ANCHOR_HOLD_MS - 1,
		);
		expect(third?.el).toBe(note);
	});

	it("drops the anchor once the gesture has gone idle", () => {
		const note = document.createElement("div");
		const root = document.createElement("div");
		expect(
			resolveZoomAnchor(root, { el: note, at: 1000 }, 1000 + ZOOM_ANCHOR_HOLD_MS),
		).toBeNull();
	});

	it("holds for exactly as long as the lab's gesture-idle window", () => {
		expect(ZOOM_ANCHOR_HOLD_MS).toBe(IDLE_MS);
	});
});

describe("wheel zoom over a sticky", () => {
	let root: HTMLElement;
	let note: HTMLElement;
	let unbind: () => void;

	beforeEach(() => {
		root = document.createElement("div");
		note = document.createElement("div");
		note.setAttribute("data-zoom-anchor", "");
		root.appendChild(note);
		document.body.appendChild(root);
		stubRect(note, 100, 80);
		setCameraExact({ x: 0, y: 0, z: 1 });
		unbind = bindCanvasInput(root, {
			getOrigin: () => ORIGIN,
			getViewport: () => ({ width: 800, height: 600 }),
			isLocked: () => false,
			isFill: () => false,
			onGestureStart: () => {},
			onGestureMove: () => {},
			onPointerDown: () => false,
			onBackgroundClick: () => {},
			onFillPinch: () => {},
			lastPointer: { x: 0, y: 0 },
		});
	});

	afterEach(() => {
		unbind();
		document.body.innerHTML = "";
	});

	it("pivots on the sticky's corner, so the sticky stays put", () => {
		const before = getCamera();
		const cornerPage = screenToPage({ x: 100, y: 80 }, before, ORIGIN);
		// the cursor is 50px inside the sticky, not on its corner
		ctrlWheel(note, 150, 130);
		const after = getCamera();
		expect(after.z).toBeGreaterThan(before.z); // it did zoom
		const cornerAfter = screenToPage({ x: 100, y: 80 }, after, ORIGIN);
		expect(cornerAfter.x).toBeCloseTo(cornerPage.x, 6);
		expect(cornerAfter.y).toBeCloseTo(cornerPage.y, 6);
	});

	it("does NOT pivot on the cursor while it is over a sticky", () => {
		// The regression: with the cursor as pivot the page point under
		// (150,130) stays fixed and the sticky's corner drifts away from it.
		const before = getCamera();
		const under = screenToPage({ x: 150, y: 130 }, before, ORIGIN);
		ctrlWheel(note, 150, 130);
		const after = getCamera();
		const underAfter = screenToPage({ x: 150, y: 130 }, after, ORIGIN);
		expect(
			Math.hypot(underAfter.x - under.x, underAfter.y - under.y),
		).toBeGreaterThan(1);
	});

	it("still pivots on the cursor over bare canvas", () => {
		const before = getCamera();
		const under = screenToPage({ x: 400, y: 300 }, before, ORIGIN);
		ctrlWheel(root, 400, 300);
		const after = getCamera();
		const underAfter = screenToPage({ x: 400, y: 300 }, after, ORIGIN);
		expect(underAfter.x).toBeCloseTo(under.x, 6);
		expect(underAfter.y).toBeCloseTo(under.y, 6);
	});

	it("keeps the sticky still across a whole run of notches", () => {
		const before = getCamera();
		const cornerPage = screenToPage({ x: 100, y: 80 }, before, ORIGIN);
		ctrlWheel(note, 150, 130);
		// later notches land on the root: the layer is pointer-events:none now
		for (let i = 0; i < 5; i++) ctrlWheel(root, 150, 130);
		const after = getCamera();
		expect(after.z / before.z).toBeGreaterThan(1.7);
		const cornerAfter = screenToPage({ x: 100, y: 80 }, after, ORIGIN);
		expect(cornerAfter.x).toBeCloseTo(cornerPage.x, 6);
		expect(cornerAfter.y).toBeCloseTo(cornerPage.y, 6);
	});
});
