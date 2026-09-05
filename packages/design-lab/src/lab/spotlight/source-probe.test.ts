// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { sourceOf } from "./source-probe";

const SCREEN_STACK = `Error
    at PlaygroundScreen (http://localhost:5180/src/screens/playground/screen.tsx:19:25)`;

function attachFiber(el: Element, fiber: object): void {
	Object.assign(el, { __reactFiber$test: fiber });
}

describe("sourceOf", () => {
	it("reads file/line/col/component from a string _debugStack on a fake fiber", () => {
		const el = document.createElement("div");
		attachFiber(el, {
			_debugStack: SCREEN_STACK,
			return: null,
		});
		expect(sourceOf(el)).toEqual({
			file: "src/screens/playground/screen.tsx",
			line: 19,
			col: 25,
			component: "PlaygroundScreen",
		});
	});

	it("reads the same fields when _debugStack is an Error", () => {
		const el = document.createElement("button");
		const err = new Error("fiber");
		err.stack = `Error: fiber
    at ProductCard (http://localhost:5180/src/screens/product-list/card.tsx:42:8)`;
		attachFiber(el, { _debugStack: err, return: null });
		expect(sourceOf(el)).toEqual({
			file: "src/screens/product-list/card.tsx",
			line: 42,
			col: 8,
			component: "ProductCard",
		});
	});

	it("strips the origin and query so file is repo-relative", () => {
		const el = document.createElement("span");
		attachFiber(el, {
			_debugStack:
				"at PlaygroundScreen (http://localhost:5180/src/screens/playground/screen.tsx?t=171000:19:25)",
			return: null,
		});
		const ref = sourceOf(el);
		expect(ref?.file).toBe("src/screens/playground/screen.tsx");
		expect(ref?.file).not.toContain("http://");
		expect(ref?.file).not.toContain("?");
	});

	it("prefers the first /src/screens/ frame when walking fiber.return", () => {
		const el = document.createElement("div");
		const host = {
			_debugStack:
				"at div (http://localhost:5180/node_modules/.vite/deps/react-dom.js:12:1)",
			return: {
				_debugStack: SCREEN_STACK,
				return: null,
			},
		};
		attachFiber(el, host);
		expect(sourceOf(el)?.file).toBe("src/screens/playground/screen.tsx");
		expect(sourceOf(el)?.component).toBe("PlaygroundScreen");
	});

	it("falls back to the first /src/ frame outside node_modules/.vite", () => {
		const el = document.createElement("div");
		attachFiber(el, {
			_debugStack: `Error
    at Button (http://localhost:5180/node_modules/.vite/deps/react.js:1:1)
    at Header (http://localhost:5180/src/lab/core/lab-view.tsx:88:3)`,
			return: null,
		});
		expect(sourceOf(el)).toEqual({
			file: "src/lab/core/lab-view.tsx",
			line: 88,
			col: 3,
			component: "Header",
		});
	});

	it("returns null when the stack only has node_modules frames", () => {
		const el = document.createElement("div");
		attachFiber(el, {
			_debugStack: `Error
    at Button (http://localhost:5180/node_modules/.vite/deps/react.js:1:1)
    at render (http://localhost:5180/node_modules/.vite/deps/react-dom.js:9:9)`,
			return: null,
		});
		expect(sourceOf(el)).toBeNull();
	});

	it("returns null when the element has no fiber", () => {
		expect(sourceOf(document.createElement("div"))).toBeNull();
	});

	it("returns null and does not throw in production (fiber, no _debugStack)", () => {
		const el = document.createElement("div");
		attachFiber(el, { return: null });
		expect(() => sourceOf(el)).not.toThrow();
		expect(sourceOf(el)).toBeNull();
	});

	it("returns null and does not throw when _debugStack is neither string nor Error", () => {
		const el = document.createElement("div");
		attachFiber(el, { _debugStack: { nope: true }, return: null });
		expect(() => sourceOf(el)).not.toThrow();
		expect(sourceOf(el)).toBeNull();
	});
});
