// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	findBySourceLocation,
	type SourceLocation,
	type SourceTarget,
} from "../inspect/source-location";
import {
	classesOf,
	editability,
	editLanded,
	liveRefindDeps,
	Properties,
	refind,
	type RefindDeps,
} from "./plugin";

/**
 * The panel must never offer to edit something the editor behind it would
 * refuse. Every refusal it does not predict arrives as a failed write he has
 * already decided on in his head — he clicks the ×, the class stays, and the
 * next thing he trusts less is the panel.
 *
 * Both sides of each rule, because "offer nothing" passes every refusal test
 * and would make the panel a read-only label.
 */

const ok = {
	screenId: "product-list",
	file: "packages/design-lab/src/screens/product-list/components/Browse.tsx",
	line: 116,
	column: 11,
	component: "BrowseRow",
	tag: "p",
	className: "product-title",
	text: "a title",
	attached: true,
	problem: null,
};

describe("what the panel offers", () => {
	it("edits a tag it can point at", () => {
		const state = editability(ok);
		expect(state.show).toBe(true);
		expect(state.editable).toBe(true);
		expect(state.note).toBeNull();
	});

	it("shows but does not edit a node the hot update replaced", () => {
		// The location is still on screen and worth reading; writing to it would
		// be writing from a snapshot of a node that is gone.
		const state = editability({ ...ok, attached: false });
		expect(state.show).toBe(true);
		expect(state.editable).toBe(false);
		expect(state.bad).toBe(true);
	});

	it("shows but does not edit when the location could not be resolved", () => {
		const state = editability({
			...ok,
			line: null,
			column: null,
			problem: "source-map-pending",
		});
		expect(state.editable).toBe(false);
		expect(state.note).toContain("source-map-pending");
	});

	it("will not edit a file that is not JSX", () => {
		// The editor parses JSX tags; pointed at anything else it would be
		// rewriting bytes by coincidence.
		expect(editability({ ...ok, file: "packages/design-lab/src/lab/core/math.ts" }).editable).toBe(false);
	});

	it("shows nothing at all when nothing is selected", () => {
		expect(editability(null)).toEqual({ show: false, editable: false, note: null, bad: false });
	});
});

describe("reading a class list", () => {
	it("splits on any run of whitespace", () => {
		expect(classesOf("a  b\tc")).toEqual(["a", "b", "c"]);
	});

	it("an absent or empty list is no chips, not one empty chip", () => {
		expect(classesOf(null)).toEqual([]);
		expect(classesOf("   ")).toEqual([]);
	});
});

/**
 * Finding the element again after the write.
 *
 * The panel's whole claim is that the tag it names is the tag it edits. Losing
 * the node to a hot reload and picking a new one up is where that can quietly
 * stop being true, so what is tested here is not "does it find something" but
 * "would it ever hand back the wrong thing, or keep looking forever".
 */
describe("did the edit land on this node", () => {
	it("does not accept a node still wearing the class we just removed", () => {
		// The old node is standing at the same file:line:column until the reload
		// lands. Position alone cannot tell it apart from its replacement; the
		// class we just wrote can.
		expect(editLanded("title big", { remove: "big" })).toBe(false);
		expect(editLanded("title", { remove: "big" })).toBe(true);
	});

	it("does not accept a node that has not got the class we just added", () => {
		expect(editLanded("title", { add: "big" })).toBe(false);
		expect(editLanded("title big", { add: "big" })).toBe(true);
	});

	it("reads several names the way the server splits them", () => {
		// The input box sends whatever he typed; the server runs splitClasses
		// over it, so "a b" is two classes and this has to agree.
		expect(editLanded("title a", { add: "a b" })).toBe(false);
		expect(editLanded("title a b", { add: "a b" })).toBe(true);
		expect(editLanded("title b", { remove: "a b" })).toBe(false);
		expect(editLanded("title", { remove: "a b" })).toBe(true);
	});

	it("ignores classes it was not asked about", () => {
		// A component may put a class on the node itself. Requiring the whole
		// list to match would mean the panel could never find that node again.
		expect(editLanded("title big is-open", { remove: "big" })).toBe(false);
		expect(editLanded("title is-open", { remove: "big" })).toBe(true);
	});
});

describe("waiting for it to come back", () => {
	const target = { screenId: "playground", file: "a.tsx", line: 8, column: 31 };
	const fast = { attempts: 5, intervalMs: 0 };

	/** A lab where the node appears on the `appearsOn`-th look, or never. */
	function labWhere(appearsOn: number | null) {
		const root = document.createElement("div");
		const el = document.createElement("p");
		const looks: number[] = [];
		const waits: number[] = [];
		const primed: number[] = [];
		const deps: RefindDeps = {
			root: () => root,
			prime: (r) => {
				primed.push(r === root ? 1 : 0);
				return Promise.resolve();
			},
			find: (_r, _t, accept) => {
				looks.push(1);
				if (appearsOn === null || looks.length < appearsOn) return null;
				return accept(el) ? el : null;
			},
			wait: (ms) => {
				waits.push(ms);
				return Promise.resolve();
			},
		};
		return { deps, el, looks, waits, primed };
	}

	it("keeps looking until the reload lands", async () => {
		// The write returns as soon as the file is on disk. Everything that has
		// to happen after that -- vite noticing, the module being served, the
		// new map being read -- has not happened yet, so one look is not enough
		// and a fixed wait would be guessing at a machine's speed.
		const lab = labWhere(3);
		await expect(refind(target, { remove: "big" }, fast, lab.deps)).resolves.toBe(lab.el);
		expect(lab.looks.length).toBe(3);
		expect(lab.primed.length).toBe(3);
	});

	it("gives up after a bounded number of looks", async () => {
		// A panel that waited forever would be a panel that is still waiting
		// when he has gone off to do something else.
		const lab = labWhere(null);
		await expect(refind(target, { remove: "big" }, fast, lab.deps)).resolves.toBeNull();
		expect(lab.looks.length).toBe(fast.attempts);
		expect(lab.waits.length).toBe(fast.attempts - 1);
	});

	it("refuses the node that still carries the class we removed", async () => {
		// The stale node is at the right position and is on screen: this is the
		// one case where "found it" would be wrong, so it has to be the gate and
		// not the position that decides.
		const lab = labWhere(1);
		lab.el.className = "title big";
		await expect(refind(target, { remove: "big" }, fast, lab.deps)).resolves.toBeNull();
		expect(lab.looks.length).toBe(fast.attempts);
		// The same node, once the reload has actually replaced it, is taken.
		lab.el.className = "title";
		await expect(refind(target, { remove: "big" }, fast, lab.deps)).resolves.toBe(lab.el);
	});

	it("does not wait at all for a selection that was never in a screen", async () => {
		const lab = labWhere(1);
		const nowhere = { ...target, screenId: null };
		await expect(refind(nowhere, { remove: "big" }, fast, lab.deps)).resolves.toBeNull();
		expect(lab.looks.length).toBe(0);
		expect(lab.waits.length).toBe(0);
	});

	it("looks again when the screen's scroller is not there yet", async () => {
		// The scroller outlives the modules rendered into it, but a remount can
		// take it away for a beat. That is not an answer either way.
		const lab = labWhere(1);
		let ready = false;
		const late: RefindDeps = {
			...lab.deps,
			root: () => (ready ? document.createElement("div") : null),
			wait: (ms) => {
				ready = true;
				return lab.deps.wait(ms);
			},
		};
		await expect(refind(target, { remove: "big" }, fast, late)).resolves.toBe(lab.el);
		expect(lab.looks.length).toBe(1);
		expect(lab.waits.length).toBe(1);
	});
});

/**
 * The panel, end to end, across the reload its own write causes.
 *
 * The two outcomes are the whole feature: it either finds the element again --
 * and then the next class is one click, not two -- or it says it did not, in
 * words that send him back to the canvas. What must never happen is the third
 * thing: a panel still confidently describing a node it lost.
 */
describe("the panel across a hot reload", () => {
	const FILE = "packages/design-lab/src/screens/playground/screen.tsx";
	const target: SourceTarget = { file: FILE, line: 8, column: 31 };

	let host: HTMLElement;
	let scroll: HTMLElement;
	let claimed: Element[];
	let posted: number;

	/** Two known positions, so "he clicked something else" is a real position. */
	function fakeLocate(el: Element): SourceLocation {
		const mark = el.getAttribute("data-src");
		if (mark === "hit") return { ...target, component: "Screen", problem: null };
		if (mark === "other") {
			return { file: FILE, line: 12, column: 3, component: "Screen", problem: null };
		}
		return { file: null, line: null, column: null, component: null, problem: "no-react-fiber" };
	}

	function selectionFor(el: Element) {
		const loc = fakeLocate(el);
		return {
			screenId: "playground",
			file: loc.file,
			line: loc.line,
			column: loc.column,
			component: loc.component,
			tag: el.tagName.toLowerCase(),
			className: el.getAttribute("class") ?? "",
			text: "",
			attached: el.isConnected,
			problem: loc.problem,
		};
	}

	/** The node the panel is pointed at, as the screen currently holds it. */
	function hit(): HTMLElement {
		return scroll.querySelector('[data-src="hit"]') as HTMLElement;
	}

	/** What a landed reload looks like: same position, a brand new node. */
	function reload(className: string): void {
		const next = document.createElement("p");
		next.setAttribute("data-src", "hit");
		next.className = className;
		hit().replaceWith(next);
	}

	function build(onWait: () => void): Properties {
		document.body.innerHTML = "";
		const group = document.createElement("div");
		group.setAttribute("data-screen-id", "playground");
		scroll = document.createElement("div");
		scroll.setAttribute("data-screen-scroll", "playground");
		const p = document.createElement("p");
		p.setAttribute("data-src", "hit");
		p.className = "title big";
		scroll.appendChild(p);
		group.appendChild(scroll);
		host = document.createElement("div");
		document.body.append(group, host);

		claimed = [];
		let current: Element | null = hit();
		const inspect = {
			selection: () => (current ? selectionFor(current) : null),
			selectAt: () => null,
			selectElement: (el: Element) => {
				claimed.push(el);
				current = el;
				return selectionFor(el);
			},
		};
		(window as unknown as { lab: unknown }).lab = {
			plugin: (id: string) => (id === "inspect" ? inspect : undefined),
		};

		posted = 0;
		const ok = () => {
			posted += 1;
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
		};
		vi.spyOn(globalThis, "fetch").mockImplementation(ok as unknown as typeof fetch);

		const deps: RefindDeps = {
			root: liveRefindDeps.root,
			prime: () => Promise.resolve(),
			find: (root, want, accept) =>
				findBySourceLocation(root, want, { accept, locate: fakeLocate }),
			// The reload lands between two looks, which is the only place it can.
			wait: () => {
				onWait();
				return Promise.resolve();
			},
		};
		return new Properties(host, { refind: { attempts: 4, intervalMs: 0 }, deps });
	}

	function noteOf(): string {
		return (host.querySelector(".pp-note") as HTMLElement).textContent ?? "";
	}

	afterEach(() => {
		vi.restoreAllMocks();
		(window as unknown as { lab: unknown }).lab = undefined;
		document.body.innerHTML = "";
	});

	it("goes on describing the element he is editing, so the next change is one click", async () => {
		let reloaded = false;
		const panel = build(() => {
			// One look at the node that is still standing, then vite catches up.
			if (reloaded) return;
			reloaded = true;
			reload("title");
		});
		panel.sync();
		await panel.removeClass("big");

		expect(posted).toBe(1);
		// It re-selected, and what it re-selected is the NEW node -- not the one
		// it was holding when it wrote, which was still at the same position and
		// still on screen at the first look.
		expect(claimed.length).toBe(1);
		expect(claimed[0]).toBe(hit());
		expect(claimed[0].isConnected).toBe(true);
		expect(claimed[0].className).toBe("title");
		// Nothing to read and nothing to click: the panel is simply usable again.
		expect(noteOf()).toBe("");
		expect(host.querySelector(".pp-panel")?.hasAttribute("data-show")).toBe(true);
		expect((host.querySelector(".pp-add") as HTMLElement).style.display).toBe("");
		// The other side of the give-up case below: here the chips really are
		// live, so their buttons are there to be clicked.
		expect(host.querySelectorAll(".pp-chip button").length).toBeGreaterThan(0);
	});

	it("says so, in the same words, when the element never comes back", async () => {
		// The write landed -- the file on disk changed -- but nothing arrived to
		// render it. The panel must not go on pointing at a node it did not
		// find, and this line is the honest end of that path.
		const panel = build(() => {});
		panel.sync();
		await panel.removeClass("big");

		expect(posted).toBe(1);
		expect(claimed.length).toBe(0);
		expect(noteOf()).toBe("改好了 · 再点一下它继续改");
		expect(host.querySelector(".pp-note")?.hasAttribute("data-bad")).toBe(false);
		// The chips are a snapshot of a node it could not find, so nothing on
		// them is still offering to change it.
		expect(host.querySelectorAll(".pp-chip button").length).toBe(0);
		expect((host.querySelector(".pp-add") as HTMLElement).style.display).toBe("none");
	});

	it("does not pull the selection off something he clicked while it waited", async () => {
		// The element DOES come back this time, so there is something to take --
		// and taking it would be wrong. His last click wins, or the next remove
		// lands on an element he stopped looking at a second ago.
		const panel = build(() => reload("title"));
		panel.sync();
		const other = document.createElement("span");
		other.setAttribute("data-src", "other");
		scroll.appendChild(other);
		const inspect = (window as unknown as { lab: { plugin(id: string): unknown } }).lab.plugin(
			"inspect",
		) as { selectElement(el: Element): unknown };

		const write = panel.removeClass("big");
		inspect.selectElement(other);
		await write;

		expect(claimed).toEqual([other]);
		expect(noteOf()).not.toBe("改好了 · 再点一下它继续改");
	});
});
