// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	NOTE_DEFAULT,
	NOTE_MIN,
	noteSpawnTopLeft,
	sizeOrDefault,
	StickyNotes,
	toolbarPlacement,
} from "./page-notes";
import type { LabObjectInit, LabObjects } from "../plugin-api";
import type { Point, Rect } from "./types";

let live: StickyNotes | null = null;

function stubObjects(): LabObjects & { inits: Map<string, LabObjectInit> } {
	const layouts = new Map<string, Rect>();
	const inits = new Map<string, LabObjectInit>();
	let sel: string | null = null;
	return {
		inits,
		register(init) {
			layouts.set(init.id, { ...init.rect });
			inits.set(init.id, init);
			init.el.setAttribute("data-lab-object", init.id);
			init.el.style.transform = `translate(${init.rect.x}px, ${init.rect.y}px)`;
			init.el.style.width = `${init.rect.width}px`;
			init.el.style.height = `${init.rect.height}px`;
		},
		unregister(id) { layouts.delete(id); inits.delete(id); },
		layout: (id) => layouts.get(id) ? { ...layouts.get(id)! } : undefined,
		setLayout(id, rect) {
			layouts.set(id, rect);
			const entry = inits.get(id);
			if (entry) entry.onSelect?.(false); // onLayout would be here too
		},
		beginMove() {},
		beginResize() {},
		select(id) {
			const prev = sel;
			if (prev === id) return;
			if (prev != null) {
				const p = inits.get(prev);
				if (p) { p.el.removeAttribute("data-selected"); p.onSelect?.(false); }
			}
			sel = id;
			if (id != null) {
				const n = inits.get(id);
				if (n) { n.el.setAttribute("data-selected", ""); n.onSelect?.(true); }
			}
		},
		selectedId: () => sel,
	};
}

function mount(): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	live = new StickyNotes({ host, objects: stubObjects() });
	return host;
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => ({ ok: true, feed: "" }),
		})),
	);
});

afterEach(() => {
	live?.destroy();
	live = null;
	document.body.innerHTML = "";
	localStorage.removeItem("interaction-lab:notes:v1");
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("spawn centring (page-only, no zoom)", () => {
	it("puts the note's middle on the point, not its corner", () => {
		const at = noteSpawnTopLeft({ x: 1000, y: 2000 });
		expect(at).toEqual({ x: 1000 - 120, y: 2000 - 120 });
	});

	it("does not need zoom — the same offset at any zoom", () => {
		// With page-sized notes, the offset is always half of NOTE_DEFAULT
		const a = noteSpawnTopLeft({ x: 500, y: 600 });
		expect(a.x).toBe(500 - NOTE_DEFAULT / 2);
		expect(a.y).toBe(600 - NOTE_DEFAULT / 2);
	});
});

describe("toolbar placement", () => {
	it("sits above a note with headroom, below one without", () => {
		expect(toolbarPlacement({ top: 400, left: 100, width: 240 }, 1440).flip).toBe(false);
		expect(toolbarPlacement({ top: 12, left: 100, width: 240 }, 1440).flip).toBe(true);
	});

	it("reads the note's SCREEN top, not its page y", () => {
		expect(toolbarPlacement({ top: 8, left: 100, width: 240 }, 1440).flip).toBe(true);
		expect(toolbarPlacement({ top: 700, left: 100, width: 240 }, 1440).flip).toBe(false);
	});

	it("centres the toolbar on the note when there is room on both sides", () => {
		expect(toolbarPlacement({ top: 400, left: 300, width: 240 }, 1440).anchor).toBe(
			"centre",
		);
		// A note far smaller than the toolbar is the case centring exists for.
		expect(toolbarPlacement({ top: 400, left: 700, width: 30 }, 1440).anchor).toBe(
			"centre",
		);
	});

	it("takes the right edge when a centred toolbar would run past it", () => {
		// centre 420 + half a toolbar (120) is past 519
		expect(toolbarPlacement({ top: 400, left: 300, width: 240 }, 519).anchor).toBe(
			"right",
		);
		expect(toolbarPlacement({ top: 400, left: 160, width: 240 }, 519).anchor).toBe(
			"centre",
		);
	});

	it("takes the left edge when a centred toolbar would run off it", () => {
		// A small note hugging the left edge: centred, the bar would start at -105
		expect(toolbarPlacement({ top: 400, left: 0, width: 30 }, 1440).anchor).toBe(
			"left",
		);
	});

	it("the CSS carries all three anchors and moves the trays with them", () => {
		mount();
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		// centred is the default state, on .sn-toolbar itself
		expect(css).toContain("left:50%");
		expect(css).toContain("--tb-x:-50%");
		expect(css).toContain("[data-tb-left] .sn-toolbar{left:0;--tb-x:0px;--tb-ox:0%}");
		expect(css).toContain(
			"[data-tb-right] .sn-toolbar{left:auto;right:0;--tb-x:0px;--tb-ox:100%}",
		);
		expect(css).toContain("[data-tb-right] .sn-pop{left:auto;right:0}");
	});
});

describe("toolbar placement reads the screen rect, not the page position", () => {
	function stubRect(el: Element, top: number, left: number) {
		Object.defineProperty(el, "getBoundingClientRect", {
			configurable: true,
			value: () => ({ top, left, right: left + 240, bottom: top, width: 240, height: 240 }),
		});
	}

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
		expect(a.hasAttribute("data-tb-left")).toBe(false);
	});
});

describe("note resizing (page units)", () => {
	it("sizeOrDefault clamps to floor and defaults non-numbers to 240", () => {
		expect(sizeOrDefault(300)).toBe(300);
		expect(sizeOrDefault(10)).toBe(NOTE_MIN); // floor
		expect(sizeOrDefault(240.6)).toBe(241);
		// non-number / null / undefined all default to 240
		for (const junk of [undefined, null, "240", NaN, Infinity, {}])
			expect(sizeOrDefault(junk), String(junk)).toBe(NOTE_DEFAULT);
	});

	it("a fresh note has explicit default size (240x240)", () => {
		mount();
		const n = live?.spawn({ x: 0, y: 0 });
		expect(n?.w).toBe(NOTE_DEFAULT);
		expect(n?.h).toBe(NOTE_DEFAULT);
	});

	it("setSize goes through the LabObjects stub and clamps the floor", () => {
		mount();
		const n = live?.spawn({ x: 0, y: 0 });
		live?.setSize(n?.id ?? 0, 420, 300);
		expect(live?.getNotes()[0].w).toBe(420);
		expect(live?.getNotes()[0].h).toBe(300);
		// no ceiling
		live?.setSize(n?.id ?? 0, 5000, 3000);
		expect(live?.getNotes()[0].w).toBe(5000);
		expect(live?.getNotes()[0].h).toBe(3000);
		// floor
		live?.setSize(n?.id ?? 0, -50, 10);
		expect(live?.getNotes()[0].w).toBe(NOTE_MIN);
		expect(live?.getNotes()[0].h).toBe(NOTE_MIN);
	});

	it("resetSize returns to 240x240", () => {
		mount();
		const n = live?.spawn({ x: 0, y: 0 });
		live?.setSize(n?.id ?? 0, 420, 300);
		live?.resetSize(n?.id ?? 0);
		expect(live?.getNotes()[0].w).toBe(NOTE_DEFAULT);
		expect(live?.getNotes()[0].h).toBe(NOTE_DEFAULT);
	});

	it("a resized note comes back the same size after a reload", async () => {
		const key = "test:notes:resize";
		localStorage.removeItem(key);
		const h1 = document.createElement("div");
		document.body.appendChild(h1);
		const a = new StickyNotes({ host: h1, objects: stubObjects(), storageKey: key });
		const n = a.spawn({ x: 5, y: 6 });
		a.setSize(n.id, 333, 222);
		// the write is debounced 150ms; let it actually land
		await new Promise((r) => setTimeout(r, 220));
		a.destroy();

		const h2 = document.createElement("div");
		document.body.appendChild(h2);
		live = new StickyNotes({ host: h2, objects: stubObjects(), storageKey: key });
		expect(live.getNotes()[0].w).toBe(333);
		expect(live.getNotes()[0].h).toBe(222);
		localStorage.removeItem(key);
	});
});

/**
 * A note drawn around an area has to keep the area. Held as fractions of its
 * screen, like the note's own anchor, so it follows the screen being moved or
 * resized -- and kept apart from that anchor on purpose: dragging the sticky
 * somewhere with more room must not drag what it is a remark about.
 *
 * Both sides. "Every note draws a box" would pass the first of these and put a
 * stray rectangle under every note anyone has ever pinned.
 */
describe("a note about an area", () => {
	const SCREEN = { x: 1000, y: 2000, width: 1440, height: 900 };

	function labWithScreen(storageKey: string | null) {
		const host = document.createElement("div");
		document.body.appendChild(host);
		return new StickyNotes({
			host,
			objects: stubObjects(),
			storageKey,
			screenAt: () => "main-landing",
			screenLayout: () => ({ ...SCREEN }),
		});
	}

	it("stores the drawn rect as fractions of its screen", () => {
		live = labWithScreen(null);
		const note = live.spawn({
			x: 2000,
			y: 2100,
			regionPage: { x: 1360, y: 2090, width: 720, height: 450 },
		});
		expect(note.region).toEqual({
			screenId: "main-landing",
			rx: (1360 - 1000) / 1440,
			ry: (2090 - 2000) / 900,
			rw: 720 / 1440,
			rh: 450 / 900,
		});
	});

	it("draws it back at the page rect it was drawn at", () => {
		live = labWithScreen(null);
		live.spawn({
			x: 2000,
			y: 2100,
			regionPage: { x: 1360, y: 2090, width: 720, height: 450 },
		});
		const el = document.querySelector(".sn-region") as HTMLElement | null;
		expect(el).not.toBeNull();
		expect(el?.style.transform).toBe("translate(1360px, 2090px)");
		expect(el?.style.width).toBe("720px");
		expect(el?.style.height).toBe("450px");
	});

	it("an ordinary pinned note draws no box at all", () => {
		live = labWithScreen(null);
		live.spawn({ x: 2000, y: 2100 });
		expect(document.querySelector(".sn-region")).toBeNull();
	});

	it("deleting the note takes its box with it", () => {
		live = labWithScreen(null);
		const note = live.spawn({
			x: 2000,
			y: 2100,
			regionPage: { x: 1360, y: 2090, width: 720, height: 450 },
		});
		expect(document.querySelector(".sn-region")).not.toBeNull();
		live.removeNote(note.id);
		expect(document.querySelector(".sn-region")).toBeNull();
	});

	it("comes back after a reload, box and source both", async () => {
		// The source used to be dropped here: a note knew which line it was about
		// right up until you closed the tab, which is most of the value of knowing.
		const key = "test:notes:region";
		localStorage.removeItem(key);
		const a = labWithScreen(key);
		a.spawn({
			x: 2000,
			y: 2100,
			regionPage: { x: 1360, y: 2090, width: 720, height: 450 },
			source: { file: "packages/x/src/a.tsx", line: 12, col: 3, component: "A" },
		});
		await new Promise((r) => setTimeout(r, 220));
		a.destroy();
		document.body.innerHTML = "";

		live = labWithScreen(key);
		const back = live.getNotes()[0];
		expect(back.region).toEqual({
			screenId: "main-landing",
			rx: (1360 - 1000) / 1440,
			ry: (2090 - 2000) / 900,
			rw: 720 / 1440,
			rh: 450 / 900,
		});
		expect(back.source).toEqual({
			file: "packages/x/src/a.tsx",
			line: 12,
			col: 3,
			component: "A",
		});
		expect(
			(document.querySelector(".sn-region") as HTMLElement | null)?.style
				.transform,
		).toBe("translate(1360px, 2090px)");
		localStorage.removeItem(key);
	});
});

describe("injected CSS migration checks", () => {
	it("the .sn-note rule has no scale(var(--inv-zoom (toolbar is allowed to)", () => {
		mount();
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		// Extract just the .sn-note{...} rule
		const noteRule = css.match(/\.sn-note\{[^}]*\}/)?.[0] ?? "";
		expect(noteRule).not.toContain("scale(var(--inv-zoom");
		// The toolbar IS allowed to counter-scale
		expect(css).toContain(".sn-toolbar{");
	});

	it("the injected CSS has no 30vw", () => {
		mount();
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		expect(css).not.toContain("30vw");
	});
});

describe("a sticky reads as something you can pick up", () => {
	it("the note carries the grab cursor and the text does not fight it", () => {
		mount();
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		const note = css.match(/\.sn-note\{[^}]*\}/)?.[0] ?? "";
		const text = css.match(/\.sn-text\{[^}]*\}/)?.[0] ?? "";
		expect(note).toContain("cursor:grab");
		// The text used to end its own rule with `cursor:text`, which won on
		// specificity order and put a caret over the whole note.
		expect(text).toContain("cursor:inherit");
		expect(text).not.toContain("cursor:text");
		// …and the caret comes back the moment you are actually in it.
		expect(css).toContain(".sn-text:focus{cursor:text}");
	});
});

function eventPosts(): { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] {
	return vi.mocked(fetch).mock.calls
		.filter(([url]) => String(url).includes("/notes/event"))
		.map(([url, init]) => {
			const request = (init ?? {}) as {
				headers?: Record<string, string>;
				body?: string;
			};
			return {
				url: String(url),
				headers: request.headers ?? {},
				body: JSON.parse(request.body ?? "{}") as Record<string, unknown>,
			};
		});
}

describe("feed id and localStorage", () => {
	it("gives a new note n_ + 12 hex and writes it as fi", async () => {
		const key = "test:notes:fid";
		localStorage.removeItem(key);
		const host = document.createElement("div");
		document.body.appendChild(host);
		live = new StickyNotes({ host, objects: stubObjects(), storageKey: key });
		const n = live.spawn({ x: 0, y: 0 });
		expect(n.fid).toMatch(/^n_[0-9a-f]{12}$/);
		await new Promise((r) => setTimeout(r, 220));
		const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as {
			notes: { fi?: string }[];
		};
		expect(stored.notes[0]?.fi).toBe(n.fid);
		localStorage.removeItem(key);
	});

	it("fills a fid for old payloads that have none", () => {
		const key = "test:notes:fid-legacy";
		localStorage.setItem(
			key,
			JSON.stringify({
				v: 1,
				notes: [
					{
						x: 1,
						y: 2,
						c: "yellow",
						f: "medium",
						k: false,
						t: "old",
						h: "old",
					},
				],
			}),
		);
		const host = document.createElement("div");
		document.body.appendChild(host);
		live = new StickyNotes({ host, objects: stubObjects(), storageKey: key });
		expect(live.getNotes()[0]?.fid).toMatch(/^n_[0-9a-f]{12}$/);
		localStorage.removeItem(key);
	});
});

describe("canvas events posted to the feed", () => {
	function mountWithScreen(
		screenAt: (point: Point) => string | null = () => "playground",
	) {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const objects = stubObjects();
		live = new StickyNotes({ host, objects, storageKey: null, screenAt });
		return { host, objects };
	}

	it("spawn posts a note with screen, position and text, never an author", () => {
		mountWithScreen();
		const n = live?.spawn({ x: 40, y: 80, text: "too tight" });
		const posts = eventPosts();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.headers["x-lab-canvas"]).toBe("1");
		expect(posts[0]?.body).toMatchObject({
			t: "note",
			id: n?.fid,
			screenId: "playground",
			x: 40,
			y: 80,
			text: "too tight",
		});
		expect(posts[0]?.body).not.toHaveProperty("author");
	});

	it("text changes post note.edit after the 150ms persist debounce", async () => {
		const { host } = mountWithScreen();
		const n = live?.spawn({ x: 0, y: 0 });
		const text = host.querySelector(".sn-text");
		expect(text).toBeInstanceOf(HTMLElement);
		(text as HTMLElement).textContent = "spacing is tight";
		text?.dispatchEvent(new Event("input", { bubbles: true }));
		expect(eventPosts().filter((p) => p.body.t === "note.edit")).toHaveLength(0);
		await new Promise((r) => setTimeout(r, 220));
		const edits = eventPosts().filter((p) => p.body.t === "note.edit");
		expect(edits).toHaveLength(1);
		expect(edits[0]?.body).toMatchObject({
			t: "note.edit",
			id: n?.fid,
			text: "spacing is tight",
		});
		expect(edits[0]?.body).not.toHaveProperty("author");
	});

	it("a committed move posts note.move with a fresh screenId", () => {
		const { objects } = mountWithScreen((p) =>
			p.x >= 1640 ? "product-list" : "playground",
		);
		const n = live?.spawn({ x: 10, y: 20 });
		const init = objects.inits.get(`note:${n?.id}`);
		init?.onLayout?.({ x: 1700, y: 40, width: 240, height: 240 });
		const moves = eventPosts().filter((p) => p.body.t === "note.move");
		expect(moves).toHaveLength(1);
		expect(moves[0]?.body).toMatchObject({
			t: "note.move",
			id: n?.fid,
			screenId: "product-list",
			x: 1700,
			y: 40,
		});
	});

	it("removeNote posts note.delete", () => {
		mountWithScreen();
		const n = live?.spawn({ x: 0, y: 0 });
		live?.removeNote(n?.id ?? 0);
		const deletes = eventPosts().filter((p) => p.body.t === "note.delete");
		expect(deletes).toHaveLength(1);
		expect(deletes[0]?.body).toMatchObject({ t: "note.delete", id: n?.fid });
	});

	it("spawn with source posts it as a repo-relative path and paints the caption", () => {
		const { host } = mountWithScreen();
		const source = {
			file: "src/screens/playground/screen.tsx",
			line: 19,
			col: 25,
			component: "PlaygroundScreen",
		};
		const n = live?.spawn({ x: 40, y: 80, source });
		const posts = eventPosts().filter((p) => p.body.t === "note");
		expect(posts[0]?.body.source).toEqual(source);
		expect(JSON.stringify(posts[0]?.body.source)).not.toContain(
			"http://localhost:5180",
		);
		expect(host.querySelector(".sn-source")?.textContent).toBe("screen.tsx:19");
		expect(n?.source).toEqual(source);
	});

	it("a move of a sourced note keeps source on note.move", () => {
		const { objects } = mountWithScreen();
		const source = {
			file: "src/screens/playground/screen.tsx",
			line: 19,
			col: 25,
			component: "PlaygroundScreen",
		};
		const n = live?.spawn({ x: 10, y: 20, source });
		const init = objects.inits.get(`note:${n?.id}`);
		init?.onLayout?.({ x: 50, y: 60, width: 240, height: 240 });
		const moves = eventPosts().filter((p) => p.body.t === "note.move");
		expect(moves[0]?.body.source).toEqual(source);
	});
});

/**
 * Until now only the "speak about this element" gesture handed a note a source;
 * a note pinned by ordinary clicking carried none, which is why the real feed
 * has never once contained one. An ordinary pin now asks the inspect plugin what
 * it landed on.
 *
 * The whole risk is in the word "asks". The lookup goes out to a plugin that may
 * not be mounted, over a point that may be empty canvas, into React internals
 * that may not be readable. None of that is allowed to cost him a note he typed:
 * the location is a convenience looked up on his behalf, the note is the thing
 * he actually said.
 */
describe("an ordinary pin looks up what it landed on", () => {
	const AT_BUTTON = {
		screenId: "playground",
		file: "packages/design-lab/src/screens/playground/screen.tsx",
		line: 19,
		column: 25,
		component: "PlaygroundScreen",
		tag: "button",
		className: "cta",
		text: "Buy",
		attached: true,
		problem: null,
	};
	/** The same place, in the shape the note event has always used (`col`). */
	const AS_NOTE_SOURCE = {
		file: "packages/design-lab/src/screens/playground/screen.tsx",
		line: 19,
		col: 25,
		component: "PlaygroundScreen",
	};

	function mountPinned(): { objects: ReturnType<typeof stubObjects> } {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const objects = stubObjects();
		live = new StickyNotes({
			host,
			objects,
			storageKey: null,
			screenAt: () => "playground",
		});
		return { objects };
	}

	/** Stand in for `window.lab`, publishing one plugin's api. */
	function stubInspect(api: unknown): void {
		vi.stubGlobal("lab", {
			plugin: (id: string) => (id === "inspect" ? api : undefined),
			plugins: () => ["inspect"],
			describe: () => [],
			help: () => ({}),
			tokens: { preview: () => {} },
		});
	}

	it("posts the file and line under the pin, reading the plugin's column as col", () => {
		const asked: Array<[number, number]> = [];
		stubInspect({
			selectAt: (x: number, y: number) => {
				asked.push([x, y]);
				return AT_BUTTON;
			},
			clear: () => {},
		});
		mountPinned();

		const n = live?.spawn({ x: 40, y: 80 });

		// The MIDDLE of the note, not its top-left: noteSpawnTopLeft centres a
		// fresh note on the point he pinned, so the middle is where he pointed.
		expect(asked).toEqual([[40 + NOTE_DEFAULT / 2, 80 + NOTE_DEFAULT / 2]]);
		expect(n?.source).toEqual(AS_NOTE_SOURCE);
		expect(eventPosts().find((p) => p.body.t === "note")?.body.source).toEqual(
			AS_NOTE_SOURCE,
		);
	});

	it("keeps the note and every word of it when the resolver throws", () => {
		stubInspect({
			selectAt: () => {
				throw new Error("no fiber here");
			},
		});
		mountPinned();

		const n = live?.spawn({ x: 40, y: 80, text: "this gap is too tight" });

		expect(n?.source).toBeUndefined();
		expect(live?.getNotes()).toHaveLength(1);
		expect(live?.getNotes()[0]?.text).toBe("this gap is too tight");
		const posted = eventPosts().find((p) => p.body.t === "note");
		expect(posted?.body.text).toBe("this gap is too tight");
		expect(posted?.body).not.toHaveProperty("source");
	});

	it("no plugin mounted, and empty canvas under the point, both mean no location", () => {
		mountPinned(); // nothing ever published window.lab
		expect(live?.spawn({ x: 0, y: 0, text: "no plugin" })?.source).toBeUndefined();

		stubInspect({ selectAt: () => null, clear: () => {} });
		expect(live?.spawn({ x: 600, y: 600, text: "empty canvas" })?.source).toBeUndefined();

		const notes = eventPosts().filter((p) => p.body.t === "note");
		expect(notes).toHaveLength(2);
		for (const p of notes) expect(p.body).not.toHaveProperty("source");
	});

	it("drops a half-resolved location rather than half-filling one", () => {
		// A production React build has no _debugStack, so file/line/column come
		// back null together. Anything short of all three is not somewhere she
		// can open, and a 0 column would be a fact nobody established.
		stubInspect({ selectAt: () => ({ ...AT_BUTTON, column: null }), clear: () => {} });
		mountPinned();

		expect(live?.spawn({ x: 40, y: 80 })?.source).toBeUndefined();
	});

	it("dragging the pin does not re-resolve it onto whatever it landed on", () => {
		let answer: unknown = AT_BUTTON;
		let asked = 0;
		stubInspect({
			selectAt: () => {
				asked += 1;
				return answer;
			},
			clear: () => {},
		});
		const { objects } = mountPinned();
		const n = live?.spawn({ x: 10, y: 20 });
		expect(asked).toBe(1);

		// He drags it clear across the canvas, over a different screen entirely.
		answer = {
			...AT_BUTTON,
			file: "packages/design-lab/src/screens/mosaic/screen.tsx",
			line: 4,
			column: 2,
			component: "MosaicScreen",
		};
		objects.inits
			.get(`note:${n?.id}`)
			?.onLayout?.({ x: 900, y: 40, width: 240, height: 240 });

		expect(asked).toBe(1);
		expect(eventPosts().find((p) => p.body.t === "note.move")?.body.source).toEqual(
			AS_NOTE_SOURCE,
		);
		expect(live?.getNotes()[0]?.source).toEqual(AS_NOTE_SOURCE);
	});

	it("takes a source it was handed as given, without asking the plugin", () => {
		let asked = 0;
		stubInspect({
			selectAt: () => {
				asked += 1;
				return AT_BUTTON;
			},
			clear: () => {},
		});
		mountPinned();

		const given = {
			file: "packages/design-lab/src/screens/mosaic/screen.tsx",
			line: 4,
			col: 2,
			component: null,
		};
		expect(live?.spawn({ x: 40, y: 80, source: given })?.source).toEqual(given);
		expect(asked).toBe(0);
	});

	it("does not leave the inspector's outline painted on the canvas", () => {
		// selectAt selects, which paints. Pinning a note is not asking to inspect.
		let cleared = 0;
		stubInspect({
			selectAt: () => AT_BUTTON,
			clear: () => {
				cleared += 1;
			},
		});
		mountPinned();

		live?.spawn({ x: 40, y: 80 });
		expect(cleared).toBe(1);
	});
});

describe("replies and resolved state on the sticky", () => {
	it("the stylesheet paints replies as canvas content and a quiet resolved mark", () => {
		mount();
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		expect(css).toContain(".sn-replies{");
		expect(css).toContain('.sn-reply[data-author="samantha"]');
		expect(css).toContain("[data-resolved]");
		const repliesRule = css.match(/\.sn-replies\{[^}]*\}/)?.[0] ?? "";
		expect(repliesRule).not.toContain("--inv-zoom");
	});

	it("keeps .sn-text{flex:1} so blank space is still the editor", () => {
		mount();
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		const text = css.match(/\.sn-text\{[^}]*\}/)?.[0] ?? "";
		expect(text).toContain("flex:1");
		expect(css).toContain(".sn-body{");
		expect(css).toContain(".sn-blank{");
		const repliesRule = css.match(/\.sn-replies\{[^}]*\}/)?.[0] ?? "";
		expect(repliesRule).not.toContain("margin-top:auto");
		expect(repliesRule).toContain("flex:none");
	});

	it("clicking the leftover blank still starts typing when a reply is present", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const objects = stubObjects();
		objects.beginMove = (_e, _id, opts) => {
			opts?.onClick?.();
		};
		live = new StickyNotes({
			host,
			objects,
			storageKey: null,
			screenAt: () => "playground",
		});
		const n = live.spawn({ x: 0, y: 0, text: "too tight" });
		const text = host.querySelector(".sn-text");
		if (!(text instanceof HTMLElement)) throw new Error("no text");
		text.blur();
		vi.mocked(fetch).mockImplementation(async (url) => {
			if (String(url).includes("/notes/threads")) {
				const feed = `${JSON.stringify({
					t: "reply",
					id: "r_aaaaaaaaaaaa",
					noteId: n.fid,
					at: "2026-09-05T20:00:00.000Z",
					author: "samantha",
					text: "24px now",
				})}\n`;
				return {
					ok: true,
					json: async () => ({ ok: true, feed }),
				} as unknown as Response;
			}
			return {
				ok: true,
				json: async () => ({ ok: true }),
			} as unknown as Response;
		});
		Object.defineProperty(document, "hidden", {
			configurable: true,
			get: () => false,
		});
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.waitFor(() => {
			expect(host.querySelector(".sn-reply")?.textContent).toContain("24px now");
		});
		expect(document.activeElement).not.toBe(text);
		const blank = host.querySelector(".sn-blank");
		expect(blank).toBeInstanceOf(HTMLElement);
		blank?.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				cancelable: true,
				button: 0,
			}),
		);
		expect(document.activeElement).toBe(text);
	});

	it("pulls her reply onto the note and marks it resolved", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		live = new StickyNotes({
			host,
			objects: stubObjects(),
			storageKey: null,
			screenAt: () => "playground",
		});
		const n = live.spawn({ x: 0, y: 0, text: "too tight" });
		vi.mocked(fetch).mockImplementation(async (url) => {
			if (String(url).includes("/notes/threads")) {
				const feed =
					`${JSON.stringify({
						t: "reply",
						id: "r_aaaaaaaaaaaa",
						noteId: n.fid,
						at: "2026-09-05T20:00:00.000Z",
						author: "samantha",
						text: "24px now",
					})}\n` +
					`${JSON.stringify({
						t: "resolve",
						noteId: n.fid,
						at: "2026-09-05T20:01:00.000Z",
						author: "samantha",
					})}\n`;
				return {
					ok: true,
					json: async () => ({ ok: true, feed }),
				} as unknown as Response;
			}
			return {
				ok: true,
				json: async () => ({ ok: true }),
			} as unknown as Response;
		});
		Object.defineProperty(document, "hidden", {
			configurable: true,
			get: () => false,
		});
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.waitFor(() => {
			const reply = host.querySelector(".sn-reply");
			expect(reply?.getAttribute("data-author")).toBe("samantha");
			expect(reply?.textContent).toContain("24px now");
			expect(host.querySelector(".sn-note")?.hasAttribute("data-resolved")).toBe(
				true,
			);
		});
	});
});

function mockThreads(feed: string) {
	vi.mocked(fetch).mockImplementation(async (url) => {
		if (String(url).includes("/notes/threads")) {
			return {
				ok: true,
				json: async () => ({ ok: true, feed }),
			} as unknown as Response;
		}
		return {
			ok: true,
			json: async () => ({ ok: true }),
		} as unknown as Response;
	});
}

function eventLine(event: Record<string, unknown>): string {
	return `${JSON.stringify(event)}\n`;
}

async function pullNow() {
	Object.defineProperty(document, "hidden", {
		configurable: true,
		get: () => false,
	});
	document.dispatchEvent(new Event("visibilitychange"));
}

describe("feed is the source of truth, localStorage is a cache", () => {
	it("creates a note the feed has and localStorage does not", async () => {
		mockThreads(
			eventLine({
				t: "note",
				id: "n_aaaaaaaaaaaa",
				at: "2026-09-05T20:00:00.000Z",
				author: "fei",
				screenId: "playground",
				x: 40,
				y: 80,
				text: "too tight",
			}),
		);
		const host = document.createElement("div");
		document.body.appendChild(host);
		live = new StickyNotes({
			host,
			objects: stubObjects(),
			storageKey: null,
			screenAt: () => "playground",
		});
		await vi.waitFor(() => {
			expect(live?.getNotes()).toHaveLength(1);
		});
		expect(live?.getNotes()[0]).toMatchObject({
			fid: "n_aaaaaaaaaaaa",
			x: 40,
			y: 80,
			text: "too tight",
		});
		expect(host.querySelector(".sn-text")?.textContent).toBe("too tight");
		expect(eventPosts().filter((p) => p.body.t === "note")).toHaveLength(0);
	});

	it("deletes a local note when the feed has note.delete for it", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		live = new StickyNotes({
			host,
			objects: stubObjects(),
			storageKey: null,
			screenAt: () => "playground",
		});
		const n = live.spawn({ x: 0, y: 0, text: "gone" });
		expect(host.querySelectorAll(".sn-note")).toHaveLength(1);
		host.querySelector<HTMLElement>(".sn-text")?.blur();
		mockThreads(
			eventLine({
				t: "note.delete",
				id: n.fid,
				at: "2026-09-05T20:00:00.000Z",
				author: "fei",
			}),
		);
		await pullNow();
		await vi.waitFor(() => {
			expect(live?.getNotes()).toHaveLength(0);
		});
		expect(host.querySelectorAll(".sn-note")).toHaveLength(0);
		expect(eventPosts().filter((p) => p.body.t === "note.delete")).toHaveLength(
			0,
		);
	});

	it("keeps a local note the feed never mentioned", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		live = new StickyNotes({
			host,
			objects: stubObjects(),
			storageKey: null,
			screenAt: () => "playground",
		});
		const n = live.spawn({ x: 8, y: 9, text: "only local" });
		mockThreads(
			eventLine({
				t: "note",
				id: "n_bbbbbbbbbbbb",
				at: "2026-09-05T20:00:00.000Z",
				author: "fei",
				screenId: "playground",
				x: 1,
				y: 2,
				text: "from feed",
			}),
		);
		await pullNow();
		await vi.waitFor(() => {
			expect(live?.getNotes().some((note) => note.fid === "n_bbbbbbbbbbbb")).toBe(
				true,
			);
		});
		expect(live?.getNotes().some((note) => note.fid === n.fid)).toBe(true);
		expect(live?.getNotes().find((note) => note.fid === n.fid)?.text).toBe(
			"only local",
		);
	});

	it("does not touch local notes when the feed cannot be fetched", async () => {
		const key = "test:notes:feed-down";
		localStorage.setItem(
			key,
			JSON.stringify({
				v: 1,
				notes: [
					{
						x: 4,
						y: 5,
						c: "yellow",
						f: "medium",
						k: false,
						t: "kept",
						h: "kept",
						fi: "n_cccccccccccc",
					},
				],
			}),
		);
		vi.mocked(fetch).mockRejectedValue(new Error("dev server down"));
		const host = document.createElement("div");
		document.body.appendChild(host);
		live = new StickyNotes({
			host,
			objects: stubObjects(),
			storageKey: key,
		});
		expect(live.getNotes()).toHaveLength(1);
		expect(live.getNotes()[0]?.text).toBe("kept");
		await Promise.resolve();
		await Promise.resolve();
		expect(live.getNotes()).toHaveLength(1);
		expect(live.getNotes()[0]?.fid).toBe("n_cccccccccccc");
		expect(live.getNotes()[0]?.text).toBe("kept");
		expect(host.querySelectorAll(".sn-note")).toHaveLength(1);
		localStorage.removeItem(key);
	});

	it("does not touch local notes when the feed endpoint is not ok", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		live = new StickyNotes({
			host,
			objects: stubObjects(),
			storageKey: null,
			screenAt: () => "playground",
		});
		const n = live.spawn({ x: 0, y: 0, text: "still here" });
		vi.mocked(fetch).mockResolvedValue({
			ok: false,
			json: async () => ({ ok: false }),
		} as unknown as Response);
		await pullNow();
		await Promise.resolve();
		await Promise.resolve();
		expect(live.getNotes()).toHaveLength(1);
		expect(live.getNotes()[0]?.fid).toBe(n.fid);
		expect(live.getNotes()[0]?.text).toBe("still here");
	});

	it("aligns text and position from last note.edit / note.move", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		live = new StickyNotes({
			host,
			objects: stubObjects(),
			storageKey: null,
			screenAt: () => "playground",
		});
		const n = live.spawn({ x: 0, y: 0, text: "first words" });
		host.querySelector<HTMLElement>(".sn-text")?.blur();
		mockThreads(
			eventLine({
				t: "note",
				id: n.fid,
				at: "2026-09-05T20:00:00.000Z",
				author: "fei",
				screenId: "playground",
				x: 10,
				y: 20,
				text: "first words",
			}) +
				eventLine({
					t: "note.edit",
					id: n.fid,
					at: "2026-09-05T20:01:00.000Z",
					author: "fei",
					text: "second words",
				}) +
				eventLine({
					t: "note.move",
					id: n.fid,
					at: "2026-09-05T20:02:00.000Z",
					author: "fei",
					screenId: "mosaic",
					x: 90,
					y: 40,
				}),
		);
		await pullNow();
		await vi.waitFor(() => {
			expect(live?.getNotes()[0]?.text).toBe("second words");
		});
		expect(live?.getNotes()[0]).toMatchObject({ x: 90, y: 40 });
		expect(host.querySelector(".sn-text")?.textContent).toBe("second words");
		expect(eventPosts().filter((p) => p.body.t === "note.edit")).toHaveLength(0);
		expect(eventPosts().filter((p) => p.body.t === "note.move")).toHaveLength(0);
	});

	it("does not rebuild a note that is being edited", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		live = new StickyNotes({
			host,
			objects: stubObjects(),
			storageKey: null,
			screenAt: () => "playground",
		});
		const n = live.spawn({ x: 0, y: 0, text: "draft" });
		const text = host.querySelector(".sn-text");
		if (!(text instanceof HTMLElement)) throw new Error("no text");
		text.focus();
		expect(document.activeElement).toBe(text);
		const node = document.activeElement;
		mockThreads(
			eventLine({
				t: "note",
				id: n.fid,
				at: "2026-09-05T20:00:00.000Z",
				author: "fei",
				screenId: "playground",
				x: 10,
				y: 20,
				text: "draft",
			}) +
				eventLine({
					t: "note.edit",
					id: n.fid,
					at: "2026-09-05T20:01:00.000Z",
					author: "fei",
					text: "from feed, would steal the caret",
				}),
		);
		await pullNow();
		await Promise.resolve();
		await Promise.resolve();
		expect(document.activeElement).toBe(node);
		expect(text.isConnected).toBe(true);
		expect(text.textContent).toBe("draft");
		expect(live.getNotes()[0]?.text).toBe("draft");
	});
});

describe("notes pin to a screen, not to the page", () => {
	function mountAnchored(screens: Map<string, Rect>) {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const objects = stubObjects();
		const screenAt = (p: Point) => {
			for (const [id, r] of screens) {
				if (
					p.x >= r.x &&
					p.x < r.x + r.width &&
					p.y >= r.y &&
					p.y < r.y + r.height
				)
					return id;
			}
			return null;
		};
		live = new StickyNotes({
			host,
			objects,
			storageKey: null,
			screenAt,
			screenLayout: (id) => {
				const r = screens.get(id);
				return r ? { ...r } : undefined;
			},
		});
		return { host, objects, screens };
	}

	it("an anchored note follows when its screen moves; an unanchored one does not", () => {
		const screens = new Map<string, Rect>([
			["playground", { x: 0, y: 0, width: 1000, height: 500 }],
		]);
		const { objects } = mountAnchored(screens);
		const pinned = live?.spawn({ x: 200, y: 100, text: "on screen" });
		const floating = live?.spawn({ x: 5000, y: 4000, text: "on canvas" });
		expect(pinned?.anchor).toEqual({
			screenId: "playground",
			rx: 0.2,
			ry: 0.2,
		});
		expect(floating?.anchor).toBeUndefined();
		objects.select(null);

		screens.set("playground", { x: 400, y: 50, width: 1000, height: 500 });
		live?.onCameraWrite();

		const notes = live?.getNotes() ?? [];
		const onScreen = notes.find((n) => n.fid === pinned?.fid);
		const onCanvas = notes.find((n) => n.fid === floating?.fid);
		expect(onScreen).toMatchObject({ x: 600, y: 150 });
		expect(onCanvas).toMatchObject({ x: 5000, y: 4000 });
	});

	it("a deleted screen leaves the note in place and drops the anchor", () => {
		const screens = new Map<string, Rect>([
			["playground", { x: 0, y: 0, width: 1000, height: 500 }],
		]);
		const { objects } = mountAnchored(screens);
		const pinned = live?.spawn({ x: 200, y: 100 });
		objects.select(null);
		expect(live?.getNotes()[0]?.anchor).toBeDefined();

		screens.delete("playground");
		live?.onCameraWrite();

		const left = live?.getNotes()[0];
		expect(left?.fid).toBe(pinned?.fid);
		expect(left?.x).toBe(200);
		expect(left?.y).toBe(100);
		expect(left?.anchor).toBeUndefined();
	});

	it("dragging a note onto a screen stores an anchor; dragging off clears it", () => {
		const screens = new Map<string, Rect>([
			["playground", { x: 0, y: 0, width: 1000, height: 500 }],
		]);
		const { objects } = mountAnchored(screens);
		const n = live?.spawn({ x: 5000, y: 4000 });
		expect(n?.anchor).toBeUndefined();
		const init = objects.inits.get(`note:${n?.id}`);
		init?.onLayout?.({ x: 200, y: 100, width: 240, height: 240 });
		expect(live?.getNotes()[0]?.anchor).toEqual({
			screenId: "playground",
			rx: 0.2,
			ry: 0.2,
		});

		init?.onLayout?.({ x: 5000, y: 4000, width: 240, height: 240 });
		expect(live?.getNotes()[0]?.anchor).toBeUndefined();
		expect(live?.getNotes()[0]).toMatchObject({ x: 5000, y: 4000 });
	});

	it("a note event carries the anchor when the note sits on a screen", () => {
		const screens = new Map<string, Rect>([
			["playground", { x: 0, y: 0, width: 1000, height: 500 }],
		]);
		mountAnchored(screens);
		const n = live?.spawn({ x: 200, y: 100, text: "pin" });
		const posts = eventPosts().filter((p) => p.body.t === "note");
		expect(posts[0]?.body).toMatchObject({
			t: "note",
			id: n?.fid,
			screenId: "playground",
			x: 200,
			y: 100,
			text: "pin",
			anchor: { screenId: "playground", rx: 0.2, ry: 0.2 },
		});
	});
});


