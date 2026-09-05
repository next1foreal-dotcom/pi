// @vitest-environment jsdom
// (interaction-lab reads window at module scope; the rule under test is pure.)

import { describe, expect, it } from "vitest";
import { CHROME_MIN_PX, chromeIsTiny } from "./interaction-lab";

/**
 * Frame chrome — the name, the size badge, the play button — is drawn at a
 * constant screen size, so zooming out does not shrink it while the frame it
 * labels keeps shrinking. Past a point the name is wider than its own frame
 * and three names overlap into one smear. This is the rule that hides it.
 */
describe("frame chrome gives up when the frame is smaller than its name", () => {
	it("keeps the chrome while the frame is wide enough to own it", () => {
		expect(chromeIsTiny(1440, 1)).toBe(false);
		expect(chromeIsTiny(1440, 0.2)).toBe(false); // 288px on screen
	});

	it("hides it once the frame is narrower than the threshold", () => {
		expect(chromeIsTiny(1440, 0.04)).toBe(true); // 58px — the smear case
		expect(chromeIsTiny(320, 0.2)).toBe(true); // 64px, a small frame zoomed out
	});

	it("switches exactly at the threshold, in screen pixels", () => {
		const zoom = CHROME_MIN_PX / 1000;
		expect(chromeIsTiny(1000, zoom)).toBe(false); // exactly CHROME_MIN_PX
		expect(chromeIsTiny(999, zoom)).toBe(true);
	});

	it("depends on the frame's screen width, not on zoom alone", () => {
		// a big frame at a zoom where a small one has already given up
		expect(chromeIsTiny(4000, 0.05)).toBe(false); // 200px
		expect(chromeIsTiny(600, 0.05)).toBe(true); // 30px
	});
});
