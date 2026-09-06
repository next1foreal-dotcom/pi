import { describe, expect, it } from "vitest";
import { scopeTokenCss } from "./scope-token-css";

function norm(css: string): string {
	return css.replace(/\s+/g, " ").trim();
}

describe("scopeTokenCss", () => {
	it("rewrites :root to the scope", () => {
		expect(norm(scopeTokenCss(":root { --bg: white; }", ".layer"))).toBe(
			".layer { --bg: white; }",
		);
	});

	it("rewrites html to the scope", () => {
		expect(norm(scopeTokenCss("html { --bg: white; }", ".layer"))).toBe(
			".layer { --bg: white; }",
		);
	});

	it("prefixes .dark with the scope", () => {
		expect(norm(scopeTokenCss(".dark { --bg: black; }", ".layer"))).toBe(
			".layer .dark { --bg: black; }",
		);
	});

	it("does not double-prefix a selector that already starts with the scope", () => {
		expect(norm(scopeTokenCss(".layer { --bg: white; }", ".layer"))).toBe(
			".layer { --bg: white; }",
		);
		expect(norm(scopeTokenCss(".layer .dark { --bg: black; }", ".layer"))).toBe(
			".layer .dark { --bg: black; }",
		);
	});
});
