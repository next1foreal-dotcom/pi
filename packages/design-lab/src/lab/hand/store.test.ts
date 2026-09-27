// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { getHand, hideHand, pinHandFromWork, pinHandOnWatched, setHand, subscribeHand } from "./store";
import { noteWork } from "./work";
import type { WorkAt } from "./work";

const NODE = { x: 40, y: 80, width: 120, height: 48 };
const SCREEN = { x: 0, y: 0, width: 1440, height: 900 };

describe("her hand on the canvas", () => {
	afterEach(() => {
		hideHand();
		noteWork(null);
	});

	it("pins a cursor and a chip to the node she is working", () => {
		pinHandFromWork([SCREEN, NODE], "Tile");
		const snap = getHand();
		expect(snap).not.toBeNull();
		expect(snap?.label).toBe("Tile");
		expect(snap?.rect).toEqual(NODE);
	});

	it("a new pin replaces the last one", () => {
		pinHandFromWork([NODE], "Tile");
		const next = { x: 8, y: 8, width: 20, height: 12 };
		pinHandFromWork([next], "writing");
		expect(getHand()?.rect).toEqual(next);
		expect(getHand()?.label).toBe("writing");
	});

	it("hide clears both", () => {
		setHand({ rect: NODE, label: "Tile" });
		let heard = 0;
		const stop = subscribeHand(() => {
			heard += 1;
		});
		hideHand();
		stop();
		expect(getHand()).toBeNull();
		expect(heard).toBe(1);
	});

	it("does not invent a hand from an empty mutation", () => {
		pinHandFromWork([], "Tile");
		expect(getHand()).toBeNull();
	});

	it("fill on playground does not pin a neighbour at x=3400", () => {
		const tile = { x: 40, y: 80, width: 120, height: 48 };
		const loora = { x: 3400, y: 0, width: 18, height: 18 };
		pinHandOnWatched(
			[
				{ screenId: "playground", rect: tile, label: "Tile" },
				{ screenId: "loora-landing", rect: loora, label: "LooraLandingScreen" },
			],
			"playground",
		);
		expect(getHand()?.rect).toEqual(tile);
		expect(getHand()?.label).toBe("Tile");
	});

	it("a neighbour-only mutation does not move the hand off this screen", () => {
		pinHandFromWork([NODE], "Tile");
		pinHandOnWatched(
			[{ screenId: "loora-landing", rect: { x: 3400, y: 0, width: 18, height: 18 }, label: "section" }],
			"playground",
		);
		expect(getHand()?.rect).toEqual(NODE);
		expect(getHand()?.label).toBe("Tile");
	});

	it("a remount pins the Tile she wrote, not the smallest input", () => {
		const file = "packages/design-lab/src/screens/playground/screen.tsx";
		const work: WorkAt = { file, line: 49, column: 11, label: "tone → loud" };
		const key = `${file}:49:11`;
		const input = { x: 24, y: 180, width: 220, height: 36 };
		const tile = { x: 24, y: 240, width: 320, height: 140 };
		pinHandOnWatched(
			[
				{
					screenId: "playground",
					rect: input,
					label: "PlaygroundScreen",
					keys: [`${file}:39:10`],
				},
				{ screenId: "playground", rect: tile, label: "Tile", keys: [key] },
			],
			"playground",
			work,
		);
		expect(getHand()?.rect).toEqual(tile);
		expect(getHand()?.label).toBe("tone → loud");
	});
});
