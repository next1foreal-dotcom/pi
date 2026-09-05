// @vitest-environment jsdom

/**
 * Notes and labels are pinned to the page but drawn at screen size.
 *
 * Position stays in page units so a note keeps sitting on the thing it
 * annotates through any pan or zoom. Size does not: a 260px note at a
 * fit-all zoom used to render 13px across — too small to read, to grab by
 * the header, or to close. The counter scale comes from `--inv-zoom`, which
 * the camera layer republishes on every write, so it costs no JS during a
 * gesture. Drop either half and the tools break at one end of the zoom range.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Labels } from "./page-labels";
import { StickyNotes } from "./page-notes";

const hosts: HTMLElement[] = [];
function host() {
	const el = document.createElement("div");
	document.body.appendChild(el);
	hosts.push(el);
	return el;
}

afterEach(() => {
	for (const h of hosts.splice(0)) h.remove();
	document.body.innerHTML = "";
});

describe("notes and labels are pinned to the page, drawn at screen size", () => {
	it("a note carries its page point and the counter scale", () => {
		const notes = new StickyNotes({ host: host(), getZoom: () => 1 });
		const note = notes.spawn({ x: 1200, y: -340 });
		const el = document.querySelector(".sn-note");
		expect(el).toBeTruthy();
		const t = (el as HTMLElement).style.transform;
		expect(t).toContain("translate3d(1200px,-340px,0)");
		expect(t).toContain("scale(var(--inv-zoom,1))");
		expect(note.x).toBe(1200);
		notes.destroy();
	});

	it("a label carries its page point and the counter scale", () => {
		const labels = new Labels({ host: host(), getZoom: () => 1 });
		labels.spawn({ x: -80, y: 512 });
		const el = document.querySelector(".lb-label");
		expect(el).toBeTruthy();
		const t = (el as HTMLElement).style.transform;
		expect(t).toContain("translate3d(-80px,512px,0)");
		expect(t).toContain("scale(var(--inv-zoom,1))");
		labels.destroy();
	});

	it("scales about the stored point, so nothing slides as the zoom changes", () => {
		// transform-origin 0 0 is the other half: scale about the centre and the
		// note drifts off its anchor by half its size at every zoom.
		const notes = new StickyNotes({ host: host(), getZoom: () => 1 });
		const labels = new Labels({ host: host(), getZoom: () => 1 });
		notes.spawn({ x: 0, y: 0 });
		labels.spawn({ x: 0, y: 0 });
		const sheet = [...document.querySelectorAll("style")]
			.map((s) => s.textContent ?? "")
			.join("\n");
		expect(sheet).toMatch(/\.sn-note\{[^}]*transform-origin:0 0/);
		expect(sheet).toMatch(/\.lb-label\{[^}]*transform-origin:0 0/);
		notes.destroy();
		labels.destroy();
	});
});
