import { afterEach, describe, expect, it } from "vitest";
import {
	currentWork,
	noteWork,
	noteWorkFromBody,
	sayWork,
	workAtFromBody,
	workKey,
} from "./work";

afterEach(() => {
	noteWork(null);
});

describe("the write is a place in his file", () => {
	it("reads file, line, column off a prop body", () => {
		const at = workAtFromBody({
			file: "packages/design-lab/src/screens/playground/screen.tsx",
			line: 49,
			column: 11,
			tag: "Tile",
			prop: "tone",
			value: { as: "string", value: "loud" },
		});
		expect(at).toEqual({
			file: "packages/design-lab/src/screens/playground/screen.tsx",
			line: 49,
			column: 11,
			label: "tone → loud",
		});
		expect(workKey(at!)).toBe(
			"packages/design-lab/src/screens/playground/screen.tsx:49:11",
		);
	});

	it("ignores a body that is not a source location", () => {
		expect(workAtFromBody({ tag: "Tile" })).toBeNull();
		expect(workAtFromBody({ file: "", line: 1, column: 1 })).toBeNull();
	});

	it("noteWorkFromBody is what the write calls", () => {
		noteWorkFromBody({
			file: "a.tsx",
			line: 8,
			column: 31,
			tag: "h2",
		});
		expect(currentWork()?.label).toBe("h2");
		noteWorkFromBody({ file: "a.tsx", line: 8, column: 31, tag: "p" }, "Tile");
		expect(currentWork()?.label).toBe("Tile");
	});
});

/**
 * Sample 9 / narrating: a chip that names the component is a nameplate.
 * The chip is the sentence of the write — something he could disagree with.
 */
describe("the chip is the sentence, not the component name", () => {
	it("a declared knob is prop → value", () => {
		expect(
			sayWork({
				tag: "Tile",
				prop: "tone",
				value: { as: "string", value: "loud" },
			}),
		).toBe("tone → loud");
		expect(
			sayWork({
				tag: "Tile",
				prop: "gap",
				value: { as: "expression", value: 16 },
			}),
		).toBe("gap → 16");
		expect(
			sayWork({
				tag: "Tile",
				prop: "dense",
				value: { as: "expression", value: true },
			}),
		).toBe("dense → true");
	});

	it("a class write is 加上 / 拿掉 the token", () => {
		expect(sayWork({ tag: "h2", add: "lead" })).toBe("加上 lead");
		expect(sayWork({ tag: "h2", remove: "product-title" })).toBe("拿掉 product-title");
	});

	it("a text write quotes the copy", () => {
		expect(sayWork({ tag: "h2", text: "Knobs" })).toBe("「Knobs」");
	});

	it("a location with no payload still falls back to the tag", () => {
		expect(sayWork({ tag: "Tile" })).toBe("Tile");
		expect(sayWork({})).toBe("writing");
	});
});
