// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
	noteSize,
	noteSpawnTopLeft,
	sizeOrNull,
	StickyNotes,
	toolbarPlacement,
} from "./page-notes";

/**
 * The sticky is drawn at screen size, so two things can quietly drift apart:
 * the CSS that sizes it and the maths that centres it. Both are pinned here.
 */

let live: StickyNotes | null = null;

function mount(): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	live = new StickyNotes({ host, getZoom: () => 1 });
	return host;
}

afterEach(() => {
	live?.destroy();
	live = null;
	document.body.innerHTML = "";
});

describe("sticky size", () => {
	it("caps against a narrow pane but not a monitor", () => {
		expect(noteSize(2560)).toBe(240);
		expect(noteSize(1280)).toBe(240);
		// 800 is where the cap starts to bite.
		expect(noteSize(800)).toBe(240);
		expect(noteSize(519)).toBeCloseTo(155.7, 1);
		expect(noteSize(377)).toBeCloseTo(113.1, 1);
	});

	it("never lets the note take more than a third of the viewport", () => {
		for (const w of [320, 375, 519, 640, 800, 1024, 1440, 2560]) {
			expect(noteSize(w) / w).toBeLessThanOrEqual(0.3 + 1e-9);
		}
	});

	it("the injected CSS uses the same min() the maths does", () => {
		mount();
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		const m = css.match(/--sn-size:min\((\d+(?:\.\d+)?)px,(\d+(?:\.\d+)?)vw\)/);
		expect(m, "--sn-size declaration missing from the injected CSS").toBeTruthy();
		const maxPx = Number(m?.[1]);
		const vw = Number(m?.[2]) / 100;
		for (const w of [320, 519, 800, 1440, 2560]) {
			expect(Math.min(maxPx, w * vw)).toBeCloseTo(noteSize(w), 6);
		}
	});

	it("collapses to a strip that stays proportional to the note", () => {
		mount();
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		// A resized note keeps its own strip height; an untouched one falls
		// back through --sn-h to the responsive default.
		expect(css).toContain(
			"[data-compact]{height:calc(var(--sn-h,var(--sn-size)) *",
		);
	});
});

describe("spawn centring", () => {
	it("puts the note's middle on the point, not its corner", () => {
		const at = noteSpawnTopLeft({ x: 1000, y: 2000 }, 1, 1440);
		expect(at).toEqual({ x: 1000 - 120, y: 2000 - 120 });
	});

	it("offsets in page units, so it stays centred when zoomed out", () => {
		// This is the regression: half a note is half a *screen* note, so the
		// page-unit offset has to grow as the zoom shrinks. Drop the `/ zoom`
		// and this note lands with its corner on the point instead.
		const centre = { x: 1000, y: 2000 };
		const at = noteSpawnTopLeft(centre, 0.07, 1440);
		const halfPage = 120 / 0.07;
		expect(at.x).toBeCloseTo(1000 - halfPage, 6);
		expect(at.y).toBeCloseTo(2000 - halfPage, 6);
		// …and the offset really is ~14x the 100% one, not equal to it.
		expect(centre.x - at.x).toBeGreaterThan(14 * 120 * 0.99);
	});

	it("stays centred at every zoom the camera can reach", () => {
		for (const zoom of [0.02, 0.07, 0.5, 1, 2, 8]) {
			const at = noteSpawnTopLeft({ x: 0, y: 0 }, zoom, 1440);
			// Re-project the note's middle back to screen px: it must land on
			// the point regardless of zoom.
			const middleScreen = (at.x + 120 / zoom) * zoom;
			expect(middleScreen).toBeCloseTo(0, 6);
		}
	});
});

describe("toolbar placement", () => {
	it("sits above a note with headroom, below one without", () => {
		expect(toolbarPlacement({ top: 400, left: 100 }, 1440).flip).toBe(false);
		expect(toolbarPlacement({ top: 12, left: 100 }, 1440).flip).toBe(true);
	});

	it("reads the note's SCREEN top, not its page y", () => {
		// The regression: `note.y < FLIP_CLEAR` compared a page coordinate to a
		// screen-px clearance. A note parked far down the page can still be at
		// the top of the viewport once you scroll to it — it needs the flip.
		expect(toolbarPlacement({ top: 8, left: 100 }, 1440).flip).toBe(true);
		// …and one near the page origin that is scrolled into the middle of the
		// viewport must NOT flip.
		expect(toolbarPlacement({ top: 700, left: 100 }, 1440).flip).toBe(false);
	});

	it("anchors right when the toolbar would run past the edge", () => {
		// 519px pane, note at the right edge: 300 + 240 > 519.
		expect(toolbarPlacement({ top: 400, left: 300 }, 519).anchorRight).toBe(true);
		expect(toolbarPlacement({ top: 400, left: 40 }, 519).anchorRight).toBe(false);
	});

	it("leaves the toolbar left-anchored when there is room", () => {
		// Same note position on a wide monitor needs no flip at all.
		expect(toolbarPlacement({ top: 400, left: 300 }, 1440).anchorRight).toBe(false);
	});

	it("keeps the toolbar on-screen for every note position on a narrow pane", () => {
		const TOOLBAR = 240;
		const pane = 519;
		const note = noteSize(pane);
		for (let left = 0; left <= pane - note; left += 8) {
			const { anchorRight } = toolbarPlacement({ top: 400, left }, pane);
			// Right-anchored: the toolbar hangs left off the note's right edge.
			const l = anchorRight ? left + note - TOOLBAR : left;
			const r = l + TOOLBAR;
			expect(r, `right edge at left=${left}`).toBeLessThanOrEqual(pane);
		}
	});

	it("the CSS actually re-anchors the toolbar and its trays", () => {
		mount();
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		expect(css).toContain("[data-tb-right] .sn-toolbar{left:auto;right:0}");
		expect(css).toContain("[data-tb-right] .sn-pop{left:auto;right:0}");
	});
});

/**
 * The pure function above can only ever be handed a rect, so it cannot catch
 * the caller reverting to `note.y < FLIP_CLEAR`. These drive the real class
 * with a stubbed rect: page y and screen top are deliberately opposite, so a
 * caller reading the wrong one flips the wrong way.
 */
describe("toolbar placement reads the screen rect, not the page position", () => {
	function stubRect(el: Element, top: number, left: number) {
		Object.defineProperty(el, "getBoundingClientRect", {
			configurable: true,
			value: () => ({ top, left, right: left, bottom: top, width: 0, height: 0 }),
		});
	}

	/** Select `a` by clicking it while `b` holds the selection. */
	function reselect(host: HTMLElement, index: number) {
		const el = host.querySelectorAll<HTMLElement>(".sn-note")[index];
		el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		return el;
	}

	it("flips a note parked deep in the page but sitting at the viewport top", () => {
		const host = mount();
		live?.spawn({ x: 0, y: 5000 });
		live?.spawn({ x: 0, y: 6000 }); // takes the selection
		const a = host.querySelectorAll<HTMLElement>(".sn-note")[0];
		stubRect(a, 8, 100); // page y 5000, but 8px from the top of the screen
		reselect(host, 0);
		expect(a.hasAttribute("data-flip")).toBe(true);
	});

	it("does not flip a note near the page origin sitting mid-viewport", () => {
		const host = mount();
		live?.spawn({ x: 0, y: 10 });
		live?.spawn({ x: 0, y: 20 });
		const a = host.querySelectorAll<HTMLElement>(".sn-note")[0];
		stubRect(a, 700, 100); // page y 10, but 700px down the screen
		reselect(host, 0);
		expect(a.hasAttribute("data-flip")).toBe(false);
	});

	it("re-anchors the toolbar when the note nears the right edge", () => {
		const host = mount();
		live?.spawn({ x: 0, y: 400 });
		live?.spawn({ x: 0, y: 500 });
		const a = host.querySelectorAll<HTMLElement>(".sn-note")[0];
		stubRect(a, 400, window.innerWidth - 120);
		reselect(host, 0);
		expect(a.hasAttribute("data-tb-right")).toBe(true);
	});
});

describe("note resizing", () => {
	it("clamps a stored dimension and rejects anything that is not one", () => {
		expect(sizeOrNull(300)).toBe(300);
		expect(sizeOrNull(10)).toBe(96); // floor: a bar plus one word
		expect(sizeOrNull(99999)).toBe(1200);
		expect(sizeOrNull(240.6)).toBe(241);
		for (const junk of [undefined, null, "240", NaN, Infinity, {}])
			expect(sizeOrNull(junk), String(junk)).toBeNull();
	});

	it("a fresh note has no explicit size, so it follows the default", () => {
		mount();
		const n = live?.spawn({ x: 0, y: 0 });
		expect(n?.w).toBeNull();
		expect(n?.h).toBeNull();
		const el = document.querySelector<HTMLElement>(".sn-note");
		expect(el?.style.getPropertyValue("--sn-w")).toBe("");
		expect(el?.style.getPropertyValue("--sn-h")).toBe("");
	});

	it("setSize writes screen px onto the element and survives a reset", () => {
		mount();
		const n = live?.spawn({ x: 0, y: 0});
		const el = document.querySelector<HTMLElement>(".sn-note");
		live?.setSize(n?.id ?? 0, 420, 300);
		expect(el?.style.getPropertyValue("--sn-w")).toBe("420px");
		expect(el?.style.getPropertyValue("--sn-h")).toBe("300px");
		expect(live?.getNotes()[0].w).toBe(420);
		live?.resetSize(n?.id ?? 0);
		// Removed, not zeroed -- the CSS fallback is what restores the default.
		expect(el?.style.getPropertyValue("--sn-w")).toBe("");
		expect(live?.getNotes()[0].w).toBeNull();
	});

	it("setSize clamps rather than letting a note collapse or run away", () => {
		mount();
		const n = live?.spawn({ x: 0, y: 0 });
		live?.setSize(n?.id ?? 0, -50, 4000);
		expect(live?.getNotes()[0].w).toBe(96);
		expect(live?.getNotes()[0].h).toBe(1200);
	});

	it("a resized note comes back the same size after a reload", async () => {
		const key = "test:notes:resize";
		localStorage.removeItem(key);
		const h1 = document.createElement("div");
		document.body.appendChild(h1);
		const a = new StickyNotes({ host: h1, getZoom: () => 1, storageKey: key });
		const n = a.spawn({ x: 5, y: 6 });
		a.setSize(n.id, 333, 222);
		// the write is debounced 150ms; let it actually land
		await new Promise((r) => setTimeout(r, 220));
		a.destroy();

		const h2 = document.createElement("div");
		document.body.appendChild(h2);
		live = new StickyNotes({ host: h2, getZoom: () => 1, storageKey: key });
		expect(live.getNotes()[0].w).toBe(333);
		expect(live.getNotes()[0].h).toBe(222);
		localStorage.removeItem(key);
	});

	it("the grip only shows on a selected note that is not collapsed", () => {
		mount();
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		expect(css).toContain(".sn-handle{");
		expect(css).toContain(
			'.sn-note[data-selected]:not([data-compact]) .sn-handle{display:block}',
		);
	});
});
