// @vitest-environment jsdom

/**
 * A press is not a drag until the pointer travels. Without the threshold a
 * one-pixel tremor on a click moved the screen — and because a client pixel
 * is `1 / zoom` page units, at a fit-all zoom that is tens of page units,
 * written to the layout and persisted. This is the guard for that.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

class MockResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})),
});

const noop = () => {};
const mockCtx = {
	setTransform: noop,
	fillRect: noop,
	fillText: noop,
	beginPath: noop,
	moveTo: noop,
	lineTo: noop,
	stroke: noop,
	save: noop,
	restore: noop,
	translate: noop,
	rotate: noop,
	clearRect: noop,
	strokeStyle: "",
	fillStyle: "",
	font: "",
};
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
	mockCtx as unknown as CanvasRenderingContext2D,
);

// jsdom has PointerEvent but not pointer capture, which the canvas pan
// handler calls on every pointerdown.
if (!HTMLElement.prototype.setPointerCapture) {
	HTMLElement.prototype.setPointerCapture = noop;
	HTMLElement.prototype.releasePointerCapture = noop;
	HTMLElement.prototype.hasPointerCapture = () => false;
}

import { DRAG_THRESHOLD_PX } from "./interaction-lab";
import { InteractionLab } from "./lab-view";

function pointer(type: string, x: number, y: number, init: PointerEventInit = {}) {
	return new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: x,
		clientY: y,
		button: 0,
		buttons: type === "pointerup" ? 0 : 1,
		pointerId: 1,
		isPrimary: true,
		...init,
	});
}

describe("a click is not a drag", () => {
	let container: HTMLDivElement;
	let root: Root;
	let shield: HTMLElement;
	let group: HTMLElement;

	beforeAll(async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(() => {
			root.render(
				createElement(StrictMode, null, createElement(InteractionLab)),
			);
		});
		const g = [...container.querySelectorAll("[data-screen-id]")].find(
			(el) => el instanceof HTMLElement && el.querySelector("[data-screen-scroll]"),
		);
		if (!(g instanceof HTMLElement)) throw new Error("no screen frame rendered");
		group = g;
		const s = g.querySelector('[class*="shield"]');
		if (!(s instanceof HTMLElement)) throw new Error("no shield rendered");
		shield = s;
	});

	afterAll(() => {
		act(() => root.unmount());
		container.remove();
	});

	async function press(dx: number, dy: number) {
		const before = group.style.transform;
		await act(() => {
			shield.dispatchEvent(pointer("pointerdown", 500, 400));
		});
		await act(() => {
			window.dispatchEvent(pointer("pointermove", 500 + dx, 400 + dy));
		});
		await act(() => {
			window.dispatchEvent(pointer("pointerup", 500 + dx, 400 + dy));
		});
		return { before, after: group.style.transform };
	}

	it("does not move the screen when the pointer never moves", async () => {
		const { before, after } = await press(0, 0);
		expect(after).toBe(before);
	});

	it("does not move the screen on a one-pixel tremor", async () => {
		const { before, after } = await press(1, 0);
		expect(after).toBe(before);
	});

	it("still ignores movement just under the threshold", async () => {
		const { before, after } = await press(DRAG_THRESHOLD_PX - 1, 0);
		expect(after).toBe(before);
	});

	it("moves the screen once the pointer passes the threshold", async () => {
		const { before, after } = await press(DRAG_THRESHOLD_PX + 40, 30);
		expect(after).not.toBe(before);
	});
});
