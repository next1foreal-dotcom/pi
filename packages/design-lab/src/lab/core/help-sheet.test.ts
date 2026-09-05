// @vitest-environment jsdom
// (lab-view reaches window at module scope; this suite is pure data vs a
// pure function, jsdom is only here so the import resolves.)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELP } from "./lab-view";
import {
	type DispatchContext,
	dispatchLabKey,
	type KeyInput,
} from "./keyboard-dispatch";

/** Chips that name a modifier. */
const MODIFIERS: Record<string, keyof KeyInput> = {
	Ctrl: "ctrlKey",
	Shift: "shiftKey",
	Alt: "altKey",
};

/** Chips that name a key, as the browser would report it. */
const KEYS: Record<string, { key: string; code: string }> = {
	"0": { key: "0", code: "Digit0" },
	"1": { key: "1", code: "Digit1" },
	"2": { key: "2", code: "Digit2" },
	C: { key: "c", code: "KeyC" },
	D: { key: "d", code: "KeyD" },
	F: { key: "f", code: "KeyF" },
	Y: { key: "y", code: "KeyY" },
	Z: { key: "z", code: "KeyZ" },
	Enter: { key: "Enter", code: "Enter" },
	Esc: { key: "Escape", code: "Escape" },
	Tab: { key: "Tab", code: "Tab" },
	Delete: { key: "Delete", code: "Delete" },
	"\u232B": { key: "Backspace", code: "Backspace" },
	"+": { key: "+", code: "Equal" },
	"\u2212": { key: "-", code: "Minus" },
};

/** Rows about the mouse, or about a tool the lab does not own. */
const NOT_THE_LAB_DISPATCHER = /^(Drag|Click|Scroll|drag|scroll|hover|Double-click|Drag edge|Double-click name)$/;

const ctx: DispatchContext = {
	mode: "explore",
	selectedId: "a",
	focusedId: null,
	hasScreens: true,
	isTypingTarget: false,
};

function toInput(chips: string[]): KeyInput | null {
	const input: KeyInput = {
		key: "",
		code: "",
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
	};
	let named = false;
	for (const chip of chips) {
		if (NOT_THE_LAB_DISPATCHER.test(chip)) return null;
		const mod = MODIFIERS[chip];
		if (mod) {
			(input[mod] as boolean) = true;
			continue;
		}
		const k = KEYS[chip];
		if (!k) return null; // arrows and other multi-key chips
		input.key = k.key;
		input.code = k.code;
		named = true;
	}
	return named ? input : null;
}

describe("the shortcut sheet does not lie", () => {
	// Rows in the Tools section belong to the plugins, not to this dispatcher.
	const labRows = HELP.filter((g) => g.title !== "Tools").flatMap((g) => g.rows);

	it("covers a real slice of the sheet, not zero rows", () => {
		const testable = labRows.filter(([keys]) => toInput(keys) !== null);
		expect(testable.length).toBeGreaterThanOrEqual(14);
	});

	for (const [keys, what] of HELP.filter((g) => g.title !== "Tools").flatMap(
		(g) => g.rows,
	)) {
		const input = toInput(keys);
		if (!input) continue;
		it(`${keys.join("+")} — ${what}`, () => {
			expect(dispatchLabKey(input, ctx)).not.toBeNull();
		});
	}

	it("every row has both a key and a description", () => {
		for (const group of HELP) {
			for (const [keys, what] of group.rows) {
				expect(keys.length).toBeGreaterThan(0);
				expect(what.length).toBeGreaterThan(0);
			}
		}
	});

	it("names each tool shortcut exactly once", () => {
		const tools = HELP.find((g) => g.title === "Tools");
		const combos = tools?.rows.map(([k]) => k.join("+")) ?? [];
		expect(new Set(combos).size).toBe(combos.length);
		expect(combos).toContain("Shift+R");
	});
});

describe("every row in the sheet is distinguishable from its neighbours", () => {
	// A duplicate React key is a console error in production, and the sheet had
	// one: inside "Canvas", Drag and Scroll both read "Pan". Keying on the
	// description alone collided. The invariant the render depends on is that
	// keys+description is unique within a group — assert that, not the string
	// the component happens to build.
	it("no two rows in one group share both their keys and their description", () => {
		for (const group of HELP) {
			const seen = new Set<string>();
			for (const [keys, what] of group.rows) {
				const id = `${keys.join("+")} ${what}`;
				expect(seen.has(id), `${group.title}: duplicate row "${id}"`).toBe(false);
				seen.add(id);
			}
		}
	});

	it("and the renderer keys on both halves, not the description alone", () => {
		const view = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "lab-view.tsx"), "utf8");
		const row =
			view.split(/\r?\n/).find((l) => l.includes("styles.helpRow")) ?? "";
		expect(row, "no helpRow line in lab-view").toContain("key=");
		// Both halves. Keyed on the description alone, two rows that read the
		// same collide even when their keys differ.
		expect(row).toContain("keys.join");
		expect(row).toContain("what");
	});
});
