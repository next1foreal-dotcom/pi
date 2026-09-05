import { describe, expect, it } from "vitest";
import { screenAt } from "./screen-at";
import type { Rect } from "./types";

const screens = [{ id: "playground" }, { id: "product-list" }];
const layouts: Record<string, Rect> = {
	playground: { x: 0, y: 0, width: 1440, height: 900 },
	"product-list": { x: 1640, y: 0, width: 1440, height: 900 },
};

describe("screenAt", () => {
	it("returns the first screen whose frame contains the page-space point", () => {
		expect(screenAt({ x: 10, y: 10 }, screens, layouts)).toBe("playground");
		expect(screenAt({ x: 1640, y: 0 }, screens, layouts)).toBe("product-list");
		expect(screenAt({ x: 2000, y: 400 }, screens, layouts)).toBe("product-list");
	});

	it("returns null when the point sits on no screen", () => {
		expect(screenAt({ x: 1500, y: 10 }, screens, layouts)).toBeNull();
		expect(screenAt({ x: -1, y: 0 }, screens, layouts)).toBeNull();
		expect(screenAt({ x: 10, y: 901 }, screens, layouts)).toBeNull();
	});
});
