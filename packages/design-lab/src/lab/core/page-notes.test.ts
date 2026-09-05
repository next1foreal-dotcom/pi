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

