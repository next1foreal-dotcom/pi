import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read the stylesheet as text: importing it would hand back the CSS-modules
// class-name map, and `?raw` / `?inline` lose to that transform.
const css = readFileSync(new URL("./lab.module.css", import.meta.url), "utf8");
const view = readFileSync(new URL("./lab-view.tsx", import.meta.url), "utf8");

/** Crude but sufficient: `selectors { declarations }` pairs, comments stripped. */
function rules(source: string): { selectors: string[]; body: string }[] {
	const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
	const out: { selectors: string[]; body: string }[] = [];
	for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		out.push({
			selectors: match[1]
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
			body: match[2],
		});
	}
	return out;
}

describe("locked modes leave the live screen clickable", () => {
	// The chrome layer is inset 0 across the whole viewport at z-index 5, above
	// the screens. Give it `pointer-events: auto` and every click in focus or
	// fill mode lands on it instead of the app that is supposedly live — the
	// counter does not count, the field does not type, and the click reads as
	// "outside", which exits. Only `.layer` may take events; chrome ITEMS are
	// already `auto` on their own and stay clickable inside a `none` parent,
	// which is how explore mode has always worked.
	const locked = rules(css).filter(
		(r) =>
			/pointer-events:\s*auto/.test(r.body) &&
			r.selectors.some((s) => /\[data-mode="(focus|fill)"\]/.test(s)),
	);

	it("has the rule that makes the locked screen interactive", () => {
		expect(locked.length).toBeGreaterThan(0);
	});

	it("gives events to the screen layer and to nothing above it", () => {
		const targets = locked
			.flatMap((r) => r.selectors)
			.filter((s) => /\[data-mode="(focus|fill)"\]/.test(s))
			.map((s) => s.split(/\s+/).pop() ?? "");
		expect([...new Set(targets)]).toEqual([".layer"]);
	});

	it("keeps the chrome layer transparent to the pointer by default", () => {
		const chrome = rules(css).find(
			(r) => r.selectors.length === 1 && r.selectors[0] === ".chrome",
		);
		expect(chrome?.body).toMatch(/pointer-events:\s*none/);
	});
});

describe("canvas-object decor and dragging cursor", () => {
	it("objectDecor hidden by default", () => {
		const decor = rules(css).find(
			(r) => r.selectors.some((s) => s === ".objectDecor"),
		);
		expect(decor?.body).toMatch(/display:\s*none/);
	});

	it("objectDecor shown when data-selected", () => {
		const shown = rules(css).find(
			(r) => r.selectors.some((s) => s.includes("[data-selected]") && s.includes(".objectDecor")),
		);
		expect(shown?.body).toMatch(/display:\s*block/);
	});

	it("data-dragging=move sets grabbing cursor on root and descendants", () => {
		const drag = rules(css).filter(
			(r) => r.selectors.some((s) => s.includes('[data-dragging="move"]')),
		);
		expect(drag.length).toBeGreaterThan(0);
		expect(drag.some((r) => r.body.includes("grabbing"))).toBe(true);
	});
});

describe("the locked-mode hint is its own corner, not a HUD button", () => {
	// It used to be a badge wedged into the middle of the bottom-centre pill,
	// between the zoom readout and "Reset layout": a message about the screen
	// living inside a control strip about the canvas, widening the strip and
	// pushing its buttons sideways every time you locked in. Now it is a pill
	// of its own in the bottom-left corner, under the locked frame, naming the
	// screen and BOTH ways out — esc, and the tab nobody guesses.

	const hint = rules(css).find(
		(r) => r.selectors.length === 1 && r.selectors[0] === ".lockHint",
	);
	const pill = rules(css).find(
		(r) => r.selectors.length === 1 && r.selectors[0] === ".pill",
	);

	it("has a rule of its own", () => {
		expect(hint).toBeDefined();
	});

	it("sits in the bottom-left corner", () => {
		expect(hint?.body).toMatch(/position:\s*absolute/);
		expect(hint?.body).toMatch(/left:\s*\d/);
		expect(hint?.body).toMatch(/bottom:\s*\d/);
		// Bottom-CENTRE is what the HUD does: `left: 50%` plus a translate. If
		// either of those shows up here the hint has drifted back under the HUD.
		expect(hint?.body).not.toMatch(/left:\s*50%/);
		expect(hint?.body).not.toMatch(/translateX/);
		expect(hint?.body).not.toMatch(/right:\s*\d/);
	});

	it("is hidden in explore mode", () => {
		// There is no locked screen in explore, so there is nothing to say. The
		// stylesheet owns this, the same way it owns the pixel grid's and the
		// rulers' visibility per mode.
		const hidden = rules(css).filter(
			(r) =>
				r.selectors.some((s) => /\[data-mode="explore"\]/.test(s)) &&
				r.selectors.some((s) => s.includes(".lockHint")),
		);
		expect(hidden.length).toBeGreaterThan(0);
		expect(hidden[0].body).toMatch(/display:\s*none/);
	});

	it("borrows the HUD pill's surface, radius and type scale", () => {
		// Chrome that belongs to this lab, not a second visual language.
		expect(hint?.body).toMatch(/background:\s*var\(--lab-pill\)/);
		expect(pill?.body).toMatch(/background:\s*var\(--lab-pill\)/);
		for (const prop of ["border-radius", "font-size"] as const) {
			const of = (body: string | undefined) =>
				new RegExp(`${prop}:\\s*([^;]+)`).exec(body ?? "")?.[1].trim();
			expect(of(hint?.body)).toBe(of(pill?.body));
		}
	});

	it("no longer rides inside the HUD pill", () => {
		// The pill is back to zoom %, the tools, reset and `?`. The badge class
		// it used to wear is gone from both files, so it cannot quietly return.
		expect(view).not.toContain("styles.badge");
		expect(view).toContain("styles.lockHint");
		expect(rules(css).some((r) => r.selectors.includes(".badge"))).toBe(false);
	});

	it("names both ways out", () => {
		expect(view).toMatch(/esc exits · tab cycles/);
	});
});

describe("the help sheet has no scrollbar at all", () => {
	// The sheet is one column on a narrow pane and taller than its own cap, so
	// it scrolls. Left alone that is a wide grey trough with arrow buttons on
	// a dark panel — the one piece of chrome in this lab drawn by Windows
	// rather than by us.
	it("asks for none — a thin one is still one", () => {
		const help = rules(css).find((r) => r.selectors.includes(".help"));
		expect(help?.body).toMatch(/scrollbar-width:\s*none/);
		expect(help?.body).not.toMatch(/scrollbar-width:\s*thin/);
	});

	it("hides the WebKit scrollbar too, since that is the engine we run on", () => {
		const bar = rules(css).find((r) =>
			r.selectors.some((s) => s === ".help::-webkit-scrollbar"),
		);
		expect(bar?.body).toMatch(/display:\s*none/);
	});

	it("but it can still be scrolled — the wheel does it", () => {
		const help = rules(css).find((r) => r.selectors.includes(".help"));
		expect(help?.body).toMatch(/overflow-y:\s*auto/);
		// No mask, no fade, no gradient. A softened edge over a reference sheet
		// just makes the row you were reading unreadable.
		expect(help?.body).not.toMatch(/mask-image/);
	});
});
