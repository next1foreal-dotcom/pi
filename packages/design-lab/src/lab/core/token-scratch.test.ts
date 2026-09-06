import { describe, expect, it } from "vitest";
import { type ScratchSet, scratchSetToCss } from "./token-scratch";

function norm(css: string): string {
	return css.replace(/\s+/g, " ").trim();
}

describe("scratchSetToCss", () => {
	it("returns empty string for empty changes", () => {
		const set: ScratchSet = { target: "samantha-ui", changes: [] };
		expect(scratchSetToCss(set)).toBe("");
	});

	it("renders base light tokens into a :root block", () => {
		const set: ScratchSet = {
			target: "samantha-ui",
			changes: [{ name: "--background", light: "oklch(0.98 0.01 85)" }],
		};
		expect(norm(scratchSetToCss(set))).toBe(
			":root { --background: oklch(0.98 0.01 85); }",
		);
	});

	it("renders base dark tokens into a .dark block", () => {
		const set: ScratchSet = {
			target: "samantha-ui",
			changes: [{ name: "--background", dark: "oklch(0.19 0.01 85)" }],
		};
		expect(norm(scratchSetToCss(set))).toBe(
			".dark { --background: oklch(0.19 0.01 85); }",
		);
	});

	it("renders both light and dark base tokens in one set", () => {
		const set: ScratchSet = {
			target: "samantha-ui",
			changes: [
				{
					name: "--background",
					light: "oklch(0.98 0.01 85)",
					dark: "oklch(0.19 0.01 85)",
				},
				{ name: "--radius", light: "0.5rem" },
			],
		};
		const css = scratchSetToCss(set);
		expect(css).toContain(":root {");
		expect(css).toContain("--background: oklch(0.98 0.01 85)");
		expect(css).toContain("--radius: 0.5rem");
		expect(css).toContain(".dark {");
		expect(css).toContain("--background: oklch(0.19 0.01 85)");
	});

	it("renders a media-scoped token inside an @media block", () => {
		const set: ScratchSet = {
			target: "samantha-ui",
			changes: [
				{ name: "--radius", light: "0.5rem", media: "(min-width: 768px)" },
			],
		};
		const css = scratchSetToCss(set);
		expect(css).toContain("@media (min-width: 768px)");
		expect(css).toContain(":root {");
		expect(css).toContain("--radius: 0.5rem");
	});

	it("renders a complete mixed set: base light, base dark, and media-scoped", () => {
		const set: ScratchSet = {
			target: "samantha-ui",
			changes: [
				{
					name: "--background",
					light: "oklch(0.98 0.01 85)",
					dark: "oklch(0.19 0.01 85)",
				},
				{ name: "--radius", light: "0.5rem", media: "(min-width: 768px)" },
			],
		};
		const css = scratchSetToCss(set);
		// Should have three blocks: :root, .dark, @media
		expect(css).toContain(":root {");
		expect(css).toContain(".dark {");
		expect(css).toContain("@media (min-width: 768px)");
		// The media block should nest a :root block
		const mediaBlock = css.slice(css.indexOf("@media"));
		expect(mediaBlock).toContain(":root {");
		expect(mediaBlock).toContain("--radius: 0.5rem");
	});

	it("accepts custom selectors", () => {
		const set: ScratchSet = {
			target: "test",
			changes: [
				{ name: "--bg", light: "white", dark: "black" },
			],
		};
		const css = scratchSetToCss(set, "html", "[data-dark]");
		expect(norm(css)).toContain("html {");
		expect(norm(css)).toContain("[data-dark] {");
	});

	it("sorts media keys for deterministic output", () => {
		const set: ScratchSet = {
			target: "samantha-ui",
			changes: [
				{ name: "--size", light: "2rem", media: "(min-width: 768px)" },
				{ name: "--size", light: "1rem", media: "(min-width: 480px)" },
			],
		};
		const css = scratchSetToCss(set);
		// Lexicographic: "(min-width: 480px)" < "(min-width: 768px)"
		const idx480 = css.indexOf("(min-width: 480px)");
		const idx768 = css.indexOf("(min-width: 768px)");
		expect(idx480).toBeLessThan(idx768);
	});
});
