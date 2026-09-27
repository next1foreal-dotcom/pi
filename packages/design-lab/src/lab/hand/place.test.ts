import { describe, expect, it } from "vitest";
import {
	chipBox,
	handLabel,
	nodeRect,
	pickWorkMark,
	placeHand,
	rectsOnWatchedScreen,
	watchedScreenId,
} from "./place";
import type { WorkAt } from "./work";

/**
 * Her hand sits on the node she is working, not on a camera frame around it.
 *
 * Sample 7: a cursor plus a chip pinned to the thing being born. The spotlight
 * box is a region the camera flies to; the hand is smaller and more specific.
 */

const NODE = { x: 40, y: 80, width: 120, height: 48 };
const CHIP = { width: 72, height: 22 };

describe("the hand pins to a node, not a grown frame", () => {
	it("puts the cursor inside the node and the chip next to it", () => {
		const placed = placeHand(NODE, CHIP);
		expect(placed.cursor.x).toBeGreaterThan(NODE.x);
		expect(placed.cursor.x).toBeLessThan(NODE.x + NODE.width);
		expect(placed.cursor.y).toBeGreaterThan(NODE.y);
		expect(placed.cursor.y).toBeLessThan(NODE.y + NODE.height);
		expect(placed.chip.x).toBeGreaterThanOrEqual(NODE.x);
		expect(placed.chip.x).toBeLessThan(NODE.x + NODE.width + CHIP.width);
		expect(Math.abs(placed.chip.y - placed.cursor.y)).toBeLessThan(CHIP.height + 24);
	});

	it("picks the smallest mutation box when several fire at once", () => {
		const screen = { x: 0, y: 0, width: 1440, height: 900 };
		const node = { x: 200, y: 120, width: 64, height: 28 };
		expect(nodeRect([screen, node])).toEqual(node);
		expect(nodeRect([])).toBeNull();
	});

	it("names the selected component when there is one, else the work itself", () => {
		expect(handLabel({ component: "Tile", tag: "section" })).toBe("Tile");
		expect(handLabel({ component: null, tag: "h1" })).toBe("h1");
		expect(handLabel(null)).toBe("writing");
	});

	it("a sentence chip is wider than a nameplate, still one line", () => {
		const name = chipBox("Tile");
		const sentence = chipBox("tone → loud");
		expect(name.height).toBe(22);
		expect(sentence.height).toBe(22);
		expect(sentence.width).toBeGreaterThan(name.width);
		expect(sentence.width).toBeLessThanOrEqual(240);
	});
});

/**
 * Live fill on playground: the hand sat at translate(3399px) — loora-landing's
 * origin — because HMR mutates every screen and the smallest box on the board
 * won. The chip said PlaygroundScreen (last selection), the rect was a neighbour.
 */
const TILE = { x: 40, y: 80, width: 120, height: 48 };
const LOORA_TINY = { x: 3400, y: 0, width: 18, height: 18 };

describe("the hand stays on the screen he is watching", () => {
	it("the globally smallest box is a neighbour at x=3400", () => {
		expect(nodeRect([TILE, LOORA_TINY])).toEqual(LOORA_TINY);
	});

	it("fill/focus keep only that screen's boxes", () => {
		expect(watchedScreenId({ mode: "fill", focusedId: "playground" })).toBe(
			"playground",
		);
		expect(watchedScreenId({ mode: "focus", focusedId: "playground" })).toBe(
			"playground",
		);
		expect(watchedScreenId({ mode: "explore", focusedId: "playground" })).toBeNull();
	});

	it("drops the neighbour so the tile on this screen is what pins", () => {
		const items = [
			{ screenId: "playground", rect: TILE },
			{ screenId: "loora-landing", rect: LOORA_TINY },
		];
		expect(nodeRect(rectsOnWatchedScreen(items, "playground"))).toEqual(TILE);
		expect(nodeRect(rectsOnWatchedScreen(items, null))).toEqual(LOORA_TINY);
		expect(nodeRect(rectsOnWatchedScreen(items, "playground"))).not.toEqual(
			LOORA_TINY,
		);
	});
});

/**
 * Live fill: after loud, the hand sat on the text input. HMR remounts the
 * whole PlaygroundScreen; the smallest box on that screen is the field, not
 * the Tile whose tone just changed. The write is screen.tsx:49 `<Tile>`.
 */
const SCREEN_FILE =
	"packages/design-lab/src/screens/playground/screen.tsx";
const TILE_WORK: WorkAt = {
	file: SCREEN_FILE,
	line: 49,
	column: 11,
	label: "Tile",
};
const TILE_KEY = `${SCREEN_FILE}:49:11`;
const INPUT = { x: 24, y: 180, width: 220, height: 36 };
const TILE_BOX = { x: 24, y: 240, width: 320, height: 140 };
const TICK = { x: 40, y: 360, width: 6, height: 18 };

describe("the hand pins to the node she wrote, not the smallest remount box", () => {
	const remount = [
		{
			screenId: "playground",
			rect: INPUT,
			label: "PlaygroundScreen",
			keys: [`${SCREEN_FILE}:39:10`],
		},
		{
			screenId: "playground",
			rect: TILE_BOX,
			label: "Tile",
			keys: [TILE_KEY],
		},
		{
			screenId: "playground",
			rect: TICK,
			label: "Tile",
			keys: [TILE_KEY],
		},
	];

	it("without a write, the smallest box on the remount is the tick", () => {
		expect(pickWorkMark(remount, "playground", null)?.rect).toEqual(TICK);
	});

	it("a Tile write pins the Tile root, not the input and not a tick", () => {
		const hit = pickWorkMark(remount, "playground", TILE_WORK);
		expect(hit?.rect).toEqual(TILE_BOX);
		expect(hit?.label).toBe("Tile");
	});

	it("a write does not fall through to the input when no owned box is in the batch", () => {
		const onlyInput = [remount[0]];
		expect(pickWorkMark(onlyInput, "playground", TILE_WORK)).toBeNull();
	});
});
