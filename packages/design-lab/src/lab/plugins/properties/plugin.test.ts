// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { peekUndo } from "../../core/history";
import {
	findBySourceLocation,
	type SourceLocation,
	type SourceTarget,
} from "../inspect/source-location";
import { PROBE_VALUE } from "./knobs";
import {
	classEditCommand,
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

/**
 * Turning a knob, across the reload the turn itself causes.
 *
 * The failure this pins was found in the running lab, not here: a plain left
 * click anywhere — including inside this panel — makes the inspect plugin drop
 * its selection, because it listens on window in the capture phase and the
 * panel's own stopPropagation is a phase too late. The very next `sync()` then
 * saw null, dropped the selection the panel was holding, and the write that was
 * already in flight came back to a panel with nothing to put the element into.
 * His source changed and the panel went blank: one turn per click, re-select
 * for the next one.
 *
 * Both sides, because "never let go" is as wrong as "always let go" — his last
 * click still has to win when he really did select something else.
 */
describe("turning a knob across the reload it causes", () => {
	const SCREEN = "packages/design-lab/src/screens/playground/screen.tsx";
	const TILE = "packages/design-lab/src/screens/playground/components/Tile.tsx";
	const spot: SourceTarget = { file: TILE, line: 69, column: 6 };

	let host: HTMLElement;
	let scroll: HTMLElement;
	let claimed: Element[];
	let posted: { prop: string; value: unknown }[];
	let selectionOf: () => Element | null;
	let setSelection: (el: Element | null) => void;
	/** The live gap, so the fake fiber answers what the fake screen renders. */
	let gap: number;

	function locate(el: Element): SourceLocation {
		if (el.getAttribute("data-src") === "tick") {
			return { ...spot, component: "Tile", problem: null };
		}
		if (el.getAttribute("data-src") === "other") {
			return { file: SCREEN, line: 12, column: 3, component: "Screen", problem: null };
		}
		return { file: null, line: null, column: null, component: null, problem: "no-react-fiber" };
	}

	function selectionFor(el: Element) {
		const loc = locate(el);
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

	function tick(): HTMLElement {
		return scroll.querySelector('[data-src="tick"]') as HTMLElement;
	}

	const index = {
		screens: [{ id: "playground", file: SCREEN }],
		problems: [],
		components: [
			{
				name: "Tile",
				file: TILE,
				exported: "default" as const,
				aliases: ["Tile"],
				reach: { kind: "screen" as const, path: ["playground", "PlaygroundScreen"] },
				screens: ["playground"],
				instances: [{ screenId: "playground", file: SCREEN, line: 49, column: 11, tag: "Tile" }],
				props: [
					{
						name: "gap",
						type: "number",
						optional: true,
						editor: { kind: "range" as const, min: 0, max: 48, step: 4, section: "Spacing" },
					},
					{ name: "children", type: "ReactNode", optional: true },
				],
			},
		],
	};

	function build(): Properties {
		document.body.innerHTML = "";
		const group = document.createElement("div");
		group.setAttribute("data-screen-id", "playground");
		scroll = document.createElement("div");
		scroll.setAttribute("data-screen-scroll", "playground");
		const span = document.createElement("span");
		span.setAttribute("data-src", "tick");
		scroll.appendChild(span);
		group.appendChild(scroll);
		host = document.createElement("div");
		document.body.append(group, host);

		gap = 16;
		claimed = [];
		posted = [];
		let current: Element | null = tick();
		selectionOf = () => current;
		setSelection = (el) => {
			current = el;
		};
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

		const deps: RefindDeps = {
			root: liveRefindDeps.root,
			prime: () => Promise.resolve(),
			find: (root, want, accept) => findBySourceLocation(root, want, { accept, locate }),
			// The reload lands between two looks, which is the only place it can:
			// a brand new node, and the fiber now carries what was written.
			wait: () => {
				const next = document.createElement("span");
				next.setAttribute("data-src", "tick");
				tick().replaceWith(next);
				return Promise.resolve();
			},
		};

		const probe = JSON.stringify(PROBE_VALUE);
		return new Properties(host, {
			refind: { attempts: 4, intervalMs: 0 },
			deps,
			knobs: {
				loadIndex: () => Promise.resolve(index),
				componentAt: () => Promise.resolve("Tile"),
				fiberOf: () => ({ type: function Tile() {}, memoizedProps: { gap } }),
				post: (body) => {
					posted.push({ prop: body.prop, value: body.value });
					// The probe is refused on its value; a real turn lands.
					if (JSON.stringify(body.value) === probe) {
						return Promise.resolve({ status: 409, body: { problem: "unsafe-value" } });
					}
					gap = body.value.value as number;
					return Promise.resolve({ status: 200, body: { ok: true, changed: true } });
				},
			},
		});
	}

	/** Let the knobs' chain of awaits run out. */
	async function idle(): Promise<void> {
		for (let i = 0; i < 16; i += 1) await Promise.resolve();
	}

	afterEach(() => {
		(window as unknown as { lab: unknown }).lab = undefined;
		document.body.innerHTML = "";
	});

	it("draws a control for the declared prop and none for the undeclared one", async () => {
		const panel = build();
		panel.sync();
		await idle();

		const state = panel.knobState();
		expect(state.rows.map((r) => r.name)).toEqual(["gap"]);
		expect(state.rows[0]).toMatchObject({ kind: "range", value: 16, writable: true });
		expect(state.instance?.line).toBe(49);
		// One question went out, and it was the probe — not the current value,
		// which for a prop the tag does not carry would have been a write.
		expect(posted).toEqual([{ prop: "gap", value: PROBE_VALUE }]);
		expect(host.querySelectorAll('.pk-ctl[data-prop="gap"]').length).toBe(1);
		expect(host.querySelectorAll('.pk-ctl[data-prop="children"]').length).toBe(0);
	});

	it("finds the element again although the click cleared the selection first", async () => {
		// The live ordering, and the one that actually broke: the pointerup that
		// turns the slider queues a sync BEFORE the browser delivers `change`, so
		// by the time the control's own handler runs the panel has already let
		// go and its rows are off the DOM. The control still fires — a detached
		// input keeps its listener — and the write still lands, which is what
		// made this look like a panel that simply forgets after every turn.
		const panel = build();
		panel.sync();
		await idle();

		const input = host.querySelector('.pk-ctl[data-prop="gap"]') as HTMLInputElement;
		setSelection(null);
		panel.sync();
		await idle();
		expect(panel.knobState().showing).toBe(false);

		input.value = "24";
		input.dispatchEvent(new Event("change"));
		await idle();
		await idle();

		expect(posted[posted.length - 1]).toEqual({
			prop: "gap",
			value: { as: "expression", value: 24 },
		});
		expect(claimed.length).toBe(1);
		expect(claimed[0]).toBe(tick());
		expect(claimed[0].isConnected).toBe(true);
		expect(panel.knobState().rows[0]?.value).toBe(24);
	});

	it("still lets his next click win when he really did select something else", async () => {
		const panel = build();
		panel.sync();
		await idle();

		const other = document.createElement("span");
		other.setAttribute("data-src", "other");
		scroll.appendChild(other);

		const turning = panel.turnKnob("gap", 24);
		setSelection(other);
		await turning;
		await idle();

		// It wrote, and it did not drag him back to the element he had left.
		expect(gap).toBe(24);
		expect(selectionOf()).toBe(other);
		expect(claimed).toEqual([]);
	});
});

// ─────────────────────── a class edit as an undoable step ────────────────────

/**
 * The step that takes a class edit back.
 *
 * The reverse of "remove x" is "add x" and nothing else: it is not "write the
 * whole list back", because between the edit and the Ctrl+Z the list may have
 * gained a class he typed in his editor, and replacing the list would throw it
 * away while telling him it undid one thing.
 *
 * Both sides, because a builder that recorded every answer would leave a step
 * on the stack for a refused write, and undo would then reverse an edit that
 * never happened.
 */
describe("a class edit as an undoable step", () => {
	const where = {
		file: "packages/design-lab/src/screens/product-list/components/Browse.tsx",
		line: 116,
		column: 11,
		tag: "p",
	};

	it("records a removal as the add that puts it back", () => {
		const cmd = classEditCommand(where, { remove: "product-title" }, {
			ok: true,
			changed: true,
			before: "row-title product-title",
			after: "row-title",
		});
		expect(cmd).toEqual({
			type: "source-edit",
			endpoint: "classes",
			what: "拿掉 product-title",
			undo: { body: { ...where, add: "product-title" }, expect: "row-title" },
			redo: { body: { ...where, remove: "product-title" }, expect: "row-title product-title" },
		});
	});

	it("records an add as the removal that takes it off", () => {
		const cmd = classEditCommand(where, { add: "lead" }, {
			ok: true,
			changed: true,
			before: "row-title",
			after: "row-title lead",
		});
		expect(cmd).toEqual({
			type: "source-edit",
			endpoint: "classes",
			what: "加上 lead",
			undo: { body: { ...where, remove: "lead" }, expect: "row-title lead" },
			redo: { body: { ...where, add: "lead" }, expect: "row-title" },
		});
	});

	it("expects a bare tag on the side where the attribute is not there", () => {
		// Taking the last class off lifts `className` clean away, and adding one
		// to a tag that had none puts it there. Both ends of that are "" from the
		// server, and the undo has to say it expects nothing rather than expect
		// an empty string, or it would not tell the two apart.
		const born = classEditCommand(where, { add: "lead" }, {
			ok: true,
			changed: true,
			before: "",
			after: "lead",
		});
		if (born?.type !== "source-edit") throw new Error("no source edit built");
		expect(born.redo.expect).toBeNull();
		expect(born.undo.expect).toBe("lead");

		const gone = classEditCommand(where, { remove: "lead" }, {
			ok: true,
			changed: true,
			before: "lead",
			after: "",
		});
		if (gone?.type !== "source-edit") throw new Error("no source edit built");
		expect(gone.undo.expect).toBeNull();
		expect(gone.redo.expect).toBe("lead");
	});

	it("records nothing when the file did not change", () => {
		// Removing a class that is not on the tag answers ok with changed:false.
		// A step here is a Ctrl+Z that appears to do nothing.
		expect(
			classEditCommand(where, { remove: "nope" }, {
				ok: true,
				changed: false,
				before: "row-title",
				after: "row-title",
			}),
		).toBeNull();
	});

	it("records nothing when the write was refused", () => {
		expect(
			classEditCommand(where, { remove: "x" }, { ok: false, error: "className is computed" }),
		).toBeNull();
	});

	it("records nothing when the answer did not say what it replaced", () => {
		expect(classEditCommand(where, { remove: "x" }, { ok: true, changed: true })).toBeNull();
	});
});

describe("the panel putting its writes on the stack", () => {
	const FILE = "packages/design-lab/src/screens/playground/screen.tsx";
	let host: HTMLElement;
	let scroll: HTMLElement;

	function fakeLocate(el: Element): SourceLocation {
		if (el.getAttribute("data-src") === "hit") {
			return { file: FILE, line: 8, column: 31, component: "Screen", problem: null };
		}
		return { file: null, line: null, column: null, component: null, problem: "no-react-fiber" };
	}

	function build(answer: unknown): Properties {
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

		let current: Element | null = p;
		const inspect = {
			selection: () => {
				if (!current) return null;
				const loc = fakeLocate(current);
				return {
					screenId: "playground",
					file: loc.file,
					line: loc.line,
					column: loc.column,
					component: loc.component,
					tag: current.tagName.toLowerCase(),
					className: current.getAttribute("class") ?? "",
					text: "",
					attached: current.isConnected,
					problem: loc.problem,
				};
			},
			selectAt: () => null,
			selectElement: (el: Element) => {
				current = el;
				return null;
			},
		};
		(window as unknown as { lab: unknown }).lab = {
			plugin: (id: string) => (id === "inspect" ? inspect : undefined),
		};

		vi.spyOn(globalThis, "fetch").mockImplementation((() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(answer),
			})) as unknown as typeof fetch);

		const deps: RefindDeps = {
			root: liveRefindDeps.root,
			prime: () => Promise.resolve(),
			find: (root, want, accept) =>
				findBySourceLocation(root, want, { accept, locate: fakeLocate }),
			wait: () => Promise.resolve(),
		};
		return new Properties(host, { refind: { attempts: 1, intervalMs: 0 }, deps });
	}

	afterEach(() => {
		vi.restoreAllMocks();
		(window as unknown as { lab: unknown }).lab = undefined;
		document.body.innerHTML = "";
		sessionStorage.clear();
	});

	it("pushes one step for a class it really took off", async () => {
		sessionStorage.clear();
		const panel = build({ ok: true, changed: true, before: "title big", after: "title" });
		panel.sync();
		await panel.removeClass("big");

		const cmd = peekUndo();
		expect(cmd?.type).toBe("source-edit");
		if (cmd?.type !== "source-edit") throw new Error("no source edit on the stack");
		expect(cmd.endpoint).toBe("classes");
		expect(cmd.what).toBe("拿掉 big");
		expect(cmd.undo.body).toEqual({ file: FILE, line: 8, column: 31, tag: "p", add: "big" });
		expect(cmd.undo.expect).toBe("title");
		expect(cmd.redo.expect).toBe("title big");
	});

	it("pushes nothing when the class was not on the tag", async () => {
		sessionStorage.clear();
		const panel = build({ ok: true, changed: false, before: "title big", after: "title big" });
		panel.sync();
		await panel.removeClass("small");

		expect(peekUndo()).toBeNull();
	});
});

/**
 * The step survives the teardown its own write caused.
 *
 * Found in the running lab, not here: turning a knob on the playground screen
 * changed the file and left nothing on the undo stack. Writing a SCREEN's
 * source makes vite replace the modules this panel lives in, and that teardown
 * arrives over the websocket while the answer to the write is still in flight.
 * The panel is right to stop touching its own DOM at that point — but the file
 * has already changed, and a step dropped for that reason is an edit he cannot
 * take back, with no sign that anything went wrong.
 *
 * Both sides: the step must still be refused when the write itself was, or a
 * teardown would turn every refusal into an undoable step.
 */
describe("a knob turn whose answer lands after the panel is gone", () => {
	const SCREEN = "packages/design-lab/src/screens/playground/screen.tsx";
	const TILE = "packages/design-lab/src/screens/playground/components/Tile.tsx";

	let host: HTMLElement;
	let release: ((answer: { status: number; body: unknown }) => void) | null;

	function locate(el: Element): SourceLocation {
		if (el.getAttribute("data-src") === "tick") {
			return { file: TILE, line: 69, column: 6, component: "Tile", problem: null };
		}
		return { file: null, line: null, column: null, component: null, problem: "no-react-fiber" };
	}

	const index = {
		screens: [{ id: "playground", file: SCREEN }],
		problems: [],
		components: [
			{
				name: "Tile",
				file: TILE,
				exported: "default" as const,
				aliases: ["Tile"],
				reach: { kind: "screen" as const, path: ["playground"] },
				screens: ["playground"],
				instances: [{ screenId: "playground", file: SCREEN, line: 49, column: 11, tag: "Tile" }],
				props: [
					{
						name: "gap",
						type: "number",
						optional: true,
						editor: { kind: "range" as const, min: 0, max: 48, step: 4 },
					},
				],
			},
		],
	};

	function build(): Properties {
		document.body.innerHTML = "";
		const group = document.createElement("div");
		group.setAttribute("data-screen-id", "playground");
		const scroll = document.createElement("div");
		scroll.setAttribute("data-screen-scroll", "playground");
		const span = document.createElement("span");
		span.setAttribute("data-src", "tick");
		scroll.appendChild(span);
		group.appendChild(scroll);
		host = document.createElement("div");
		document.body.append(group, host);

		const inspect = {
			selection: () => ({
				screenId: "playground",
				file: TILE,
				line: 69,
				column: 6,
				component: "Tile",
				tag: "span",
				className: "",
				text: "",
				attached: true,
				problem: null,
			}),
			selectAt: () => null,
			selectElement: () => null,
		};
		(window as unknown as { lab: unknown }).lab = {
			plugin: (id: string) => (id === "inspect" ? inspect : undefined),
		};

		release = null;
		const probe = JSON.stringify(PROBE_VALUE);
		return new Properties(host, {
			refind: { attempts: 1, intervalMs: 0 },
			deps: {
				root: liveRefindDeps.root,
				prime: () => Promise.resolve(),
				find: (root, want, accept) => findBySourceLocation(root, want, { accept, locate }),
				wait: () => Promise.resolve(),
			},
			knobs: {
				loadIndex: () => Promise.resolve(index),
				componentAt: () => Promise.resolve("Tile"),
				fiberOf: () => ({ type: function Tile() {}, memoizedProps: { gap: 8 } }),
				post: (body) => {
					if (JSON.stringify(body.value) === probe) {
						return Promise.resolve({ status: 409, body: { problem: "unsafe-value" } });
					}
					// The real write: held open so the teardown can land first.
					return new Promise((resolve) => {
						release = resolve as typeof release;
					}) as Promise<{ status: number; body: Record<string, unknown> }>;
				},
				settle: () => Promise.resolve(null),
			},
		});
	}

	async function idle(): Promise<void> {
		for (let i = 0; i < 16; i += 1) await Promise.resolve();
	}

	afterEach(() => {
		(window as unknown as { lab: unknown }).lab = undefined;
		document.body.innerHTML = "";
		sessionStorage.clear();
	});

	it("still records the turn", async () => {
		sessionStorage.clear();
		const panel = build();
		panel.sync();
		await idle();

		const turning = panel.turnKnob("gap", 24);
		await idle();
		// vite replaced the modules this panel lives in, because of this write.
		panel.destroy();
		release?.({
			status: 200,
			body: { ok: true, changed: true, before: "gap={8}", after: "gap={24}" },
		});
		await turning;
		await idle();

		const cmd = peekUndo();
		expect(cmd?.type).toBe("source-edit");
		if (cmd?.type !== "source-edit") throw new Error("no source edit on the stack");
		expect(cmd.endpoint).toBe("prop");
		expect(cmd.undo.body.value).toEqual({ as: "expression", value: 8 });
		expect(cmd.undo.expect).toBe("gap={24}");
	});

	it("records nothing when that write was refused", async () => {
		// The other side: a teardown must not turn a refusal into a step.
		sessionStorage.clear();
		const panel = build();
		panel.sync();
		await idle();

		const turning = panel.turnKnob("gap", 24);
		await idle();
		panel.destroy();
		release?.({ status: 409, body: { ok: false, problem: "dynamic-prop", error: "not a literal" } });
		await turning;
		await idle();

		expect(peekUndo()).toBeNull();
	});
});
