import { describe, expect, it } from "vitest";
import { classesOf, editability } from "./plugin";

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
