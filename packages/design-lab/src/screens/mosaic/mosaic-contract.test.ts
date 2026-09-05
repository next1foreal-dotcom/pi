// @vitest-environment jsdom

/**
 * The screen contract, checked against the one screen that can actually break
 * it. The other three screens are static pages: they never read a coordinate,
 * so they cannot get one wrong. This one does pointer maths, which is why it
 * was ported.
 *
 * The thing under test is a single equivalence. In a plain browser window
 * "one client pixel" and "one CSS pixel of my own layout" are the same
 * distance, so the Studio could read either and be right. Inside a lab frame a
 * camera transform sits between them, and the two readings diverge by exactly
 * the zoom factor. Everything below is a way of asking: does the divider still
 * land where the cursor is?
 *
 * jsdom has no layout engine, so `offsetWidth` is 0 and
 * `getBoundingClientRect()` is all zeroes no matter what CSS says. Both are
 * therefore stubbed, to the two DIFFERENT numbers a real browser would report
 * under a `scale()` transform: `offsetWidth` stays the laid-out width, the
 * rect comes back multiplied by the scale. That difference is the whole test —
 * an implementation that reads the wrong one gets a wrong answer here for the
 * same reason it would get a wrong answer on screen.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ScreenProvider, type ScreenState } from "../../lab/screen-context";
import { COL_MIN_PX, MosaicPaneHost } from "./components/MosaicPaneHost";
import type { MosaicModel } from "./model";

class MockResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

/** The host's laid-out width, in frame pixels. Wide enough that the 360px
 *  column floor is never in the way except where a test asks for it. */
const WIDTH = 3000;

/** Two columns, equal. `dividerFramePx` below reads straight off this shape. */
function twoColumns(): MosaicModel {
	return {
		v: 2,
		columns: [
			{ size: 50, panes: [{ id: "left", size: 100 }] },
			{ size: 50, panes: [{ id: "right", size: 100 }] },
		],
	};
}

/** The screen's shipped shape: three columns, five panes, two stacks. */
function fivePanes(): MosaicModel {
	return {
		v: 2,
		columns: [
			{
				size: 34,
				panes: [
					{ id: "bg", size: 55 },
					{ id: "tasks", size: 45 },
				],
			},
			{ size: 33, panes: [{ id: "browser", size: 100 }] },
			{
				size: 33,
				panes: [
					{ id: "terminal", size: 50 },
					{ id: "diff", size: 50 },
				],
			},
		],
	};
}

/**
 * Where the first divider sits, in FRAME pixels — the unit the user sees
 * inside the frame, and the unit the 360px floor is written in. Column sizes
 * are weights, so this is just the first weight's share of the laid-out width.
 */
function dividerFramePx(model: MosaicModel, width = WIDTH): number {
	const total = model.columns.reduce((a, c) => a + c.size, 0);
	return (model.columns[0].size / total) * width;
}

function screenEnv(over: Partial<ScreenState>): ScreenState {
	return {
		screenId: "mosaic",
		active: false,
		visible: true,
		frameSize: { width: WIDTH, height: 900 },
		zoom: 1,
		clientToFrame: (p) => ({ x: p.clientX, y: p.clientY }),
		setEscapeInterceptor: () => {},
		...over,
	};
}

function pointer(type: string, x: number, y: number): PointerEvent {
	return new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: x,
		clientY: y,
		button: 0,
		buttons: type === "pointerup" ? 0 : 1,
		pointerId: 1,
		isPrimary: true,
	});
}

/** Pin a getter jsdom leaves at 0 to the number a browser would report. */
function pin(el: HTMLElement, prop: "offsetWidth" | "offsetHeight", px: number) {
	Object.defineProperty(el, prop, { configurable: true, get: () => px });
}

type Mounted = {
	container: HTMLDivElement;
	root: Root;
	host: HTMLElement;
	/** Every model the component committed, in order. One per finished gesture. */
	committed: MosaicModel[];
	focusedPane(): string | null;
};

const open: Mounted[] = [];

afterEach(async () => {
	for (const m of open.splice(0)) {
		await act(async () => m.root.unmount());
		m.container.remove();
	}
});

async function mount(opts: {
	model?: MosaicModel;
	zoom?: number;
	active?: boolean;
	/** What `getBoundingClientRect().width` reports. Defaults to the browser's
	 *  answer under this zoom: the laid-out width times the scale. */
	rectWidth?: number;
	colHeight?: number;
}): Promise<Mounted> {
	const zoom = opts.zoom ?? 1;
	const model = opts.model ?? twoColumns();
	const committed: MosaicModel[] = [];

	const container = document.createElement("div");
	// A real CSS transform, the same one the lab's camera applies to the
	// screen layer. jsdom will not act on it, which is precisely why the two
	// measurements below have to be pinned by hand.
	container.style.transform = `scale(${zoom})`;
	container.style.transformOrigin = "0 0";
	document.body.appendChild(container);

	const root = createRoot(container);
	await act(async () => {
		root.render(
			createElement(
				ScreenProvider,
				{ value: screenEnv({ zoom, active: opts.active ?? false }) },
				createElement(MosaicPaneHost, {
					model,
					onLayout: (next: MosaicModel) => committed.push(next),
					renderPane: (id: string) => createElement("div", null, id),
				}),
			),
		);
	});

	const host = container.querySelector<HTMLElement>("[data-mosaic-host]");
	if (!host) throw new Error("mosaic host did not render");

	pin(host, "offsetWidth", WIDTH);
	const rectWidth = opts.rectWidth ?? WIDTH * zoom;
	host.getBoundingClientRect = () =>
		({ width: rectWidth, height: 900 * zoom, x: 0, y: 0, top: 0, left: 0, right: rectWidth, bottom: 900 * zoom }) as DOMRect;

	const colHeight = opts.colHeight ?? 900;
	for (const col of host.querySelectorAll<HTMLElement>("[data-col]")) {
		pin(col, "offsetHeight", colHeight);
		col.getBoundingClientRect = () =>
			({ width: rectWidth, height: colHeight * zoom, x: 0, y: 0, top: 0, left: 0, right: rectWidth, bottom: colHeight * zoom }) as DOMRect;
	}

	const m: Mounted = {
		container,
		root,
		host,
		committed,
		focusedPane: () =>
			host
				.querySelector<HTMLElement>("[data-pane][data-focused]")
				?.getAttribute("data-pane") ?? null,
	};
	open.push(m);
	return m;
}

/** Press the first column grip, move the pointer `clientDx` screen pixels, let go. */
async function dragColumnDivider(m: Mounted, clientDx: number): Promise<void> {
	const grip = m.host.querySelector<HTMLElement>('[aria-label="Resize columns"]');
	if (!grip) throw new Error("no column grip rendered");
	await act(async () => {
		grip.dispatchEvent(pointer("pointerdown", 0, 0));
	});
	await act(async () => {
		document.dispatchEvent(pointer("pointermove", clientDx, 0));
	});
	await act(async () => {
		document.dispatchEvent(pointer("pointerup", clientDx, 0));
	});
}

/** Press the first row grip, move the pointer `clientDy` screen pixels, let go. */
async function dragRowDivider(m: Mounted, clientDy: number): Promise<void> {
	const grip = m.host.querySelector<HTMLElement>('[aria-label="Resize panes"]');
	if (!grip) throw new Error("no row grip rendered");
	await act(async () => {
		grip.dispatchEvent(pointer("pointerdown", 0, 0));
	});
	await act(async () => {
		document.dispatchEvent(pointer("pointermove", 0, clientDy));
	});
	await act(async () => {
		document.dispatchEvent(pointer("pointerup", 0, clientDy));
	});
}

/** How far the column divider actually moved, in frame pixels. */
function movedFramePx(m: Mounted): number {
	const last = m.committed.at(-1);
	if (!last) throw new Error("the gesture committed nothing");
	return dividerFramePx(last) - dividerFramePx(twoColumns());
}

/** The same, downwards: how far the first row divider of column 0 moved. */
function movedRowFramePx(m: Mounted, height = 900): number {
	const last = m.committed.at(-1);
	if (!last) throw new Error("the gesture committed nothing");
	const at = (model: MosaicModel) => {
		const panes = model.columns[0].panes;
		const total = panes.reduce((a, p) => a + p.size, 0);
		return (panes[0].size / total) * height;
	};
	return at(last) - at(fivePanes());
}

describe("a divider drag is measured in frame pixels, not screen pixels", () => {
	// THE gate. A client pixel is `1 / zoom` frame pixels, so the same physical
	// gesture means different things at different zooms — and the divider has
	// to end up under the cursor in both.
	//
	// The three cases are deliberately three separate `it`s, one per zoom,
	// because the shape of the failure is the diagnosis. Delete the `/ scale`
	// in MosaicPaneHost's `onMove` and the zoom-1 case stays green while both
	// zoom-0.25 cases go red: invisible in a Studio window, four times wrong
	// at a fit-all zoom. That asymmetry IS the bug, and a single combined
	// assertion would hide it.

	it("at zoom 1, a 120 client pixel drag moves the divider 120 frame pixels", async () => {
		const m = await mount({ zoom: 1 });
		await dragColumnDivider(m, 120);
		expect(movedFramePx(m)).toBeCloseTo(120, 6);
	});

	it("at zoom 0.25, the same 120 FRAME pixel gesture moves the divider the same 120", async () => {
		// 120 frame pixels of travel at quarter scale is 30 client pixels of
		// mouse. Same gesture as the case above, in the units the mouse speaks.
		const m = await mount({ zoom: 0.25 });
		await dragColumnDivider(m, 30);
		expect(movedFramePx(m)).toBeCloseTo(120, 6);
	});

	it("at zoom 0.25, one CLIENT pixel is four frame pixels", async () => {
		// The same reading from the other side: hold the client distance fixed
		// and the frame distance must scale up as the camera pulls back, or the
		// divider falls behind the cursor.
		const m = await mount({ zoom: 0.25 });
		await dragColumnDivider(m, 120);
		expect(movedFramePx(m)).toBeCloseTo(480, 6);
	});

	it("measures a row divider the same way, off offsetHeight", async () => {
		// The vertical half of the same maths, and its own `/ scale` and its own
		// layout read (`colEl.offsetHeight`). 30 client px at quarter scale is
		// 120 frame px down; the 140px row floor is nowhere near.
		const m = await mount({ model: fivePanes(), zoom: 0.25 });
		await dragRowDivider(m, 30);
		expect(movedRowFramePx(m)).toBeCloseTo(120, 6);
	});

	it("commits once, on pointerup, not once per frame of the drag", async () => {
		const m = await mount({ zoom: 0.25 });
		await dragColumnDivider(m, 30);
		expect(m.committed).toHaveLength(1);
	});
});

describe("the resize maths reads layout, not a transformed rect", () => {
	// Under `scale(0.25)` the rect is a quarter of the truth. Reading it would
	// make every frame-pixel distance come out four times too big — the drag
	// "runs several times too fast" — and, worse, would inflate the 360px
	// column floor by the same factor, so the column would stop four times too
	// early. Both halves are asserted, because only the second one is
	// impossible to fake by accident.

	it("keeps the drag at frame speed when the rect is scaled away from the layout", async () => {
		const m = await mount({ zoom: 0.25, rectWidth: WIDTH * 0.25 });
		await dragColumnDivider(m, 30);
		// offsetWidth (3000) → 120. getBoundingClientRect().width (750) → 480.
		expect(movedFramePx(m)).toBeCloseTo(120, 6);
	});

	it("holds the 360px column floor in frame pixels", async () => {
		const m = await mount({ zoom: 0.25, rectWidth: WIDTH * 0.25 });
		// Far enough left to bury the floor: 1000 client px at quarter scale is
		// 4000 frame px, and the column only has 1500 to give.
		await dragColumnDivider(m, -1000);
		const stopped = dividerFramePx(m.committed.at(-1)!);
		// Read off the layout width the floor is 360 frame px. Read off the
		// scaled rect it would be 360 / 0.25 = 1440.
		expect(stopped).toBeCloseTo(COL_MIN_PX, 6);
	});
});

describe("an inert mosaic answers no keys", () => {
	// The keydown listener is on `window`, which is the whole document — so a
	// mosaic parked somewhere else on the canvas would answer ctrl+] aimed at
	// the lab. `active` is the gate. Both sides, because a listener that never
	// fires passes a one-sided test perfectly.

	async function pressCtrlBracketRight(): Promise<void> {
		await act(async () => {
			window.dispatchEvent(
				new KeyboardEvent("keydown", {
					code: "BracketRight",
					key: "]",
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
				}),
			);
		});
	}

	it("moves the focus ring when the screen is locked in", async () => {
		const m = await mount({ model: fivePanes(), active: true });
		expect(m.focusedPane()).toBe("bg");
		await pressCtrlBracketRight();
		expect(m.focusedPane()).toBe("tasks");
	});

	it("ignores the same key when the screen is inert", async () => {
		const m = await mount({ model: fivePanes(), active: false });
		expect(m.focusedPane()).toBe("bg");
		await pressCtrlBracketRight();
		expect(m.focusedPane()).toBe("bg");
	});

	it("does not take the caret away from the lab while inert", async () => {
		// The Studio pulls focus into the ringed pane so typing follows the
		// ring. On a canvas full of screens that would mean whichever mosaic
		// mounted last owned the keyboard.
		const before = document.activeElement;
		const m = await mount({ model: fivePanes(), active: false });
		expect(document.activeElement).toBe(before);
		expect(m.host.contains(document.activeElement)).toBe(false);
	});
});

describe("no screen measures the window or reaches across the document", () => {
	// A source-text gate over the whole folder, so it guards the three older
	// screens too, and so the next screen someone drops in inherits it.
	// Test files are excluded: they are allowed to talk about the thing they
	// are testing.
	// `fileURLToPath(import.meta.url)`, not `fileURLToPath(new URL(…))`: under
	// the jsdom environment the global `URL` is jsdom's, and node:url refuses
	// to read a foreign URL object ("The URL must be of scheme file").
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

	/**
	 * Comments are prose ABOUT these rules — the file explaining why it does
	 * not read a rect must be allowed to write the word. So the scan runs on
	 * code with comments removed. `[^:]` in front of `//` keeps a `https://`
	 * inside a string literal from being read as a line comment.
	 *
	 * Stripping is itself a measuring instrument, so it is checked below
	 * ("still has the code after stripping the prose") rather than trusted:
	 * a stripper that ate too much would turn every rule here green.
	 */
	function code(text: string): string {
		return text
			.replace(/\/\*[\s\S]*?\*\//g, " ")
			.replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
	}

	function sources(dir: string): { path: string; text: string }[] {
		const out: { path: string; text: string }[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) out.push(...sources(full));
			else if (
				/\.(ts|tsx|css)$/.test(entry.name) &&
				!entry.name.endsWith(".test.ts")
			) {
				out.push({ path: full, text: code(readFileSync(full, "utf8")) });
			}
		}
		return out;
	}

	const files = sources(root);

	it("finds the screens to scan", () => {
		// A gate over an empty list is a green light that means nothing.
		expect(files.length).toBeGreaterThan(8);
	});

	it("still has the code after stripping the prose", () => {
		// The positive control for `code()`. The mosaic host is the file with
		// the most comment in it and the only one whose comments name the
		// banned strings; if stripping is over-eager anywhere, it is here.
		const host = files.find((f) => f.path.endsWith("MosaicPaneHost.tsx"));
		expect(host).toBeDefined();
		expect(host?.text).toContain("host.offsetWidth");
		expect(host?.text).toContain("colEl.offsetHeight");
		expect(host?.text).toContain('window.addEventListener("keydown"');
	});

	it("never queries the document", () => {
		// One document holds every screen. `document.querySelector` in a screen
		// finds the OTHER screens' nodes too. Scope to the component's own ref.
		const hits = files.filter((f) => f.text.includes("document.querySelector"));
		expect(hits.map((f) => f.path)).toEqual([]);
	});

	it("never measures the window", () => {
		// The window is the lab. A screen's size is its frame's size, which is
		// `frameSize` from useScreen(), a ResizeObserver on its own root, or a
		// container query — never `window.innerWidth`.
		const hits = files.filter((f) =>
			/window\.(innerWidth|innerHeight|scrollY|scrollX)/.test(f.text),
		);
		expect(hits.map((f) => f.path)).toEqual([]);
	});

	it("never reads a transformed rect", () => {
		// Every rect inside a frame is multiplied by the camera zoom. Widths
		// and heights come from layout (`offsetWidth` / `clientWidth`), and
		// pointer positions come through `clientToFrame` or a `/ zoom`.
		const hits = files.filter((f) => f.text.includes("getBoundingClientRect"));
		expect(hits.map((f) => f.path)).toEqual([]);
	});
});
