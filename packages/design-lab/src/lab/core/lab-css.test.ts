import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read the stylesheet as text: importing it would hand back the CSS-modules
// class-name map, and `?raw` / `?inline` lose to that transform.
const css = readFileSync(new URL("./lab.module.css", import.meta.url), "utf8");

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
