// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	flushCoarse,
	getCamera,
	getCoarseZoom,
	seedCamera,
	setCameraExact,
	setCameraValue,
} from "./camera";

afterEach(() => {
	vi.useRealTimers();
	seedCamera({ x: 0, y: 0, z: 1 });
	flushCoarse();
});

/**
 * Fill pins the camera at z=1 in the same turn the canvas jumps. The HUD
 * readout used to wait 100ms (the wheel-zoom debounce), so a remount into
 * fill could still say 26% while he was looking at the screen.
 */
describe("the HUD zoom is the camera he is looking through", () => {
	it("a fill jump to z=1 updates the readout in the same turn", () => {
		seedCamera({ x: 12, y: 8, z: 0.26 });
		expect(getCoarseZoom()).toBe(0.26);
		setCameraExact({ x: 0, y: 0, z: 1 });
		expect(getCamera().z).toBe(1);
		expect(getCoarseZoom()).toBe(1);
	});

	it("a wheel notch does not re-render the HUD every frame", () => {
		vi.useFakeTimers();
		seedCamera({ x: 0, y: 0, z: 1 });
		setCameraValue({ x: 0, y: 0, z: 1.1 });
		expect(getCoarseZoom()).toBe(1);
		vi.advanceTimersByTime(99);
		expect(getCoarseZoom()).toBe(1);
		vi.advanceTimersByTime(1);
		expect(getCoarseZoom()).toBe(1.1);
	});
});
