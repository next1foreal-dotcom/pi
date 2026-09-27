import type { Mode, Rect } from "../core/types";
import { isValidRect } from "../spotlight/geometry";
import { type WorkAt, workKey } from "./work";

export type Point = { x: number; y: number };

const CHIP_GAP = 6;
const CHIP_NUDGE = 10;
const CHIP_PAD = 16;
const CHIP_CHAR = 6.6;
const CHIP_MAX = 240;
const CHIP_MIN = 48;
const CHIP_HEIGHT = 22;

/** The black chip sizes to its sentence. Height stays one line. */
export function chipBox(label: string): { width: number; height: number } {
	const n = label.trim().length;
	const width = Math.min(CHIP_MAX, Math.max(CHIP_MIN, CHIP_PAD + Math.round(n * CHIP_CHAR)));
	return { width, height: CHIP_HEIGHT };
}

/**
 * Where the cursor and its chip sit, in the same page space as the node.
 *
 * The cursor is inside the box — working on it, not pointing at a frame around
 * it. The chip rides the cursor the way sample 7's comment rides the hand.
 */
export function placeHand(
	box: Rect,
	chip: { width: number; height: number },
): { cursor: Point; chip: Point } {
	const cursor = {
		x: box.x + box.width * 0.72,
		y: box.y + box.height * 0.62,
	};
	return {
		cursor,
		chip: {
			x: cursor.x + CHIP_NUDGE,
			y: cursor.y - chip.height - CHIP_GAP,
		},
	};
}

/** The node she is on, not the screen the camera flew to. */
export function nodeRect(rects: readonly Rect[]): Rect | null {
	const valid = rects.filter(isValidRect);
	if (valid.length === 0) return null;
	return valid.reduce((a, b) => (a.width * a.height <= b.width * b.height ? a : b));
}

export type HandSel = { component: string | null; tag: string | null };

export function handLabel(sel: HandSel | null): string {
	const component = sel?.component?.trim();
	if (component) return component;
	const tag = sel?.tag?.trim();
	if (tag) return tag;
	return "writing";
}

export type MarkedRect = { screenId: string; rect: Rect };

/** Fill/focus: the screen he is in. Explore: the whole board. */
export function watchedScreenId(state: {
	mode: Mode;
	focusedId: string | null;
}): string | null {
	switch (state.mode) {
		case "fill":
		case "focus": {
			const id = state.focusedId;
			return typeof id === "string" && id.length > 0 ? id : null;
		}
		case "explore":
			return null;
		default: {
			const _never: never = state.mode;
			return _never;
		}
	}
}

/**
 * HMR mutates every screen on the board. The smallest box is often a
 * neighbour (loora sits at x=3400). Keep only the screen he is watching.
 */
export function rectsOnWatchedScreen(
	items: readonly MarkedRect[],
	watchedId: string | null,
): Rect[] {
	const scoped = watchedId
		? items.filter((item) => item.screenId === watchedId)
		: items;
	return scoped.map((item) => item.rect);
}

export type WorkMark = {
	screenId: string;
	rect: Rect;
	label: string;
	/** Source locations on this node's owner chain, `file:line:column`. */
	keys?: readonly string[];
};

function area(rect: Rect): number {
	return rect.width * rect.height;
}

function largestMark(items: readonly WorkMark[]): WorkMark {
	return items.reduce((a, b) => (area(b.rect) > area(a.rect) ? b : a));
}

/**
 * The node she wrote, not the smallest box a remount happens to emit.
 *
 * A Tile write owns both the Tile root and its ticks. The root is larger.
 * With no write, the smallest box still wins (a node plus its screen frame).
 * With a write and nothing owned in the batch, return null — do not fall
 * through to an input that happened to remount on the same screen.
 */
export function pickWorkMark(
	items: readonly WorkMark[],
	watchedId: string | null,
	work: WorkAt | null,
): WorkMark | null {
	const scoped = watchedId
		? items.filter((item) => item.screenId === watchedId)
		: items;
	if (scoped.length === 0) return null;
	if (work) {
		const key = workKey(work);
		const owned = scoped.filter((item) => (item.keys ?? []).includes(key));
		if (owned.length === 0) return null;
		return largestMark(owned);
	}
	const rect = nodeRect(scoped.map((item) => item.rect));
	if (!rect) return null;
	return scoped.find((item) => item.rect === rect) ?? null;
}
