import { describe, expect, it } from "vitest";
import { editProp } from "../../../../../her/src/preview/jsx-attr.ts";
import type { ComponentEntry, ComponentInstance, PropInfo } from "../../components/types";
import {
	classifyProbe,
	displayValue,
	fiberComponentName,
	knobLanded,
	knobsOf,
	optionsFor,
	pickInstance,
	PROBE_VALUE,
	propsOfComponent,
	sectionsOf,
	UNSECTIONED,
	writeFor,
	type KnobSpec,
	type PropsFiber,
} from "./knobs";

/**
 * The panel's rules, away from the DOM.
 *
 * Both sides of every rule, because the cheap way to pass a suite of refusals
 * is to refuse everything — a panel with no controls, or with every control
 * greyed out, satisfies "never lies" and is useless. So each "must not" here
 * is paired with the "must" it would otherwise swallow.
 */

const TILE = "packages/design-lab/src/screens/playground/components/Tile.tsx";

function prop(over: Partial<PropInfo> & { name: string }): PropInfo {
	return { type: "number", optional: true, ...over };
}

function entry(props: PropInfo[]): ComponentEntry {
	return {
		name: "Tile",
		file: TILE,
		exported: "default",
		aliases: ["Tile"],
		props,
		reach: { kind: "screen", path: ["playground", "PlaygroundScreen"] },
		screens: ["playground"],
		instances: [],
	};
}

function knob(over: Partial<KnobSpec> & { editor: KnobSpec["editor"] }): KnobSpec {
	return { name: "gap", type: "number", ...over };
}

// ─────────────────────────── which props get a control ───────────────────────

describe("only a declared editor becomes a control", () => {
	it("offers the prop that declared one", () => {
		// The positive half. Without it, "return nothing" passes the rule below.
		const knobs = knobsOf(
			entry([prop({ name: "gap", editor: { kind: "range", min: 0, max: 48 } })]),
		);
		expect(knobs.map((k) => k.name)).toEqual(["gap"]);
		expect(knobs[0].editor.kind).toBe("range");
	});

	it("does not invent a control for a prop that declared none", () => {
		// `children: ReactNode` and `product: Product` are the real cases. A
		// control built from an inferred type is a guess, and the index already
		// decided guesses are worse than nothing.
		const knobs = knobsOf(
			entry([
				prop({ name: "gap", editor: { kind: "range" } }),
				prop({ name: "children", type: "ReactNode" }),
				prop({ name: "product", type: "Product" }),
			]),
		);
		expect(knobs.map((k) => k.name)).toEqual(["gap"]);
	});

	it("carries the literal values across, for an enum with no options=", () => {
		const knobs = knobsOf(
			entry([
				prop({
					name: "tone",
					type: '"quiet" | "loud"',
					literalValues: ["quiet", "loud"],
					editor: { kind: "enum" },
				}),
			]),
		);
		expect(knobs[0].literalValues).toEqual(["quiet", "loud"]);
	});

	it("has nothing to offer for a component that is not in the index", () => {
		expect(knobsOf(null)).toEqual([]);
	});
});

// ────────────────────────────────── sections ─────────────────────────────────

describe("grouping by section", () => {
	const knobs = [
		knob({ name: "gap", editor: { kind: "range", section: "Spacing" } }),
		knob({ name: "tone", editor: { kind: "enum", section: "Look" } }),
		knob({ name: "dense", editor: { kind: "boolean", section: "Spacing" } }),
		knob({ name: "loose", editor: { kind: "boolean" } }),
	];

	it("puts each declared section's props together, in the order they were declared", () => {
		const sections = sectionsOf(knobs);
		expect(sections.map((s) => s.name)).toEqual(["Spacing", "Look", UNSECTIONED]);
		expect(sections[0].knobs.map((k) => k.name)).toEqual(["gap", "dense"]);
		expect(sections[1].knobs.map((k) => k.name)).toEqual(["tone"]);
	});

	it("keeps a prop that named a section out of the leftovers group", () => {
		// The negative half of the same rule: dumping everything into one group
		// would satisfy "every knob appears somewhere".
		const leftovers = sectionsOf(knobs).find((s) => s.name === UNSECTIONED);
		expect(leftovers?.knobs.map((k) => k.name)).toEqual(["loose"]);
	});

	it("makes no leftovers group when every prop named a section", () => {
		const sections = sectionsOf(knobs.slice(0, 3));
		expect(sections.map((s) => s.name)).toEqual(["Spacing", "Look"]);
	});
});

// ──────────────────────────────── enum options ───────────────────────────────

describe("where an enum's candidates come from", () => {
	it("uses the declared options when there are some", () => {
		expect(
			optionsFor(
				knob({
					editor: { kind: "enum", options: ["quiet", "loud"] },
					literalValues: ["quiet", "loud", "warning"],
				}),
			),
		).toEqual(["quiet", "loud"]);
	});

	it("falls back to the type's literal values when the tag named none", () => {
		expect(
			optionsFor(knob({ editor: { kind: "enum" }, literalValues: ["a", "b"] })),
		).toEqual(["a", "b"]);
	});

	it("offers no candidates for a control that is not a choice", () => {
		expect(optionsFor(knob({ editor: { kind: "range" }, literalValues: ["a"] }))).toEqual([]);
	});
});

// ─────────────────────────── value -> attribute syntax ───────────────────────

describe("how a turned knob is written into the tag", () => {
	it("writes a number as an expression, so gap={20} and not gap=\"20\"", () => {
		expect(writeFor(knob({ editor: { kind: "range" } }), 20)).toEqual({
			as: "expression",
			value: 20,
		});
		expect(writeFor(knob({ editor: { kind: "int" } }), "7")).toEqual({
			as: "expression",
			value: 7,
		});
	});

	it("writes a boolean as an expression", () => {
		expect(writeFor(knob({ editor: { kind: "boolean" } }), true)).toEqual({
			as: "expression",
			value: true,
		});
		expect(writeFor(knob({ editor: { kind: "boolean" } }), false)).toEqual({
			as: "expression",
			value: false,
		});
	});

	it("writes a choice as a quoted string, because tone={quiet} is not what it means", () => {
		expect(
			writeFor(knob({ editor: { kind: "enum" }, literalValues: ["quiet", "loud"] }), "loud"),
		).toEqual({ as: "string", value: "loud" });
	});

	it("refuses a choice the type does not allow", () => {
		expect(
			writeFor(knob({ editor: { kind: "enum" }, literalValues: ["quiet", "loud"] }), "purple"),
		).toBeNull();
	});

	it("writes a colour as a quoted hex string, and refuses anything else", () => {
		expect(writeFor(knob({ editor: { kind: "color" } }), "#3a3a3a")).toEqual({
			as: "string",
			value: "#3a3a3a",
		});
		expect(writeFor(knob({ editor: { kind: "color" } }), "rebeccapurple")).toBeNull();
	});

	it("refuses a number that is not one", () => {
		expect(writeFor(knob({ editor: { kind: "range" } }), "")).toBeNull();
		expect(writeFor(knob({ editor: { kind: "range" } }), "8px")).toBeNull();
	});
});

// ──────────────────────────── can this knob be turned ────────────────────────

describe("reading the trial write's answer", () => {
	it("counts the editor's refusal of our own probe value as a yes", () => {
		// The probe is a value the editor always refuses at the LAST gate. Getting
		// that refusal means the location, the tag, the literal check and the
		// spread check all passed — everything except the value we never meant to
		// write.
		expect(
			classifyProbe(409, { ok: false, problem: "unsafe-value", error: "refusing to write ..." }),
		).toEqual({ writable: true, note: null });
	});

	it("counts a plain 200 as a yes", () => {
		expect(classifyProbe(200, { ok: true }).writable).toBe(true);
	});

	it("says no, in the editor's own words, when the prop holds an expression", () => {
		const reason =
			"<BrowseRow> at line 116 has product={...} holding an identifier. Overwriting that would throw away code that is not a plain literal.";
		expect(classifyProbe(409, { ok: false, problem: "dynamic-prop", error: reason })).toEqual({
			writable: false,
			note: reason,
		});
	});

	it("says no when a spread may be supplying the prop", () => {
		const reason = "<Tile> at line 49 has {...spread} on the tag, so gap may come from that spread";
		expect(classifyProbe(409, { ok: false, problem: "spread-shadow", error: reason })).toEqual({
			writable: false,
			note: reason,
		});
	});

	it("says no when the dev server refused the request outright", () => {
		const out = classifyProbe(403, { ok: false, error: "forbidden" });
		expect(out.writable).toBe(false);
		expect(out.note).toBe("forbidden");
	});

	it("says no, with something readable, when the answer carried no words", () => {
		const out = classifyProbe(500, {});
		expect(out.writable).toBe(false);
		expect(out.note).toContain("500");
	});
});

/**
 * The probe, run against the editor it is a question to.
 *
 * This is the one that matters. `classifyProbe` above is a mapping table and
 * would agree with itself no matter what the server does; these run the REAL
 * `editProp` from packages/her and assert two things at once: that the answer
 * separates writable from not, and that asking never writes a byte.
 */
describe("asking the real editor whether a prop can be turned", () => {
	const SRC = [
		"export default function Screen() {",
		"  return (",
		"    <div>",
		"      <Tile gap={16} tone=\"quiet\" accent='#1c1c1c' />",
		"      <BrowseRow product={product} />",
		"      <Spread {...rest} gap={4} />",
		"      <Shadowed tone=\"quiet\" {...rest} />",
		"    </div>",
		"  );",
		"}",
		"",
	].join("\n");

	function ask(line: number, column: number, tag: string, prop: string) {
		return editProp(SRC, { line, column, tag, prop, value: PROBE_VALUE });
	}

	it("answers yes for a numeric literal, and does not write", () => {
		const out = ask(4, 7, "Tile", "gap");
		expect(out.ok).toBe(false);
		expect(out.ok === false && out.problem).toBe("unsafe-value");
		expect(classifyProbe(409, { problem: "unsafe-value" }).writable).toBe(true);
	});

	it("answers yes for a double-quoted string, and does not write", () => {
		const out = ask(4, 7, "Tile", "tone");
		expect(out.ok === false && out.problem).toBe("unsafe-value");
	});

	it("answers yes for a SINGLE-quoted string, and still does not write", () => {
		// The trap: a probe value containing only `"` slips past the quote check
		// when the attribute is written with `'`, and the editor happily rewrites
		// the file. The probe has to carry both quote characters.
		const out = ask(4, 7, "Tile", "accent");
		expect(out.ok === false && out.problem).toBe("unsafe-value");
		expect(out.ok === true && out.source).not.toBe(true);
	});

	it("answers yes for a prop the tag does not carry yet, and does not add it", () => {
		// A probe made of the CURRENT value would insert `ticks={5}` here — a
		// file changed by looking at it.
		const out = ask(4, 7, "Tile", "ticks");
		expect(out.ok === false && out.problem).toBe("unsafe-value");
	});

	it("answers no for a prop holding an expression", () => {
		const out = ask(5, 7, "BrowseRow", "product");
		expect(out.ok === false && out.problem).toBe("dynamic-prop");
		expect(classifyProbe(409, { problem: "dynamic-prop", error: "x" }).writable).toBe(false);
	});

	it("answers no when the prop sits in front of a spread that may overwrite it", () => {
		// `tone` is written before {...rest}, so the spread decides what renders.
		// A knob here would move a value nobody sees.
		const out = ask(7, 7, "Shadowed", "tone");
		expect(out.ok === false && out.problem).toBe("spread-shadow");
	});

	it("answers yes for a prop written after a spread, which does win", () => {
		// The other side: a spread on the tag is not by itself a refusal, and a
		// panel that treated it as one would grey out a knob that works.
		const out = ask(6, 7, "Spread", "tone");
		expect(out.ok === false && out.problem).toBe("unsafe-value");
	});

	it("answers no when the location does not name that tag", () => {
		const out = ask(5, 7, "Tile", "gap");
		expect(out.ok).toBe(false);
	});

	it("the same tag really is writable — a real write changes it", () => {
		// The control that stops every "unsafe-value" above from being an
		// unreachable tag or a broken fixture: with a legal value, this tag's gap
		// does change, and to exactly what was asked for.
		const out = editProp(SRC, {
			line: 4,
			column: 7,
			tag: "Tile",
			prop: "gap",
			value: { as: "expression", value: 20 },
		});
		expect(out.ok).toBe(true);
		expect(out.ok === true && out.changed).toBe(true);
		expect(out.ok === true && out.after).toBe("gap={20}");
		expect(out.ok === true && out.source.includes("gap={20}")).toBe(true);
	});
});

// ───────────────────────── which call site is this element ───────────────────

describe("which instance the selected element belongs to", () => {
	function at(screenId: string, line: number): ComponentInstance {
		return {
			screenId,
			file: "packages/design-lab/src/screens/playground/screen.tsx",
			line,
			column: 11,
			tag: "Tile",
		};
	}

	it("takes the one call site on this screen", () => {
		expect(pickInstance([at("playground", 49), at("mosaic", 12)], "playground")).toEqual({
			kind: "one",
			instance: at("playground", 49),
		});
	});

	it("does not guess when the screen has more than one call site", () => {
		// Picking the first would put the panel's controls on a tag he is not
		// looking at, and the write would land there. Refusing is the honest end.
		expect(pickInstance([at("playground", 49), at("playground", 61)], "playground")).toEqual({
			kind: "many",
			count: 2,
		});
	});

	it("has nothing when the component is rendered on another screen only", () => {
		expect(pickInstance([at("mosaic", 12)], "playground")).toEqual({ kind: "none" });
	});

	it("has nothing when the selection is not inside a screen", () => {
		expect(pickInstance([at("playground", 49)], null)).toEqual({ kind: "none" });
	});
});

// ─────────────────────────── the values now on screen ────────────────────────

describe("reading what the component was actually given", () => {
	function fiber(name: string | null, props: unknown, parent?: PropsFiber): PropsFiber {
		const type =
			name === null ? "div" : Object.defineProperty(() => null, "name", { value: name });
		return { type, memoizedProps: props, return: parent ?? null };
	}

	it("climbs past the host nodes to the component that owns them", () => {
		const tile = fiber("Tile", { gap: 16, tone: "quiet" });
		const inner = fiber(null, { className: "tl-body" }, tile);
		const leaf = fiber(null, { className: "tl-tick" }, inner);
		expect(propsOfComponent(leaf, "Tile")).toEqual({ gap: 16, tone: "quiet" });
	});

	it("stops at the nearest one when a component contains itself", () => {
		const outer = fiber("Tile", { gap: 48 });
		const inner = fiber("Tile", { gap: 4 }, outer);
		const leaf = fiber(null, {}, inner);
		expect(propsOfComponent(leaf, "Tile")).toEqual({ gap: 4 });
	});

	it("has no answer when that component is not above this element", () => {
		const leaf = fiber(null, {}, fiber("Browse", {}));
		expect(propsOfComponent(leaf, "Tile")).toBeNull();
		expect(propsOfComponent(null, "Tile")).toBeNull();
	});

	it("does not spin forever on a chain that loops", () => {
		const a: PropsFiber = { type: "div", memoizedProps: {} };
		a.return = a;
		expect(propsOfComponent(a, "Tile")).toBeNull();
	});

	it("names a forwardRef's inner render function", () => {
		const inner = Object.defineProperty(() => null, "name", { value: "Tile" });
		expect(fiberComponentName({ render: inner })).toBe("Tile");
		expect(fiberComponentName({ displayName: "Tile" })).toBe("Tile");
		expect(fiberComponentName("div")).toBeNull();
	});
});

// ───────────────────────────── did the turn land ─────────────────────────────

describe("has the new value reached the screen", () => {
	it("accepts the render that carries the value we wrote", () => {
		expect(knobLanded({ gap: 20 }, "gap", 20)).toBe(true);
		expect(knobLanded({ tone: "loud" }, "tone", "loud")).toBe(true);
	});

	it("refuses the render that is still showing the old value", () => {
		// The old node stands at the same place until vite catches up. Position
		// cannot tell them apart; the value can.
		expect(knobLanded({ gap: 16 }, "gap", 20)).toBe(false);
		expect(knobLanded(null, "gap", 20)).toBe(false);
		expect(knobLanded({}, "gap", 20)).toBe(false);
	});
});

// ──────────────────────────── what the control shows ─────────────────────────

describe("the value a control starts at", () => {
	it("shows the value the component was given", () => {
		expect(displayValue(knob({ editor: { kind: "range", min: 0, max: 48 } }), 24)).toBe(24);
		expect(displayValue(knob({ editor: { kind: "boolean" } }), true)).toBe(true);
		expect(
			displayValue(knob({ editor: { kind: "enum" }, literalValues: ["quiet", "loud"] }), "loud"),
		).toBe("loud");
		expect(displayValue(knob({ editor: { kind: "color" } }), "#3a3a3a")).toBe("#3a3a3a");
	});

	it("falls back to something legal when the prop was left off the tag", () => {
		// Destructuring defaults never reach memoizedProps, so undefined is normal
		// and must not become an empty slider or a blank select.
		expect(displayValue(knob({ editor: { kind: "range", min: 8, max: 48 } }), undefined)).toBe(8);
		expect(displayValue(knob({ editor: { kind: "int" } }), undefined)).toBe(0);
		expect(displayValue(knob({ editor: { kind: "boolean" } }), undefined)).toBe(false);
		expect(
			displayValue(knob({ editor: { kind: "enum" }, literalValues: ["quiet", "loud"] }), undefined),
		).toBe("quiet");
		expect(displayValue(knob({ editor: { kind: "color" } }), "var(--ink)")).toBe("#000000");
	});
});
