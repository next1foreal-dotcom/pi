// @vitest-environment jsdom

/**
 * Canvas objects driven through the whole pipeline, in a mounted lab.
 *
 * The unit file next door checks the registry in isolation, which is exactly
 * why it missed the bug this file exists for: the eight resize handles were
 * appended, took the resize cursor, and had no listener on them — a sticky
 * could not be resized by dragging at all, and every isolated assertion about
 * the registry still passed. The gates here press the real handles in a real
 * mount, so "the decor is present" can never again stand in for "the decor
 * works".
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
	setTransform: noop, fillRect: noop, fillText: noop, beginPath: noop,
	moveTo: noop, lineTo: noop, stroke: noop, save: noop, restore: noop,
	translate: noop, rotate: noop, clearRect: noop,
	strokeStyle: "", fillStyle: "", font: "",
};
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
	mockCtx as unknown as CanvasRenderingContext2D,
);

if (!HTMLElement.prototype.setPointerCapture) {
	HTMLElement.prototype.setPointerCapture = noop;
	HTMLElement.prototype.releasePointerCapture = noop;
	HTMLElement.prototype.hasPointerCapture = () => false;
}

import { setCameraExact } from "./camera";
import { DRAG_THRESHOLD_PX, MIN_FRAME_W } from "./interaction-lab";
import { NOTE_DEFAULT, NOTE_MIN, type StickyNotes } from "./page-notes";
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

describe("a sticky is an ordinary canvas object", () => {
	let container: HTMLDivElement;
	let root: Root;
	let notes: StickyNotes;

	beforeAll(async () => {
		localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(() => {
			root.render(
				createElement(StrictMode, null, createElement(InteractionLab)),
			);
		});
		const api = window.lab?.plugin("notes") as StickyNotes | undefined;
		if (!api) throw new Error("notes plugin did not mount");
		notes = api;
	});

	afterAll(() => {
		act(() => root.unmount());
		container.remove();
		localStorage.clear();
	});

	/** A fresh note at page (0,0), camera at 1:1 so client px are page units. */
	async function freshNote() {
		notes.clearNotes();
		await act(() => {
			setCameraExact({ x: 0, y: 0, z: 1 });
		});
		const note = notes.spawn({ x: 0, y: 0 });
		const el = container.querySelector(`[data-lab-object="note:${note.id}"]`);
		if (!(el instanceof HTMLElement)) throw new Error("note is not registered");
		return { note, el };
	}

	async function dragFrom(
		target: HTMLElement,
		from: [number, number],
		to: [number, number],
	) {
		await act(() => {
			target.dispatchEvent(pointer("pointerdown", from[0], from[1]));
		});
		await act(() => {
			window.dispatchEvent(pointer("pointermove", to[0], to[1]));
		});
		await act(() => {
			window.dispatchEvent(pointer("pointerup", to[0], to[1]));
		});
	}

	it("draws the lab's own ring and eight handles, selected", async () => {
		const { el } = await freshNote();
		expect(el.querySelectorAll("[data-edge]").length).toBe(8);
		expect(el.hasAttribute("data-selected")).toBe(true);
	});

	it("a drag on the south-east handle resizes it", async () => {
		const { note, el } = await freshNote();
		const se = el.querySelector('[data-edge="se"]');
		if (!(se instanceof HTMLElement)) throw new Error("no se handle");
		await dragFrom(se, [240, 240], [340, 300]);
		expect(el.style.width).toBe(`${NOTE_DEFAULT + 100}px`);
		expect(el.style.height).toBe(`${NOTE_DEFAULT + 60}px`);
		// and the plugin was told, so it survives a reload
		expect(notes.getNotes().find((n) => n.id === note.id)?.w).toBe(
			NOTE_DEFAULT + 100,
		);
	});

	it("stops at the note's own floor, not the frame floor", async () => {
		const { el } = await freshNote();
		const se = el.querySelector('[data-edge="se"]');
		if (!(se instanceof HTMLElement)) throw new Error("no se handle");
		// Far past every floor in play. A frame would stop at 320.
		await dragFrom(se, [240, 240], [-400, -400]);
		expect(NOTE_MIN).toBeLessThan(MIN_FRAME_W);
		expect(el.style.width).toBe(`${NOTE_MIN}px`);
		expect(el.style.height).toBe(`${NOTE_MIN}px`);
	});

	it("moves by its bar, and a press under the threshold is still a click", async () => {
		const { note, el } = await freshNote();
		const bar = el.querySelector(".sn-bar");
		if (!(bar instanceof HTMLElement)) throw new Error("no bar");
		const before = el.style.transform;

		await dragFrom(bar, [50, 10], [50 + DRAG_THRESHOLD_PX - 1, 10]);
		expect(el.style.transform).toBe(before);

		await dragFrom(bar, [50, 10], [130, 70]);
		expect(el.style.transform).toBe("translate(80px, 60px)");
		expect(notes.getNotes().find((n) => n.id === note.id)?.x).toBe(80);
	});

	it("snaps to a screen's edge like any other canvas content", async () => {
		const { el } = await freshNote();
		const bar = el.querySelector(".sn-bar");
		if (!(bar instanceof HTMLElement)) throw new Error("no bar");
		// Screen 1 sits at page x = 0. Land the note's left edge 3px off it.
		await dragFrom(bar, [500, 500], [503, 700]);
		expect(el.style.transform).toContain("translate(0px,");
	});
});
