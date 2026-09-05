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
import { peekUndo, popUndo } from "./history";
import { DRAG_THRESHOLD_PX, MIN_FRAME_W } from "./interaction-lab";
import type { Labels } from "./page-labels";
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

	/**
	 * The whole sticky is the drag surface. It used to be an 18-unit strip at
	 * the top — and 18 units is 18 PAGE units now, so at any zoom below 1 it is
	 * a few pixels of target and the note reads as immovable. FigJam's rule,
	 * and the one our own labels already follow: press anywhere to move, and a
	 * press that never travels is a click that starts typing.
	 */
	async function stopTyping(el: HTMLElement) {
		const text = el.querySelector(".sn-text");
		if (text instanceof HTMLElement) await act(() => text.blur());
		return text as HTMLElement;
	}

	it("moves when grabbed anywhere, not only by its bar", async () => {
		const { el } = await freshNote();
		const text = await stopTyping(el);
		await dragFrom(text, [120, 120], [200, 180]);
		expect(el.style.transform).toBe("translate(80px, 60px)");
	});

	it("a press on the body that never travels starts typing instead", async () => {
		const { el } = await freshNote();
		const text = await stopTyping(el);
		const before = el.style.transform;
		await dragFrom(text, [120, 120], [120 + DRAG_THRESHOLD_PX - 1, 120]);
		expect(el.style.transform).toBe(before);
		expect(document.activeElement).toBe(text);
	});

	it("once you are typing, a drag inside the text selects it and does not move the note", async () => {
		const { el } = await freshNote();
		const text = el.querySelector(".sn-text");
		if (!(text instanceof HTMLElement)) throw new Error("no text");
		await act(() => text.focus());
		const before = el.style.transform;
		await dragFrom(text, [120, 120], [200, 180]);
		expect(el.style.transform).toBe(before);
	});
});

/**
 * The same pipeline for an arrow label — the last screen-sized annotation, and
 * the one with a wrinkle a sticky does not have: its box is content-driven, so
 * the lab owns its position and NOT its size. The isolated file next door can
 * only see what the plugin hands across the seam; these press the real element
 * inside a real mount, which is where P1's real bug hid.
 */
describe("an arrow label is ordinary canvas content", () => {
	let container: HTMLDivElement;
	let root: Root;
	let labels: Labels;

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
		const api = window.lab?.plugin("labels") as Labels | undefined;
		if (!api) throw new Error("labels plugin did not mount");
		labels = api;
	});

	afterAll(() => {
		act(() => root.unmount());
		container.remove();
		localStorage.clear();
	});

	/** A fresh label, not being typed into, at a known camera. */
	async function freshLabel(x = 0, y = 0, z = 1) {
		labels.clearLabels();
		await act(() => {
			setCameraExact({ x: 0, y: 0, z });
		});
		const item = labels.spawn({ x, y, text: "hi" });
		const el = container.querySelector(`[data-lab-object="label:${item.id}"]`);
		if (!(el instanceof HTMLElement)) throw new Error("label is not registered");
		const text = el.querySelector(".lb-text");
		if (!(text instanceof HTMLElement)) throw new Error("no text");
		text.blur();
		const read = () => labels.getLabels().find((l) => l.id === item.id);
		return { item, el, text, read };
	}

	/** The lab listens on window in capture phase; the press is on the element. */
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

	/** The label's own handles run their own loop, on the label element. */
	async function handleDrag(
		handle: HTMLElement,
		el: HTMLElement,
		from: [number, number],
		to: [number, number],
	) {
		await act(() => {
			handle.dispatchEvent(pointer("pointerdown", from[0], from[1]));
		});
		await act(() => {
			el.dispatchEvent(pointer("pointermove", to[0], to[1]));
		});
		await act(() => {
			el.dispatchEvent(pointer("pointerup", to[0], to[1]));
		});
	}

	function labKey(key: string, init: KeyboardEventInit = {}) {
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key,
				...init,
			}),
		);
	}

	it("is registered content-sized: no ring, no eight handles, no lab size", async () => {
		const { el } = await freshLabel();
		expect(el.querySelectorAll("[data-edge]").length).toBe(0);
		expect(el.querySelector("[class*='ring']")).toBeNull();
		// Its own two controls — the real size and direction controls — remain.
		expect(el.querySelector(".lb-handle")).toBeTruthy();
		expect(el.querySelector(".lb-aim")).toBeTruthy();
		expect(el.style.transform).toBe("translate(0px, 0px)");
		expect(el.style.width).toBe("");
		expect(el.style.height).toBe("");
		expect(el.hasAttribute("data-selected")).toBe(true);
	});

	it("moves 1:1 in page units, and a press under the threshold is still a click", async () => {
		const { el, read } = await freshLabel();
		const before = el.style.transform;

		await dragFrom(el, [500, 500], [500 + DRAG_THRESHOLD_PX - 1, 500]);
		expect(el.style.transform).toBe(before);

		await dragFrom(el, [500, 500], [580, 560]);
		expect(el.style.transform).toBe("translate(80px, 60px)");
		expect(read()?.x).toBe(80);
		expect(read()?.y).toBe(60);
	});

	it("moves in PAGE units at a zoom other than 1", async () => {
		// The same 160x120 of hand movement is half as far across the page.
		const { el, read } = await freshLabel(0, 0, 2);
		await dragFrom(el, [500, 500], [660, 620]);
		expect(el.style.transform).toBe("translate(80px, 60px)");
		expect(read()?.x).toBe(80);
	});

	it("a clean tap on the text of a selected label starts editing, with no undo entry", async () => {
		const { text } = await freshLabel();
		while (peekUndo()) popUndo();
		expect(document.activeElement).not.toBe(text);

		await act(() => {
			text.dispatchEvent(pointer("pointerdown", 5, 5));
		});
		await act(() => {
			window.dispatchEvent(pointer("pointerup", 5, 5));
		});
		expect(document.activeElement).toBe(text);
		// Nothing moved, so there is nothing to undo.
		expect(peekUndo()).toBeNull();
	});

	it("snaps to a screen's edge, and Ctrl+Z puts it back", async () => {
		const { el, read } = await freshLabel(10, 300);
		// Screen 1 sits at page x = 0. Land the label's left edge 3px off it.
		await dragFrom(el, [500, 500], [493, 700]);
		expect(el.style.transform).toBe("translate(0px, 500px)");
		expect(read()?.x).toBe(0);

		await act(async () => {
			labKey("z", { code: "KeyZ", ctrlKey: true });
		});
		expect(el.style.transform).toBe("translate(10px, 300px)");
		expect(read()?.x).toBe(10);
		expect(read()?.y).toBe(300);
	});

	it("arrow keys nudge it by one page unit, ten with Shift", async () => {
		const { el, read } = await freshLabel(0, 0);
		labKey("ArrowRight");
		expect(el.style.transform).toBe("translate(1px, 0px)");
		labKey("ArrowDown", { shiftKey: true });
		expect(el.style.transform).toBe("translate(1px, 10px)");
		labKey("ArrowLeft");
		expect(el.style.transform).toBe("translate(0px, 10px)");
		// …and the run of nudges commits as one, back to the plugin.
		await new Promise((r) => setTimeout(r, 500));
		expect(read()?.x).toBe(0);
		expect(read()?.y).toBe(10);
	});

	it("the scale handle still scales it at a zoom other than 1", async () => {
		const { el, read } = await freshLabel(0, 0, 2);
		const handle = el.querySelector(".lb-handle");
		if (!(handle instanceof HTMLElement)) throw new Error("no scale handle");
		expect(read()?.scale).toBe(1);
		// beginScale works on a ratio of screen distances from the label's own
		// box, so the same drag means the same thing at any zoom.
		await handleDrag(handle, el, [24, 0], [48, 0]);
		expect(read()?.scale).toBe(2);
		expect(el.style.fontSize).toBe("40px");
	});

	it("the aim handle still turns the arrow at a zoom other than 1", async () => {
		const { el, read } = await freshLabel(0, 0, 0.5);
		const aim = el.querySelector(".lb-aim");
		if (!(aim instanceof HTMLElement)) throw new Error("no aim handle");
		expect(read()?.dir).toBe("dr");
		// Up and to the right of the label's centre: the "ur" quadrant.
		await handleDrag(aim, el, [0, 0], [100, -100]);
		expect(read()?.dir).toBe("ur");
		expect(el.dataset.dir).toBe("ur");
	});
});
