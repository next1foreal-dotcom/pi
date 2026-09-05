// @vitest-environment jsdom

/**
 * Notes are now ordinary canvas content (page-sized, no counter-scale).
 * Labels still counter-scale with --inv-zoom until P2.
 *
 * This test verifies the two models coexist: notes go through the core's
 * writeFrame (tested in canvas-objects.test.ts), while labels still apply
 * transform-origin 0 0 and scale(var(--inv-zoom,1)).
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

describe("notes are canvas content, labels still counter-scale", () => {
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

	it("a label still carries its page point and the counter scale", () => {
		const labels = new Labels({ host: host(), getZoom: () => 1 });
		labels.spawn({ x: -80, y: 512 });
		const el = document.querySelector(".lb-label");
		expect(el).toBeTruthy();
		const t = (el as HTMLElement).style.transform;
		expect(t).toContain("translate3d(-80px,512px,0)");
		expect(t).toContain("scale(var(--inv-zoom,1))");
		labels.destroy();
	});

	it("labels still scale about the stored point (transform-origin 0 0)", () => {
		const labels = new Labels({ host: host(), getZoom: () => 1 });
		labels.spawn({ x: 0, y: 0 });
		const sheet = [...document.querySelectorAll("style")]
			.map((s) => s.textContent ?? "")
			.join("\n");
		expect(sheet).toMatch(/\.lb-label\{[^}]*transform-origin:0 0/);
		labels.destroy();
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
