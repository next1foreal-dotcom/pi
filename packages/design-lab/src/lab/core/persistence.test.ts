// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
	loadPersisted,
	persistedLock,
	saveNow,
	STORAGE_KEY,
} from "./persistence";

afterEach(() => {
	localStorage.removeItem(STORAGE_KEY);
});

describe("the lock survives a remount", () => {
	it("fill + focused screen come back from disk", () => {
		saveNow({
			camera: { x: 0, y: 0, z: 1 },
			screens: {},
			mode: "fill",
			focusedId: "playground",
			exploreCamera: { x: 12, y: 8, z: 0.26 },
		});
		expect(persistedLock(loadPersisted())).toEqual({
			id: "playground",
			fill: true,
		});
	});

	it("focus comes back without filling", () => {
		saveNow({
			camera: { x: 0, y: 0, z: 0.8 },
			screens: {},
			mode: "focus",
			focusedId: "loora-landing",
		});
		expect(persistedLock(loadPersisted())).toEqual({
			id: "loora-landing",
			fill: false,
		});
	});

	it("explore is not a lock, even if a screen id is lying around", () => {
		saveNow({
			camera: { x: 0, y: 0, z: 0.26 },
			screens: {},
			mode: "explore",
			focusedId: "playground",
		});
		expect(persistedLock(loadPersisted())).toBeNull();
	});

	it("a missing or unknown snapshot is not a lock", () => {
		expect(persistedLock(null)).toBeNull();
		expect(persistedLock(loadPersisted())).toBeNull();
	});
});
