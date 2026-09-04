// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasRuler } from "./canvas-ruler";

const STORAGE_KEY = "interaction-lab:guides:v1";

function makeRuler() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const ruler = new CanvasRuler({
		host,
		getCamera: () => ({ x: 0, y: 0, z: 1 }),
		getOrigin: () => ({ x: 0, y: 0 }),
		getViewport: () => ({ width: 800, height: 600 }),
		getAppearance: () => "light",
	});
	return { host, ruler };
}

function stored(): { a: string; p: number }[] {
	const raw = localStorage.getItem(STORAGE_KEY);
	return raw ? JSON.parse(raw).guides : [];
}

describe("CanvasRuler programmatic API", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = "";
	});

	it("addGuide places a guide that getGuides reports once enabled", () => {
		const { ruler } = makeRuler();
		ruler.enable();
		const g = ruler.addGuide("x", 240);
		expect(g).toMatchObject({ axis: "x", pos: 240 });
		expect(ruler.getGuides()).toEqual([{ id: g.id, axis: "x", pos: 240 }]);
		ruler.destroy();
	});

	it("keeps snapping unchanged while rulers are off", () => {
		// getGuides feeds frame snapping; a guide added with the rulers off must
		// not start snapping frames before the user turns them on.
		const { ruler } = makeRuler();
		ruler.addGuide("y", 100);
		expect(ruler.getGuides()).toEqual([]);
		ruler.enable();
		expect(ruler.getGuides()).toHaveLength(1);
		ruler.destroy();
	});

	it("persists a programmatic guide the same way a dragged one is", () => {
		// insert() alone does not save — only the drag-end path used to commit.
		const { ruler } = makeRuler();
		ruler.enable();
		ruler.addGuide("x", 32);
		vi.advanceTimersByTime(200);
		expect(stored()).toEqual([{ a: "x", p: 32 }]);
		ruler.destroy();
	});

	it("removeGuide and clearGuides empty it, and persist that too", () => {
		const { ruler } = makeRuler();
		ruler.enable();
		const a = ruler.addGuide("x", 10);
		ruler.addGuide("y", 20);
		ruler.removeGuide(a.id);
		vi.advanceTimersByTime(200);
		expect(ruler.getGuides()).toEqual([{ id: 2, axis: "y", pos: 20 }]);
		expect(stored()).toEqual([{ a: "y", p: 20 }]);
		ruler.clearGuides();
		vi.advanceTimersByTime(200);
		expect(ruler.getGuides()).toEqual([]);
		expect(stored()).toEqual([]);
		ruler.destroy();
	});

	it("enable and disable are idempotent, unlike toggle", () => {
		const { ruler } = makeRuler();
		ruler.addGuide("x", 5);
		ruler.enable();
		ruler.enable();
		expect(ruler.getGuides()).toHaveLength(1);
		ruler.disable();
		ruler.disable();
		expect(ruler.getGuides()).toEqual([]);
		ruler.destroy();
	});
});
