// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceLocation } from "../inspect/source-location";
import {
	decideEdit,
	type EditCandidate,
	type EditDecision,
	localNote,
	NOT_PLAIN_NOTE,
	normalizeEdited,
	pastedText,
	plainTextOf,
	refusalNote,
	screenContentOf,
	TextEditor,
	type TextEditorDeps,
	textEditBody,
} from "./plugin";

/**
 * Two rules run through everything below.
 *
 * One: a gesture this plugin does not claim must reach whoever else wanted it.
 * Double-click already means "enter this screen" on the canvas and "even out
 * these panes" inside one of the screens; taking it unconditionally would trade
 * a working gesture for a new one. So every refusal test has a twin that opens
 * the editor, because "never open" passes all of them.
 *
 * Two: the dev server owns the answer to "can this be written". This side may
 * only be *narrower* than it, and when it does refuse it repeats the server's
 * sentence rather than inventing a friendlier one.
 */

const okCandidate: EditCandidate = {
	mode: "focus",
	focusedId: "main-landing",
	screenId: "main-landing",
	inScreenContent: true,
	plainText: "Read the spec",
	tag: "span",
	file: "packages/design-lab/src/screens/main-landing/page.tsx",
	line: 95,
	column: 7,
	problem: null,
};

function candidate(over: Partial<EditCandidate> = {}): EditCandidate {
	return { ...okCandidate, ...over };
}

function refusalOf(decision: EditDecision): string | null {
	return decision.verdict === "refuse" ? decision.refusal : null;
}

describe("when a double-click opens the editor", () => {
	it("opens on a plain-text tag inside the screen he is locked into", () => {
		const d = decideEdit(candidate());
		expect(d.verdict).toBe("edit");
		if (d.verdict !== "edit") throw new Error("unreachable");
		expect(d.target).toEqual({
			file: "packages/design-lab/src/screens/main-landing/page.tsx",
			line: 95,
			column: 7,
			tag: "span",
		});
	});

	it("opens in fill mode too — it is the same locked screen, bigger", () => {
		expect(decideEdit(candidate({ mode: "fill" })).verdict).toBe("edit");
	});

	it("refuses in explore mode, where double-click already enters a screen", () => {
		expect(refusalOf(decideEdit(candidate({ mode: "explore", focusedId: null })))).toBe("not-locked");
	});

	it("refuses a screen other than the focused one", () => {
		// Locked into one screen, the others are dimmed and behind a shield. A
		// double-click that landed on one of them is not an edit.
		expect(refusalOf(decideEdit(candidate({ screenId: "product-list" })))).toBe("other-screen");
	});

	it("refuses lab chrome and the scroller itself", () => {
		expect(refusalOf(decideEdit(candidate({ inScreenContent: false })))).toBe("not-screen-content");
	});

	it("refuses an element whose children are not one piece of text", () => {
		expect(refusalOf(decideEdit(candidate({ plainText: null })))).toBe("not-plain-text");
	});

	it("refuses when the source location is unknown", () => {
		expect(
			refusalOf(decideEdit(candidate({ file: null, line: null, column: null, problem: "no-react-fiber" }))),
		).toBe("no-location");
	});

	it("refuses a file the server would refuse by extension", () => {
		// The server answers `refusing <file>: this edits JSX tags, so only .tsx
		// and .jsx`. Better to never open the editor than to open it and lose
		// what he typed to that.
		expect(refusalOf(decideEdit(candidate({ file: "packages/design-lab/src/lab/core/page-notes.ts" })))).toBe(
			"not-jsx-source",
		);
	});

	it("opens anyway while the module's source map is still being read", () => {
		// `file` is real on this problem and `line` is not, so the extension gate
		// above has already run. Waiting for the map before showing a caret would
		// make the first double-click after a hot reload do nothing at all.
		expect(
			decideEdit(candidate({ line: null, column: null, problem: "source-map-pending" })).verdict,
		).toBe("edit-pending");
	});

	it("refuses a map that was read and could not place the tag", () => {
		expect(
			refusalOf(decideEdit(candidate({ line: null, column: null, problem: "source-map-unavailable" }))),
		).toBe("no-location");
	});
});

describe("what counts as one piece of text", () => {
	function el(html: string): Element {
		const host = document.createElement("div");
		host.innerHTML = html;
		return host.firstElementChild as Element;
	}

	it("reads the text of a tag whose only child is text", () => {
		expect(plainTextOf(el("<span>Read the spec</span>"))).toBe("Read the spec");
	});

	it("refuses a tag with nested markup", () => {
		// The server refuses this as `element-child`, because replacing the
		// children with plain text would delete the <b>.
		expect(plainTextOf(el("<p>hello <b>world</b></p>"))).toBeNull();
	});

	it("refuses a tag with text either side of a nested tag", () => {
		expect(plainTextOf(el("<p>a<b>b</b>c</p>"))).toBeNull();
	});

	it("refuses an empty tag", () => {
		expect(plainTextOf(el('<div class="grip"></div>'))).toBeNull();
	});

	it("refuses a tag holding only whitespace", () => {
		expect(plainTextOf(el("<div>   </div>"))).toBeNull();
	});

	it("refuses a tag whose only child is a comment", () => {
		expect(plainTextOf(el("<div><!-- nothing --></div>"))).toBeNull();
	});
});

describe("which nodes belong to a screen", () => {
	function tree(): { scroll: HTMLElement; inside: HTMLElement; chrome: HTMLElement } {
		const group = document.createElement("div");
		group.setAttribute("data-screen-id", "main-landing");
		const scroll = document.createElement("div");
		scroll.setAttribute("data-screen-scroll", "main-landing");
		const inside = document.createElement("span");
		inside.textContent = "Read the spec";
		scroll.appendChild(inside);
		group.appendChild(scroll);
		const chromeHost = document.createElement("div");
		chromeHost.setAttribute("data-lab-chrome", "");
		const chrome = document.createElement("span");
		chromeHost.appendChild(chrome);
		scroll.appendChild(chromeHost);
		document.body.append(group);
		return { scroll, inside, chrome };
	}

	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("takes content inside a screen and names the screen", () => {
		const { inside } = tree();
		expect(screenContentOf(inside)).toEqual({ screenId: "main-landing" });
	});

	it("refuses the scroller itself", () => {
		const { scroll } = tree();
		expect(screenContentOf(scroll)).toBeNull();
	});

	it("refuses lab chrome that happens to sit over a screen", () => {
		const { chrome } = tree();
		expect(screenContentOf(chrome)).toBeNull();
	});

	it("refuses a node outside every screen", () => {
		tree();
		const loose = document.createElement("span");
		document.body.appendChild(loose);
		expect(screenContentOf(loose)).toBeNull();
	});
});

describe("the text on its way to the file", () => {
	it("collapses what contenteditable leaves behind", () => {
		// A browser puts non-breaking spaces in, and Enter would put a newline
		// in. JSX folds both into one space when it renders, so writing them
		// into the source would change the file without changing the screen.
		expect(normalizeEdited("  Read  the\n\tspec  ")).toBe("Read the spec");
	});

	it("leaves ordinary copy alone", () => {
		expect(normalizeEdited("Read the spec")).toBe("Read the spec");
	});

	it("sends exactly what the endpoint asks for", () => {
		const body = textEditBody({ file: "a/b.tsx", line: 95, column: 7, tag: "SPAN" }, " Read  the spec ");
		expect(body).toEqual({ file: "a/b.tsx", line: 95, column: 7, tag: "span", text: "Read the spec" });
	});

	it("keeps a paste as plain text", () => {
		const data = {
			getData: (type: string) => (type === "text/html" ? "<b>bold</b>" : "one\ntwo"),
		};
		expect(pastedText(data)).toBe("one two");
	});

	it("keeps the spaces inside a paste, because the caret may be mid-word", () => {
		const data = { getData: () => " middle " };
		expect(pastedText(data)).toBe(" middle ");
	});

	it("survives a paste with nothing in it", () => {
		expect(pastedText(null)).toBe("");
	});
});

describe("what it says when the write is refused", () => {
	it("repeats the server's sentence rather than inventing one", () => {
		const reason =
			"<div> at line 40 contains a nested <span>. Replacing its children with plain text would delete that markup.";
		expect(refusalNote(409, { ok: false, problem: "element-child", error: reason })).toBe(reason);
	});

	it("says nothing when the write went through", () => {
		expect(refusalNote(200, { ok: true, changed: true })).toBeNull();
	});

	it("names the status when the server said nothing readable", () => {
		expect(refusalNote(500, null)).toBe("写不进去(HTTP 500)");
	});

	it("treats a 200 that carries ok:false as the refusal it is", () => {
		expect(refusalNote(200, { ok: false, error: "forbidden" })).toBe("forbidden");
	});
});

describe("the hint for a double-click this plugin did not take", () => {
	it("explains a tag that has copy in it but is not one piece of text", () => {
		expect(localNote({ verdict: "refuse", refusal: "not-plain-text" }, "hello world")).toBe(NOT_PLAIN_NOTE);
	});

	it("stays quiet for an empty node — that double-click belonged to the app", () => {
		// The mosaic screen's resize grips are empty divs with their own
		// onDoubleClick. Popping a lab message over one of those would be this
		// plugin talking about a gesture that was never aimed at it.
		expect(localNote({ verdict: "refuse", refusal: "not-plain-text" }, "  ")).toBeNull();
	});

	it("stays quiet in explore mode, where double-click means enter the screen", () => {
		expect(localNote({ verdict: "refuse", refusal: "not-locked" }, "Read the spec")).toBeNull();
	});

	it("stays quiet when it did open the editor", () => {
		expect(localNote({ verdict: "edit", target: { file: "a.tsx", line: 1, column: 1, tag: "p" } }, "x")).toBeNull();
	});
});

describe("the editor on a live screen", () => {
	let host: HTMLDivElement;
	let target: HTMLElement;
	let grip: HTMLElement;
	let mixed: HTMLElement;
	let posted: { url: string; init: RequestInit }[];
	let reply: { ok: boolean; status: number; body: unknown };
	let mode: string;
	let live: TextEditor | null;

	function located(el: Element): SourceLocation {
		if (el === target) {
			return {
				file: "packages/design-lab/src/screens/main-landing/page.tsx",
				line: 95,
				column: 7,
				component: "MainLanding",
				problem: null,
			};
		}
		return { file: null, line: null, column: null, component: null, problem: "no-react-fiber" };
	}

	function build(over: Partial<TextEditorDeps> = {}): TextEditor {
		const group = document.createElement("div");
		group.setAttribute("data-screen-id", "main-landing");
		const scroll = document.createElement("div");
		scroll.setAttribute("data-screen-scroll", "main-landing");
		target = document.createElement("span");
		target.className = "lp-btn is-ghost";
		target.textContent = "Read the spec";
		grip = document.createElement("div");
		grip.className = "mos-row-grip";
		mixed = document.createElement("p");
		mixed.innerHTML = "hello <b>world</b>";
		scroll.append(target, grip, mixed);
		group.appendChild(scroll);
		host = document.createElement("div");
		document.body.append(group, host);

		mode = "focus";
		posted = [];
		reply = { ok: true, status: 200, body: { ok: true, changed: true, file: "page.tsx" } };
		vi.spyOn(globalThis, "fetch").mockImplementation(((url: string, init: RequestInit) => {
			posted.push({ url, init });
			return Promise.resolve({
				ok: reply.ok,
				status: reply.status,
				json: () => Promise.resolve(reply.body),
			});
		}) as unknown as typeof fetch);

		const deps: TextEditorDeps = {
			canvasState: () => ({ mode, focusedId: "main-landing" }),
			locate: located,
			locateSourced: (el) => Promise.resolve(located(el)),
			insertPlain: (text) => {
				const node = document.getSelection()?.anchorNode;
				if (node) node.textContent = (node.textContent ?? "") + text;
			},
			...over,
		};
		live = new TextEditor(host, deps);
		return live;
	}

	function dbl(el: Element): MouseEvent {
		const e = new MouseEvent("dblclick", { bubbles: true, cancelable: true });
		el.dispatchEvent(e);
		return e;
	}

	function key(name: string): KeyboardEvent {
		const e = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
		(document.activeElement ?? document.body).dispatchEvent(e);
		return e;
	}

	function noteText(): string {
		return (host.querySelector("[data-lab-text-note]") as HTMLElement | null)?.textContent ?? "";
	}

	function editing(): boolean {
		return target.hasAttribute("data-lab-text-editing");
	}

	afterEach(() => {
		// A test that fails before its own destroy() would otherwise leave this
		// editor's window listeners behind, and the next test would run with two
		// editors answering one double-click. One real failure would then be
		// reported as several unrelated ones.
		live?.destroy();
		live = null;
		vi.restoreAllMocks();
		document.body.innerHTML = "";
	});

	it("puts a caret in the tag he double-clicked", () => {
		build();
		const e = dbl(target);
		expect(editing()).toBe(true);
		expect(target.getAttribute("contenteditable")).not.toBeNull();
		// Claimed, so the shield behind it does not also act on this gesture.
		expect(e.defaultPrevented).toBe(true);
	});

	it("lets a double-click it did not take reach the app", () => {
		// The other side of the test above: the mosaic grips have their own
		// onDoubleClick, and this must not be standing in front of them.
		build();
		let heard = 0;
		document.body.addEventListener("dblclick", () => {
			heard += 1;
		});
		const e = dbl(grip);
		expect(grip.hasAttribute("data-lab-text-editing")).toBe(false);
		expect(heard).toBe(1);
		expect(e.defaultPrevented).toBe(false);
	});

	it("does not open in explore mode", () => {
		build();
		mode = "explore";
		const e = dbl(target);
		expect(editing()).toBe(false);
		expect(e.defaultPrevented).toBe(false);
	});

	it("does not open on a tag with markup in it, and says why", () => {
		build();
		dbl(mixed);
		expect(mixed.hasAttribute("data-lab-text-editing")).toBe(false);
		expect(noteText()).toBe(NOT_PLAIN_NOTE);
		expect(posted.length).toBe(0);
	});

	it("writes the new copy on Enter, and stops editing", async () => {
		const editor = build();
		dbl(target);
		target.textContent = "Read the plan";
		key("Enter");
		await editor.settled();

		expect(posted.length).toBe(1);
		expect(posted[0].url).toBe("/__lab-fs/element/text");
		expect((posted[0].init.headers as Record<string, string>)["x-lab-canvas"]).toBe("1");
		expect(JSON.parse(String(posted[0].init.body))).toEqual({
			file: "packages/design-lab/src/screens/main-landing/page.tsx",
			line: 95,
			column: 7,
			tag: "span",
			text: "Read the plan",
		});
		// A write replaces the module, so the node goes with it. Holding the
		// caret in a node that is about to be thrown away would look like the
		// edit was lost.
		expect(editing()).toBe(false);
		expect(target.getAttribute("contenteditable")).toBeNull();
	});

	it("sends nothing when he changed nothing", async () => {
		// An empty write still rewrites the module and repaints the canvas. A
		// double-click he thought better of should cost nothing at all.
		const editor = build();
		dbl(target);
		key("Enter");
		await editor.settled();

		expect(posted.length).toBe(0);
		expect(target.textContent).toBe("Read the spec");
		expect(editing()).toBe(false);
	});

	it("puts the old copy back on Escape", async () => {
		const editor = build();
		dbl(target);
		target.textContent = "something else";
		const e = key("Escape");
		await editor.settled();

		expect(posted.length).toBe(0);
		expect(target.textContent).toBe("Read the spec");
		expect(editing()).toBe(false);
		// The lab turns Escape into "leave this screen", even while typing. This
		// one is spent on the edit, so he does not lose the screen as well.
		expect(e.defaultPrevented).toBe(true);
	});

	it("writes when he clicks away", async () => {
		const editor = build();
		dbl(target);
		target.textContent = "Read the plan";
		document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		await editor.settled();

		expect(posted.length).toBe(1);
		expect(editing()).toBe(false);
	});

	it("keeps typing alive when he clicks inside the text he is editing", async () => {
		const editor = build();
		dbl(target);
		target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		await editor.settled();

		expect(posted.length).toBe(0);
		expect(editing()).toBe(true);
	});

	it("shows the server's refusal and puts the old copy back", async () => {
		const editor = build();
		reply = {
			ok: false,
			status: 409,
			body: {
				ok: false,
				problem: "expression-child",
				error: "<span> at line 95 has a {expression} in its children.",
			},
		};
		dbl(target);
		target.textContent = "Read the plan";
		key("Enter");
		await editor.settled();

		expect(noteText()).toBe("<span> at line 95 has a {expression} in its children.");
		// The file did not change, so the canvas must not go on showing copy
		// that is not in it.
		expect(target.textContent).toBe("Read the spec");
	});

	it("puts the old copy back when the dev server is gone", async () => {
		const editor = build();
		vi.spyOn(globalThis, "fetch").mockImplementation((() => Promise.reject(new Error("offline"))) as unknown as typeof fetch);
		dbl(target);
		target.textContent = "Read the plan";
		key("Enter");
		await editor.settled();

		expect(target.textContent).toBe("Read the spec");
		expect(noteText()).toContain("offline");
	});

	it("refuses to open on a tag whose source it cannot find", () => {
		build({ locate: () => ({ file: null, line: null, column: null, component: null, problem: "no-react-fiber" }) });
		dbl(target);
		expect(editing()).toBe(false);
	});

	it("opens before the source map is read, and writes once it is", async () => {
		const editor = build({
			locate: () => ({
				file: "packages/design-lab/src/screens/main-landing/page.tsx",
				line: null,
				column: null,
				component: "MainLanding",
				problem: "source-map-pending",
			}),
		});
		dbl(target);
		expect(editing()).toBe(true);
		target.textContent = "Read the plan";
		key("Enter");
		await editor.settled();

		expect(posted.length).toBe(1);
		expect(JSON.parse(String(posted[0].init.body)).line).toBe(95);
	});

	it("stops listening once it is destroyed", () => {
		const editor = build();
		editor.destroy();
		dbl(target);
		expect(editing()).toBe(false);
	});
});
