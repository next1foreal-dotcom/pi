// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { getHand, hideHand, pinHandFromWork } from "../hand/store";
import { notifySpotlightGesture } from "./attach";

const NODE = { x: 40, y: 80, width: 120, height: 48 };

describe("the hand stays when the clock overlay goes; his gesture yields it", () => {
	afterEach(() => {
		hideHand();
	});

	it("a pan or zoom puts the hand away", () => {
		pinHandFromWork([NODE], "Tile");
		notifySpotlightGesture();
		expect(getHand()).toBeNull();
	});
});
