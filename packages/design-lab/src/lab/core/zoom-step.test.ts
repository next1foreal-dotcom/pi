// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { interactiveZBand } from "./camera";
import { WHEEL_ZOOM_CAP, zoomFactor } from "./canvas-input";
import { INTERACTIVE_Z_MAX, INTERACTIVE_Z_MIN, clamp } from "./math";

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
