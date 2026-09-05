// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screenToPage } from "./math";
import {
	cycleDirection,
	DEFAULT_LABELS_KEY,
	directionFromAim,
	Labels,
	MIRROR,
	viewportDeltaToPage,
	type LabelDirection,
} from "./page-labels";

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
		const host = document.createElement("div");
		document.body.appendChild(host);
		const labels = new Labels({
			host,
			getZoom: () => 1,
			storageKey: null,
		});
		const item = labels.spawn({ x: 0, y: 0, dir: "dr", text: "a" });
		labels.setDirection(item.id, "ul");
		const el = host.querySelector(".lb-label");
		expect(el?.getAttribute("data-dir")).toBe("ul");
		expect(labels.getLabels()[0]?.dir).toBe("ul");
		labels.destroy();
		host.remove();
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

	it("pointer deltas convert to page units by dividing zoom", () => {
		expect(viewportDeltaToPage(40, 20, 2)).toEqual({ x: 20, y: 10 });
		expect(viewportDeltaToPage(40, 20, 0)).toEqual({ x: 40, y: 20 });
	});

	it("stores spawn coordinates as page units (not viewport-clamped)", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const labels = new Labels({
			host,
			getZoom: () => 2,
			storageKey: null,
		});
		labels.spawn({ x: 190, y: 130, text: "here" });
		const item = labels.getLabels()[0];
		expect(item?.x).toBe(190);
		expect(item?.y).toBe(130);
		const el = host.querySelector(".lb-label") as HTMLElement;
		// The transform also carries the counter scale that keeps a label at
		// screen size (pinned-tools.test.ts owns that half); this one is only
		// about the coordinates being page units.
		expect(el.style.transform).toContain("translate3d(190px,130px,0)");
		labels.destroy();
		host.remove();
	});

	it("drag divides the pointer delta by zoom so page coords stay glued", () => {
		HTMLElement.prototype.setPointerCapture ??= function () {};
		HTMLElement.prototype.releasePointerCapture ??= function () {};
		const host = document.createElement("div");
		document.body.appendChild(host);
		const labels = new Labels({
			host,
			getZoom: () => 2,
			storageKey: null,
		});
		labels.spawn({ x: 100, y: 100, text: "drag" });
		const el = host.querySelector(".lb-label") as HTMLElement;
		const text = el.querySelector(".lb-text") as HTMLElement;
		text.blur();

		el.dispatchEvent(
			new PointerEvent("pointerdown", {
				button: 0,
				clientX: 0,
				clientY: 0,
				pointerId: 1,
				bubbles: true,
				cancelable: true,
			}),
		);
		el.dispatchEvent(
			new PointerEvent("pointermove", {
				clientX: 40,
				clientY: 20,
				pointerId: 1,
				bubbles: true,
				cancelable: true,
			}),
		);
		el.dispatchEvent(
			new PointerEvent("pointerup", {
				pointerId: 1,
				bubbles: true,
				cancelable: true,
			}),
		);

		const item = labels.getLabels()[0];
		expect(item?.x).toBe(120);
		expect(item?.y).toBe(110);
		labels.destroy();
		host.remove();
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
		const host = document.createElement("div");
		document.body.appendChild(host);
		const labels = new Labels({ host, getZoom: () => 1, storageKey: key });
		labels.spawn({ x: 10, y: 20, scale: 1.5, dir: "ul", text: "hi" });
		vi.advanceTimersByTime(200);
		const raw = localStorage.getItem(key);
		expect(raw).toBeTruthy();
		expect(JSON.parse(raw as string)).toEqual({
			v: 1,
			items: [{ x: 10, y: 20, s: 1.5, d: "ul", t: "hi" }],
		});
		labels.destroy();
		host.remove();
	});

	it("reloads page coordinates without clamping to the viewport", () => {
		localStorage.setItem(
			key,
			JSON.stringify({
				v: 1,
				items: [{ x: 9999, y: -40, s: 2, d: "ur", t: "far" }],
			}),
		);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const labels = new Labels({ host, getZoom: () => 1, storageKey: key });
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
		labels.destroy();
		host.remove();
	});

	it("default storage key follows notes convention", () => {
		expect(DEFAULT_LABELS_KEY).toBe("interaction-lab:labels:v1");
	});
});

describe("handleKey intercept vs passthrough", () => {
	let host: HTMLDivElement;
	let labels: Labels;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		labels = new Labels({ host, getZoom: () => 1, storageKey: null });
	});

	afterEach(() => {
		labels.destroy();
		host.remove();
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

	it("R / F / Delete / arrows / Esc are consumed when a label is selected", () => {
		labels.spawn({ x: 0, y: 0, dir: "dr", text: "sel" });
		const text = host.querySelector(".lb-text") as HTMLElement;
		text.blur();

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

		expect(
			labels.handleKey(key({ key: "ArrowRight", shiftKey: true }), spawnAt),
		).toBe(true);
		expect(labels.getLabels()[0]?.x).toBe(10);

		expect(labels.handleKey(key({ key: "Escape" }), spawnAt)).toBe(true);
		expect(labels.handleKey(key({ key: "Delete" }), spawnAt)).toBe(false);
	});

	it("Delete removes the selected label", () => {
		labels.spawn({ x: 0, y: 0, text: "bye" });
		(host.querySelector(".lb-text") as HTMLElement).blur();
		expect(labels.handleKey(key({ key: "Delete" }), spawnAt)).toBe(true);
		expect(labels.getLabels()).toHaveLength(0);
	});

	it("Shift+R and Shift+F are not eaten (ruler / fill-toggle)", () => {
		labels.spawn({ x: 0, y: 0, dir: "dr" as LabelDirection, text: "x" });
		(host.querySelector(".lb-text") as HTMLElement).blur();
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
		const text = host.querySelector(".lb-text") as HTMLElement;
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
		const text = host.querySelector(".lb-text") as HTMLElement;
		const e = key({ key: "Escape" });
		Object.defineProperty(e, "target", { value: text });
		expect(labels.handleKey(e, spawnAt)).toBe(true);
	});
});
