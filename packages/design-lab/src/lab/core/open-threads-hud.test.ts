// @vitest-environment jsdom

/**
 * HUD: unresolved-thread count, T-toggled list, click-to-select + camera.
 * Numbers come from the G-429 feed projection, not from localStorage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
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
} as unknown as CanvasRenderingContext2D);

if (!HTMLElement.prototype.setPointerCapture) {
	HTMLElement.prototype.setPointerCapture = noop;
	HTMLElement.prototype.releasePointerCapture = noop;
	HTMLElement.prototype.hasPointerCapture = () => false;
}

import { InteractionLab } from "./lab-view";
import * as cam from "./animate-camera";
import { StickyNotes } from "./page-notes";
import type { LabObjects } from "../plugin-api";
import type { Rect } from "./types";

const AT = "2026-09-05T20:00:00.000Z";

function line(event: Record<string, unknown>): string {
	return `${JSON.stringify(event)}\n`;
}

const TWO_OPEN =
	line({
		t: "note",
		id: "n_aaaaaaaaaaaa",
		at: AT,
		author: "fei",
		screenId: "playground",
		x: 40,
		y: 80,
		text: "too tight",
	}) +
	line({
		t: "note",
		id: "n_bbbbbbbbbbbb",
		at: AT,
		author: "fei",
		screenId: "mosaic",
		x: 400,
		y: 80,
		text: "need more space",
	}) +
	line({
		t: "reply",
		id: "r_cccccccccccc",
		noteId: "n_aaaaaaaaaaaa",
		at: AT,
		author: "samantha",
		text: "24px now",
	});

const ONE_RESOLVED =
	TWO_OPEN +
	line({
		t: "resolve",
		noteId: "n_bbbbbbbbbbbb",
		at: AT,
		author: "samantha",
	});

const ALL_RESOLVED =
	ONE_RESOLVED +
	line({
		t: "resolve",
		noteId: "n_aaaaaaaaaaaa",
		at: AT,
		author: "fei",
	});

let feedText = TWO_OPEN;

function stubFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url) => {
			if (String(url).includes("/notes/threads")) {
				return {
					ok: true,
					json: async () => ({ ok: true, feed: feedText }),
				};
			}
			return { ok: true, json: async () => ({ ok: true }) };
		}),
	);
}

function stubObjects(): LabObjects {
	const layouts = new Map<string, Rect>();
	let sel: string | null = null;
	return {
		register(init) {
			layouts.set(init.id, { ...init.rect });
			init.el.setAttribute("data-lab-object", init.id);
		},
		unregister(id) {
			layouts.delete(id);
		},
		layout: (id) => (layouts.get(id) ? { ...layouts.get(id)! } : undefined),
		setLayout(id, rect) {
			layouts.set(id, rect);
		},
		beginMove() {},
		beginResize() {},
		select(id) {
			sel = id;
		},
		selectedId: () => sel,
	};
}

function dispatchKey(key: string, code: string, mods?: KeyboardEventInit) {
	return window.dispatchEvent(
		new KeyboardEvent("keydown", {
			key,
			code,
			bubbles: true,
			cancelable: true,
			...mods,
		}),
	);
}

describe("StickyNotes.threads is the G-429 map, not a localStorage recount", () => {
	let live: StickyNotes | null = null;

	beforeEach(() => {
		feedText = TWO_OPEN;
		stubFetch();
	});

	afterEach(() => {
		live?.destroy();
		live = null;
		document.body.innerHTML = "";
		localStorage.removeItem("interaction-lab:notes:v1");
	});

	it("counts two live notes, including the one she already replied to", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		live = new StickyNotes({
			host,
			objects: stubObjects(),
			storageKey: null,
			screenAt: () => "playground",
		});
		await vi.waitFor(() => {
			expect(live?.getNotes()).toHaveLength(2);
		});
		expect(live?.openThreadCount()).toBe(2);
	});

	it("drops a note from the count once the feed marks it resolved", async () => {
		feedText = ONE_RESOLVED;
		const host = document.createElement("div");
		document.body.appendChild(host);
		live = new StickyNotes({
			host,
			objects: stubObjects(),
			storageKey: null,
			screenAt: () => "playground",
		});
		await vi.waitFor(() => {
			expect(live?.getNotes()).toHaveLength(2);
		});
		expect(live?.openThreadCount()).toBe(1);
	});
});

describe("open-threads HUD", () => {
	let container: HTMLDivElement;
	let root: Root;
	let fly: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		feedText = TWO_OPEN;
		stubFetch();
		fly = vi.spyOn(cam, "animateCamera").mockImplementation(() => {});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(() => {
			root.render(
				createElement(StrictMode, null, createElement(InteractionLab)),
			);
		});
		await vi.waitFor(() => {
			expect(container.querySelectorAll(".sn-note").length).toBe(2);
		});
	});

	afterEach(() => {
		fly.mockRestore();
		act(() => root.unmount());
		container.remove();
		document.body.innerHTML = "";
		localStorage.removeItem("interaction-lab:notes:v1");
	});

	it("shows 2 on the HUD for two unresolved threads", async () => {
		await vi.waitFor(() => {
			expect(
				container
					.querySelector("[data-open-threads]")
					?.textContent?.replace(/\s+/g, ""),
			).toBe("2");
		});
	});

	it("the list is closed until T", () => {
		expect(container.querySelector("[data-thread-list]")).toBeNull();
	});

	it("T opens the list, T again closes it", async () => {
		await act(() => {
			dispatchKey("t", "KeyT");
		});
		const list = container.querySelector("[data-thread-list]");
		expect(list).toBeTruthy();
		expect(list?.closest("[data-lab-layer]")).toBeNull();
		const rows = container.querySelectorAll("[data-thread-row]");
		expect(rows).toHaveLength(2);
		expect(list?.textContent).toContain("Playground");
		expect(list?.textContent).toContain("too tight");
		expect(list?.textContent).toContain("Mosaic");
		expect(list?.textContent).toContain("need more space");
		expect(
			container.querySelector('[data-thread-row="n_aaaaaaaaaaaa"] [data-thread-replied]'),
		).toBeTruthy();
		expect(
			container.querySelector('[data-thread-row="n_bbbbbbbbbbbb"] [data-thread-replied]'),
		).toBeNull();
		expect(list?.textContent).not.toMatch(/这里显示|unresolved comments/i);

		await act(() => {
			dispatchKey("t", "KeyT");
		});
		expect(container.querySelector("[data-thread-list]")).toBeNull();

		await act(() => {
			(container.querySelector("[data-open-threads]") as HTMLElement).click();
		});
		expect(container.querySelector("[data-thread-list]")).toBeTruthy();
	});

	it("clicking a row selects that note and requests a camera fly", async () => {
		await act(() => {
			dispatchKey("t", "KeyT");
		});
		fly.mockClear();
		const row = container.querySelector(
			'[data-thread-row="n_aaaaaaaaaaaa"]',
		);
		expect(row).toBeTruthy();
		await act(() => {
			(row as HTMLElement).click();
		});
		const selected = container.querySelector(
			"[data-lab-object][data-selected]",
		);
		expect(selected).toBeTruthy();
		const objectId = selected?.getAttribute("data-lab-object");
		const notes = (
			window as unknown as {
				lab?: { plugin(id: string): { getNotes(): { id: number; fid: string }[] } };
			}
		).lab?.plugin("notes");
		const note = notes
			?.getNotes()
			.find((n) => `note:${n.id}` === objectId);
		expect(note?.fid).toBe("n_aaaaaaaaaaaa");
		expect(fly).toHaveBeenCalled();
	});
});

describe("open-threads HUD count edges", () => {
	let container: HTMLDivElement;
	let root: Root;

	async function mount(feed: string) {
		feedText = feed;
		stubFetch();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(() => {
			root.render(
				createElement(StrictMode, null, createElement(InteractionLab)),
			);
		});
		await vi.waitFor(() => {
			expect(container.querySelectorAll(".sn-note").length).toBeGreaterThan(0);
		});
	}

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		document.body.innerHTML = "";
		localStorage.removeItem("interaction-lab:notes:v1");
	});

	it("resolved notes do not show in the count", async () => {
		await mount(ONE_RESOLVED);
		await vi.waitFor(() => {
			expect(
				container
					.querySelector("[data-open-threads]")
					?.textContent?.replace(/\s+/g, ""),
			).toBe("1");
		});
	});

	it("the list hides resolved rows until the resolved control is on", async () => {
		await mount(ONE_RESOLVED);
		await act(() => {
			dispatchKey("t", "KeyT");
		});
		expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(1);
		const toggle = container.querySelector("[data-thread-resolved-toggle]");
		expect(toggle).toBeTruthy();
		await act(() => {
			(toggle as HTMLElement).click();
		});
		expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(2);
	});

	it("zero unresolved paints no digit", async () => {
		await mount(ALL_RESOLVED);
		await vi.waitFor(() => {
			expect(container.querySelector("[data-open-threads]")).toBeTruthy();
		});
		const btn = container.querySelector("[data-open-threads]");
		expect(btn?.textContent ?? "").not.toMatch(/0/);
		expect(btn?.textContent?.replace(/\s+/g, "")).toBe("");
	});
});

describe("open-threads chrome stays in the HUD language", () => {
	const css = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "lab.module.css"),
		"utf8",
	);

	it("the list is a floating overlay on the pill surface, not a new color language", () => {
		expect(css).toMatch(/\.threadList\s*\{[^}]*position:\s*absolute/);
		expect(css).toMatch(/\.threadList\s*\{[^}]*background:\s*var\(--lab-pill\)/);
		const list = css.match(/\.threadList\s*\{[^}]*\}/)?.[0] ?? "";
		expect(list).not.toMatch(/#e[0-9a-f]{2}|red|rgb\(\s*255\s*,\s*0/i);
	});
});
