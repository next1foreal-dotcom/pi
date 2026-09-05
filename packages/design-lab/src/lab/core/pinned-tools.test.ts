// @vitest-environment jsdom

/**
 * Nothing pinned to the screen is left on the canvas. Notes and labels are both
 * ordinary canvas content now: they go through the core's writeFrame (tested in
 * canvas-objects.test.ts) and carry no counter-scale of their own.
 *
 * What DOES stay screen-sized is the chrome drawn on top of them — a note's
 * toolbar, a label's two handles and its selection outline — because a control
 * you cannot grab is not a control. Both sides are asserted here: the content
 * must not counter-scale, the controls must.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Labels } from "./page-labels";
import { StickyNotes } from "./page-notes";
import type { LabObjects } from "../plugin-api";
import type { Rect } from "./types";

const hosts: HTMLElement[] = [];
function host() {
	const el = document.createElement("div");
	document.body.appendChild(el);
	hosts.push(el);
	return el;
}

function stubObjects(): LabObjects {
	const layouts = new Map<string, Rect>();
	let sel: string | null = null;
	return {
		register(init) { layouts.set(init.id, { ...init.rect }); init.el.setAttribute("data-lab-object", init.id); },
		unregister(id) { layouts.delete(id); },
		layout: (id) => layouts.get(id),
		setLayout(id, rect) { layouts.set(id, rect); },
		beginMove() {},
		beginResize() {},
		select(id) { sel = id; },
		selectedId: () => sel,
	};
}

afterEach(() => {
	for (const h of hosts.splice(0)) h.remove();
	document.body.innerHTML = "";
});

describe("notes and labels are both canvas content", () => {
	it("a note does NOT carry scale(var(--inv-zoom)) any more", () => {
		const notes = new StickyNotes({ host: host(), objects: stubObjects() });
		notes.spawn({ x: 1200, y: -340 });
		const el = document.querySelector<HTMLElement>(".sn-note");
		expect(el).toBeTruthy();
		// It registered, so the core owns its geometry now …
		expect(el?.hasAttribute("data-lab-object")).toBe(true);
		// … and it writes none of its own. A returning positionEl would put the
		// counter-scale back here and the note would stop growing with the canvas.
		expect(el?.style.transform ?? "").not.toContain("inv-zoom");
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		const noteRule = css.match(/\.sn-note\{[^}]*\}/)?.[0] ?? "";
		expect(noteRule).not.toContain("inv-zoom");
		expect(noteRule).toBeTruthy();
		notes.destroy();
	});

	it("a label does NOT carry scale(var(--inv-zoom)) any more either", () => {
		const objects = stubObjects();
		const labels = new Labels({ host: host(), getZoom: () => 1, objects });
		labels.spawn({ x: -80, y: 512 });
		const el = document.querySelector<HTMLElement>(".lb-label");
		expect(el).toBeTruthy();
		// It registered, so the core owns its position now …
		expect(el?.hasAttribute("data-lab-object")).toBe(true);
		expect(objects.layout("label:1")).toMatchObject({ x: -80, y: 512 });
		// … and it writes none of its own. A returning positionEl would put the
		// counter-scale back here and the label would stop growing with the canvas.
		expect(el?.style.transform ?? "").toBe("");
		const rule =
			document
				.querySelector<HTMLStyleElement>("style[data-label-overlay]")
				?.textContent?.match(/\.lb-label\{[^}]*\}/)?.[0] ?? "";
		expect(rule).toBeTruthy();
		expect(rule).not.toContain("inv-zoom");
		labels.destroy();
	});

	it("but the label's own controls still counter-scale, or they get ungrabbable", () => {
		const labels = new Labels({
			host: host(),
			getZoom: () => 1,
			objects: stubObjects(),
		});
		labels.spawn({ x: 0, y: 0 });
		const css =
			document.querySelector<HTMLStyleElement>("style[data-label-overlay]")
				?.textContent ?? "";
		expect(css.match(/\.lb-handle\{[^}]*\}/)?.[0]).toContain("var(--inv-zoom,1)");
		expect(css.match(/\.lb-aim\{[^}]*\}/)?.[0]).toContain("var(--inv-zoom,1)");
		expect(css.match(/\.lb-label\[data-selected\]\{[^}]*\}/)?.[0]).toContain(
			"var(--inv-zoom,1)",
		);
		labels.destroy();
	});

	it("the note's toolbar still counter-scales for the same reason", () => {
		const notes = new StickyNotes({ host: host(), objects: stubObjects() });
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		expect(css.match(/\.sn-toolbar\{[^}]*\}/)?.[0]).toContain(
			"scale(var(--inv-zoom,1))",
		);
		notes.destroy();
	});

	it("the .sn-note rule has no scale(var(--inv-zoom (toolbar may counter-scale)", () => {
		const notes = new StickyNotes({ host: host(), objects: stubObjects() });
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		const noteRule = css.match(/\.sn-note\{[^}]*\}/)?.[0] ?? "";
		expect(noteRule).not.toContain("scale(var(--inv-zoom");
		notes.destroy();
	});

	it("the note's injected CSS has no 30vw", () => {
		const notes = new StickyNotes({ host: host(), objects: stubObjects() });
		const css =
			document.querySelector<HTMLStyleElement>("style[data-sticky-note]")
				?.textContent ?? "";
		expect(css).not.toContain("30vw");
		notes.destroy();
	});
});
