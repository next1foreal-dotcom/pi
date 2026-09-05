/**
 * A screen has to reflow off ITS OWN width, not the browser's.
 *
 * The lab puts four screens on one canvas at once. Each sits in a frame the
 * operator can drag to any size, and fill mode hands one of them the whole
 * viewport. So "the window is 1440 wide" says nothing at all about the screen:
 * a 420-wide frame on a 1440 monitor has to get the narrow layout, and a
 * 1440-wide screen locked into fill mode on a small laptop has to get the wide
 * one. `@media (max-width: …)` answers the wrong question in both directions.
 *
 * The right rulers are a container query on the screen root (the root's inline
 * size IS the frame's width — the camera is a transform, and transforms do not
 * change layout size) or `frameSize` from `useScreen()`.
 *
 * This is a source gate, not a rendering test: jsdom implements neither
 * container queries nor layout, so it cannot tell you what a rule DID. It can
 * tell you which ruler was picked, which is the mistake worth catching.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCREENS_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../screens",
);

/** The three frame widths this package is specified at. */
const WIDTHS = { narrow: 420, mid: 768, wide: 1440 } as const;

type Screen = {
	dir: string;
	css: string;
	tsx: string;
	/** Every `max-width` threshold used by a `@container` query, in px. */
	thresholds: number[];
	containerNames: string[];
	usedNames: string[];
};

function filesUnder(dir: string, ext: RegExp): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...filesUnder(full, ext));
		else if (ext.test(entry.name) && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Comments are prose ABOUT these rules — the stylesheet explaining why it does
 * not use `@media (max-width: …)` has to be allowed to write the phrase down.
 * So everything below is scanned with comments removed. `[^:]` in front of
 * `//` keeps a `https://` inside a string literal from eating the line.
 *
 * Stripping is a measuring instrument in its own right, so there is a positive
 * control on it below rather than trust: a stripper that ate too much would
 * turn every rule in this file green.
 */
function stripComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
}

function read(paths: string[]): string {
	return stripComments(paths.map((p) => readFileSync(p, "utf8")).join("\n"));
}

const screens: Screen[] = readdirSync(SCREENS_DIR, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => {
		const dir = join(SCREENS_DIR, e.name);
		const css = read(filesUnder(dir, /\.css$/));
		const tsx = read(filesUnder(dir, /\.tsx?$/));
		const thresholds: number[] = [];
		const usedNames: string[] = [];
		for (const m of css.matchAll(
			/@container\s+([A-Za-z_-][\w-]*)?\s*\(([^)]*)\)/g,
		)) {
			if (m[1]) usedNames.push(m[1]);
			const px = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(m[2]);
			if (px) thresholds.push(Number(px[1]));
		}
		return {
			dir: e.name,
			css,
			tsx,
			thresholds,
			containerNames: [...css.matchAll(/container-name:\s*([\w-]+)/g)].map(
				(m) => m[1],
			),
			usedNames,
		};
	});

/** How many container rules a frame of `width` px would actually trigger. */
function firing(s: Screen, width: number): number {
	return s.thresholds.filter((t) => width <= t).length;
}

describe("the four screens are measured against their frame", () => {
	it("found all four screens", () => {
		// A gate over an empty list is a green light that means nothing.
		expect(screens.map((s) => s.dir).sort()).toEqual([
			"loora-landing",
			"mosaic",
			"playground",
			"product-list",
		]);
	});

	it.each(screens.map((s) => s.dir))(
		"%s still has its rules after the prose is stripped",
		(dir) => {
			// The positive control for `stripComments`. Every screen's stylesheet
			// carries a long comment naming the very strings the gates below
			// look for; if stripping is over-eager, it is over-eager here.
			const s = screens.find((x) => x.dir === dir)!;
			expect(s.css).toContain("@container");
			expect(s.css).toContain("container-type: inline-size");
			expect(s.tsx).toContain("export default function");
		},
	);

	it.each(screens.map((s) => s.dir))(
		"%s declares a container so its own width is the ruler",
		(dir) => {
			const s = screens.find((x) => x.dir === dir)!;
			// A `frameSize`-driven style is the other legal ruler (loora reads
			// `frameSize.width < 720` in JS and still does). Every screen also
			// carries real container queries, so the gate asks for the one a
			// stylesheet can be checked for.
			expect(s.css).toMatch(/container-type:\s*inline-size/);
			expect(s.containerNames.length).toBeGreaterThan(0);
			expect(s.usedNames.length).toBeGreaterThan(0);
		},
	);

	it.each(screens.map((s) => s.dir))(
		"%s only queries container names it actually declares",
		(dir) => {
			const s = screens.find((x) => x.dir === dir)!;
			// A misspelled name is not an error, it is a query that silently
			// never matches — the exact failure this whole file exists to stop.
			const undeclared = s.usedNames.filter(
				(n) => !s.containerNames.includes(n),
			);
			expect(undeclared).toEqual([]);
		},
	);

	it("no screen lays itself out against the browser window", () => {
		// `prefers-reduced-motion` and friends are fine — this is about width.
		const offenders = screens
			.filter((s) => /@media[^{]*\((?:max|min)-width/.test(s.css))
			.map((s) => s.dir);
		expect(offenders).toEqual([]);
	});

	it("no screen measures the window in JS either", () => {
		const offenders = screens
			.filter((s) => /window\.(innerWidth|innerHeight)/.test(s.tsx))
			.map((s) => s.dir);
		expect(offenders).toEqual([]);
	});
});

describe("the layout genuinely steps down as the frame narrows", () => {
	// Counting rules is a proxy for "the layout changed", and a coarse one —
	// but it does catch the two failures that matter: a screen with a single
	// token breakpoint that calls itself responsive, and a screen that quietly
	// restyles itself at full width. The real look is judged by eye.

	it.each(screens.map((s) => s.dir))("%s is untouched at 1440", (dir) => {
		const s = screens.find((x) => x.dir === dir)!;
		expect(firing(s, WIDTHS.wide)).toBe(0);
	});

	it.each(screens.map((s) => s.dir))("%s reflows at 768", (dir) => {
		const s = screens.find((x) => x.dir === dir)!;
		expect(firing(s, WIDTHS.mid)).toBeGreaterThan(0);
	});

	it.each(screens.map((s) => s.dir))(
		"%s reflows further at 420 than it did at 768",
		(dir) => {
			const s = screens.find((x) => x.dir === dir)!;
			// One breakpoint reused at both widths is not two steps, it is one
			// step with two names.
			expect(firing(s, WIDTHS.narrow)).toBeGreaterThan(firing(s, WIDTHS.mid));
		},
	);
});
