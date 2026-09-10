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

describe("a note you can see is a note you can click", () => {
	// Locked in, the layer goes `pointer-events: auto` so the screen behaves
	// like the app it is. A rule here then turned every note and label OFF, and
	// the result was the worst state a control can be in: it rendered, it sat
	// on top, and it answered nothing -- click to type, nothing; drag, nothing;
	// no way to delete it without leaving the screen. Locked in is exactly when
	// you annotate, so this is the mode that matters most.
	//
	// Two-sided on purpose. Off alone would pass with notes nailed to the
	// canvas; on alone would pass with a host that eats the whole screen.

	const notesText = readFileSync(
		new URL("./page-notes.ts", import.meta.url),
		"utf8",
	);
	const labelsText = readFileSync(
		new URL("./page-labels.ts", import.meta.url),
		"utf8",
	);
	/** The one-line style block a script writes for `selector`, verbatim. */
	const declared = (source: string, selector: string) => {
		const at = source.indexOf(`${selector}{`);
		if (at === -1) return "";
		const end = source.indexOf("}", at);
		return end === -1 ? "" : source.slice(at, end + 1);
	};

	it("nothing turns them off in the locked modes", () => {
		const killed = rules(css).filter(
			(r) =>
				/pointer-events:\s*none/.test(r.body) &&
				r.selectors.some(
					(s) =>
						/\[data-mode="(focus|fill)"\]/.test(s) &&
						/(sn-note|lb-label)/.test(s),
				),
		);
		expect(killed).toEqual([]);
	});

	it("each item takes events on its own box", () => {
		expect(declared(notesText, ".sn-note")).toMatch(/pointer-events:\s*auto/);
		expect(declared(labelsText, ".lb-label")).toMatch(/pointer-events:\s*auto/);
	});

	it("and their hosts take none, so the rest of the screen stays the screen's", () => {
		// 0x0 with overflow visible: the host is a coordinate origin, not a
		// surface. Give it `auto` and it swallows the page underneath.
		for (const host of [".notesHost", ".labelsHost"] as const) {
			const rule = rules(css).find(
				(r) => r.selectors.length === 1 && r.selectors[0] === host,
			);
			expect(rule?.body).toMatch(/pointer-events:\s*none/);
			expect(rule?.body).toMatch(/width:\s*0/);
			expect(rule?.body).toMatch(/height:\s*0/);
			expect(rule?.body).toMatch(/overflow:\s*visible/);
		}
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

describe("an overlay nobody can see is not an overlay", () => {
	// Both of these draw a box on top of a screen, and for as long as they have
	// existed neither has been drawn on top of anything. `[data-plugin-layer]`
	// is `z-index: auto`, so it is not a stacking context and its children are
	// compared against the lab's own ladder -- where naming no z-index puts you
	// in the auto bucket, UNDER the screens at 1.
	//
	// Measured 2026-09-10 in the running lab: `selection()` reported the h1 it
	// was holding, and the stack at the centre of the outline came back
	// shield / scroll / frame / group / li-box. The screenshot agreed -- the
	// selected h1 had nothing drawn on it.
	//
	// Three-sided, because there are three ways to lose it again: drop the
	// z-index (the original bug), sink it back under the screens, or give the
	// plugin layer a z-index of its own -- which is the quiet one, because it
	// turns these numbers layer-local without changing a character of them.

	const plugin = (rel: string) =>
		readFileSync(new URL(rel, import.meta.url), "utf8");
	const roots = {
		".li-root": plugin("../plugins/inspect/plugin.ts"),
		".lc-root": plugin("../plugins/components/plugin.ts"),
	};

	/** The z-index in the one-line style block a plugin writes for `selector`. */
	const zOf = (source: string, selector: string): number | null => {
		const at = source.indexOf(`${selector}{`);
		if (at === -1) return null;
		const end = source.indexOf("}", at);
		if (end === -1) return null;
		const found = /z-index:\s*(-?\d+)/.exec(source.slice(at, end));
		return found ? Number(found[1]) : null;
	};
	const ladder = (selector: string): number | null => {
		const rule = rules(css).find(
			(r) => r.selectors.length === 1 && r.selectors[0] === selector,
		);
		const found = /z-index:\s*(-?\d+)/.exec(rule?.body ?? "");
		return found ? Number(found[1]) : null;
	};

	it("each overlay root names a z-index", () => {
		for (const [selector, source] of Object.entries(roots)) {
			expect(zOf(source, selector), selector).not.toBeNull();
		}
	});

	it("and every one of them is above the screens and below the chrome", () => {
		const screens = ladder(".layer");
		const chrome = ladder(".chrome");
		expect(screens).not.toBeNull();
		expect(chrome).not.toBeNull();
		for (const [selector, source] of Object.entries(roots)) {
			const z = zOf(source, selector);
			expect(z, selector).toBeGreaterThan(screens as number);
			expect(z, selector).toBeLessThan(chrome as number);
		}
	});

	it("the selection outline wins where it overlaps a component outline", () => {
		expect(zOf(roots[".li-root"], ".li-root")).toBeGreaterThan(
			zOf(roots[".lc-root"], ".lc-root") as number,
		);
	});

	it("the plugin layer stays z-index auto, so those numbers keep meaning that", () => {
		const tag = /<div\s+data-plugin-layer[\s\S]{0,240}?\/>/.exec(view)?.[0];
		expect(tag).toBeDefined();
		expect(tag).not.toMatch(/zIndex/);
	});
});

describe("a warning is not a colour", () => {
	// Three plugins had grown the same line: a note that had gone wrong, set in
	// `#f39a5e`. I added the third myself on 2026-09-10 by copying the second,
	// and Fei looked at the panel and said 「这是啥丑死了」 — pointing at an orange
	// sentence that was, on almost every element, announcing the ordinary case.
	//
	// The lab does use colour, on purpose: Figma's guide red, its selection
	// blue, the sticky-note palette. Those are objects on a canvas and their
	// hue carries meaning. A warning is not one of those. It is text that has
	// to be louder than the text beside it, and in a neutral panel loud is
	// weight, opacity and a rule down the left — not a hue borrowed from
	// nowhere and matched to nothing.
	//
	// So the gate is narrow on purpose. Scoped to every rule whose selector
	// says it is about something being wrong, and silent about everything else:
	// a wider one flagged 31 deliberate choices, which is how mechanical guards
	// die.

	/** Below this a hex is grey enough to be part of the neutral ramp. */
	const SATURATION_MAX = 24;
	/** Selectors that mean "this went wrong" — the ones that kept growing hues. */
	const TROUBLE = /\[data-bad\]|-warn|-cost|-error|-danger/;

	const sources = [
		"plugins/properties/plugin.ts",
		"plugins/properties/knobs.ts",
		"plugins/text/plugin.ts",
		"plugins/layers/plugin.ts",
		"plugins/inspect/plugin.ts",
		"core/lab.module.css",
	] as const;

	function saturation(hex: string): number {
		const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
		return Math.max(r, g, b) - Math.min(r, g, b);
	}

	function troubleRules(): { where: string; selector: string; body: string }[] {
		const out: { where: string; selector: string; body: string }[] = [];
		for (const rel of sources) {
			const text = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
			for (const rule of rules(text)) {
				for (const selector of rule.selectors) {
					if (TROUBLE.test(selector)) out.push({ where: rel, selector, body: rule.body });
				}
			}
		}
		return out;
	}

	it("finds the rules it is meant to be watching", () => {
		// A gate that matched nothing would pass forever. These exist; the point
		// is what they are allowed to contain.
		expect(troubleRules().length).toBeGreaterThanOrEqual(3);
	});

	it("says so with weight, never with a hue", () => {
		const guilty: string[] = [];
		for (const rule of troubleRules()) {
			for (const [, hex] of rule.body.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
				if (saturation(hex as string) > SATURATION_MAX) {
					guilty.push(`${rule.where} ${rule.selector}: #${hex}`);
				}
			}
		}
		expect(guilty).toEqual([]);
	});

	it("and the saturation test can tell the difference", () => {
		// Two-sided: one that called everything neutral would pass the test above
		// without looking, which is how the first three got in.
		expect(saturation("f39a5e")).toBeGreaterThan(SATURATION_MAX);
		expect(saturation("f24822")).toBeGreaterThan(SATURATION_MAX);
		expect(saturation("1c1c1c")).toBe(0);
		expect(saturation("f1f1f1")).toBe(0);
	});
});

describe("bare mode hides the lab, not the work", () => {
	// `[data-lab-chrome]` is already how this lab marks what belongs to IT — the
	// hit test skips it, the pan handler leaves its presses alone — so it is the
	// honest answer to "hide the lab" too. Notes, labels and the screens are not
	// marked, and they are the work.

	const bare = rules(css).filter((r) =>
		r.selectors.some((sel) => sel.includes("[data-bare]")),
	);

	it("has the rule", () => {
		expect(bare.length).toBe(1);
		expect(bare[0]?.body).toMatch(/display:\s*none/);
	});

	it("hides what the lab marked as its own", () => {
		expect(bare[0]?.selectors[0]).toContain("[data-lab-chrome]");
	});

	it("and leaves the toasts, or there is no way back", () => {
		// Everything that could tell you which key returns is inside that rule.
		// A mode you can enter by accident and cannot leave is a trap.
		expect(bare[0]?.selectors[0]).toContain(":not(.toasts)");
	});

	it("does not reach the notes, the labels or the screens", () => {
		const selector = bare[0]?.selectors[0] ?? "";
		for (const theirs of ["sn-note", "lb-label", "data-screen", "layer"]) {
			expect(selector, theirs).not.toContain(theirs);
		}
	});
});
