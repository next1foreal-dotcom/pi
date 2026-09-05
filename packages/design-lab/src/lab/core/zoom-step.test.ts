// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCamera, interactiveZBand, setCameraExact } from "./camera";
import { WHEEL_ZOOM_CAP, bindCanvasInput, zoomFactor } from "./canvas-input";
import {
	INTERACTIVE_Z_MAX,
	INTERACTIVE_Z_MIN,
	clamp,
	screenToPage,
} from "./math";

/** A real mouse notch on this platform. */
const NOTCH = 100;

describe("wheel zoom step", () => {
	it("scrolling up zooms in, down zooms out", () => {
		expect(zoomFactor(-NOTCH)).toBeGreaterThan(1);
		expect(zoomFactor(NOTCH)).toBeLessThan(1);
		expect(zoomFactor(0)).toBe(1);
	});

	it("a notch out is the exact inverse of a notch in", () => {
		// The regression: with `z * (1 - d)` this product was 0.99, so every
		// in-and-back-out pair shrank the canvas ~1% and the zoom never
		// returned to where it started.
		expect(zoomFactor(-NOTCH) * zoomFactor(NOTCH)).toBeCloseTo(1, 12);
	});

	it("returns to exactly the starting zoom after a round trip", () => {
		let z = 0.0974; // measured on the live canvas when this was found
		const start = z;
		for (let i = 0; i < 12; i++) z *= zoomFactor(-NOTCH);
		expect(z).toBeGreaterThan(start * 3); // it really did travel
		for (let i = 0; i < 12; i++) z *= zoomFactor(NOTCH);
		expect(z).toBeCloseTo(start, 10);
	});

	it("saturates, so a flick and a notch feel the same", () => {
		expect(zoomFactor(-NOTCH)).toBe(zoomFactor(-10 * NOTCH));
		expect(zoomFactor(NOTCH)).toBe(zoomFactor(10 * NOTCH));
		expect(zoomFactor(-WHEEL_ZOOM_CAP)).toBe(zoomFactor(-NOTCH));
	});

	it("leaves a trackpad's small deltas alone, so pinching stays smooth", () => {
		// Under the cap the step scales with the delta instead of saturating.
		expect(zoomFactor(-2)).toBeLessThan(zoomFactor(-6));
		expect(zoomFactor(-2)).toBeGreaterThan(1);
		expect(zoomFactor(-2)).toBeLessThan(zoomFactor(-NOTCH));
	});
});

describe("interactive zoom band", () => {
	it("is the plain interactive range while the camera is inside it", () => {
		expect(interactiveZBand(0.5)).toEqual([INTERACTIVE_Z_MIN, INTERACTIVE_Z_MAX]);
	});

	it("does not yank a camera parked below the floor back up to it", () => {
		// Fit-all writes through setCameraExact, which is allowed below the
		// interactive floor. Clamping the next gesture straight to the floor
		// zoomed IN by 30% at the exact moment the user asked to zoom out.
		const parked = 0.0383;
		const [lo] = interactiveZBand(parked);
		expect(lo).toBe(parked);
		expect(clamp(parked * zoomFactor(NOTCH), ...interactiveZBand(parked))).toBe(
			parked,
		);
	});

	it("still lets a camera below the floor walk back in, one notch at a time", () => {
		const parked = 0.0383;
		const next = clamp(parked * zoomFactor(-NOTCH), ...interactiveZBand(parked));
		expect(next).toBeGreaterThan(parked);
		expect(next).toBeLessThan(INTERACTIVE_Z_MIN); // no teleport to the floor
	});

	it("holds the floor for a camera that is inside the band", () => {
		const z = INTERACTIVE_Z_MIN;
		expect(clamp(z * zoomFactor(NOTCH), ...interactiveZBand(z))).toBe(
			INTERACTIVE_Z_MIN,
		);
	});

	it("holds the ceiling the same way at the top", () => {
		const z = INTERACTIVE_Z_MAX;
		expect(clamp(z * zoomFactor(-NOTCH), ...interactiveZBand(z))).toBe(
			INTERACTIVE_Z_MAX,
		);
		const past = 8;
		expect(interactiveZBand(past)[1]).toBe(past);
	});
});

/**
 * Where a pinch pivots. This used to be split: the cursor over bare canvas,
 * but a screen-sized annotation's own corner whenever one was under the
 * pointer. That anchor machinery is gone — nothing on the canvas is
 * screen-sized any more — and the cursor case moved here from the deleted
 * zoom-anchor.test.ts, where it is now the whole behaviour.
 */
describe("wheel zoom pivot", () => {
	const ORIGIN = { x: 0, y: 0 };
	let root: HTMLElement;
	let child: HTMLElement;
	let unbind: () => void;

	function ctrlWheel(target: Element, clientX: number, clientY: number) {
		target.dispatchEvent(
			new WheelEvent("wheel", {
				bubbles: true,
				cancelable: true,
				ctrlKey: true,
				deltaY: -NOTCH,
				deltaMode: 0,
				clientX,
				clientY,
			}),
		);
	}

	beforeEach(() => {
		root = document.createElement("div");
		child = document.createElement("div");
		root.appendChild(child);
		document.body.appendChild(root);
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

	it("still pivots on the cursor over bare canvas", () => {
		const before = getCamera();
		const under = screenToPage({ x: 400, y: 300 }, before, ORIGIN);
		ctrlWheel(root, 400, 300);
		const after = getCamera();
		expect(after.z).toBeGreaterThan(before.z);
		const underAfter = screenToPage({ x: 400, y: 300 }, after, ORIGIN);
		expect(underAfter.x).toBeCloseTo(under.x, 6);
		expect(underAfter.y).toBeCloseTo(under.y, 6);
	});

	it("pivots on the cursor over canvas content too", () => {
		// The other half of the deleted split: content under the pointer no
		// longer claims the pivot, so a label reached this way behaves exactly
		// like the frame beside it.
		const before = getCamera();
		const under = screenToPage({ x: 150, y: 130 }, before, ORIGIN);
		ctrlWheel(child, 150, 130);
		const after = getCamera();
		expect(after.z).toBeGreaterThan(before.z);
		const underAfter = screenToPage({ x: 150, y: 130 }, after, ORIGIN);
		expect(underAfter.x).toBeCloseTo(under.x, 6);
		expect(underAfter.y).toBeCloseTo(under.y, 6);
	});
});
