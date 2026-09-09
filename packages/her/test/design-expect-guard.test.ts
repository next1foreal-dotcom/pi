import assert from "node:assert/strict";
import test from "node:test";
import { editProp } from "../src/preview/jsx-attr.ts";
import { editClassList } from "../src/preview/jsx-class-list.ts";
import { editText } from "../src/preview/jsx-text.ts";

/**
 * 1-based line/column of the `<` that opens `needle` — the same convention
 * the three editors and the inspect plugin use.
 */
function locate(source: string, needle: string): { line: number; column: number } {
	const index = source.indexOf(needle);
	assert.ok(index >= 0, `the fixture has no ${needle}`);
	const before = source.slice(0, index);
	return { line: before.split("\n").length, column: index - before.lastIndexOf("\n") };
}

function at(source: string, needle: string, tag: string) {
	return { ...locate(source, needle), tag };
}

// --- classes: refuse / matching expect writes --------------------------------

test("classes: a mismatched expect is refused and the returned source is the input, byte for byte", () => {
	const source = `<button className="btn">Buy</button>`;
	const result = editClassList(source, { ...at(source, "<button", "button"), add: ["p-4"], expect: "ghost" });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "stale-value");
	assert.equal(result.source, source);
	assert.match(result.reason, /className "btn"/);
	assert.match(result.reason, /"ghost"/);
	assert.match(result.reason, /line 1 column 1/);
	assert.match(result.reason, /read the element again/);
});

test("classes: the same write with an expect that matches the current value text writes", () => {
	const source = `<button className="btn">Buy</button>`;
	const result = editClassList(source, { ...at(source, "<button", "button"), add: ["p-4"], expect: "btn" });

	assert.equal(result.ok, true);
	assert.equal(result.changed, true);
	assert.equal(result.before, "btn");
	assert.equal(result.after, "btn p-4");
	assert.equal(result.source, `<button className="btn p-4">Buy</button>`);
});

test("classes: the after of one write is accepted as the next expect", () => {
	const source = `<button className="btn">Buy</button>`;
	const first = editClassList(source, { ...at(source, "<button", "button"), add: ["p-4"] });
	assert.equal(first.ok, true);
	const second = editClassList(first.source, {
		...at(first.source, "<button", "button"),
		add: ["mt-2"],
		expect: first.after,
	});

	assert.equal(second.ok, true);
	assert.equal(second.after, "btn p-4 mt-2");
	assert.equal(second.source, `<button className="btn p-4 mt-2">Buy</button>`);
});

test("classes: omitting expect still adds className to a tag that has none", () => {
	const source = `<hr />`;
	const result = editClassList(source, { ...at(source, "<hr", "hr"), add: ["x"] });

	assert.equal(result.ok, true);
	assert.equal(result.before, "");
	assert.equal(result.after, "x");
	assert.equal(result.source, `<hr className="x" />`);
});

test("classes: a missing className accepts expect null and writes", () => {
	const source = `<hr />`;
	const result = editClassList(source, { ...at(source, "<hr", "hr"), add: ["x"], expect: null });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<hr className="x" />`);
});

test("classes: a missing className refuses expect empty string, and the returned source is the input", () => {
	const source = `<hr />`;
	const result = editClassList(source, { ...at(source, "<hr", "hr"), add: ["x"], expect: "" });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "stale-value");
	assert.equal(result.source, source);
	assert.match(result.reason, /no className/);
});

test("classes: an existing empty className accepts expect empty string and writes", () => {
	const source = `<button className="">Buy</button>`;
	const result = editClassList(source, { ...at(source, "<button", "button"), add: ["x"], expect: "" });

	assert.equal(result.ok, true);
	assert.equal(result.before, "");
	assert.equal(result.after, "x");
	assert.equal(result.source, `<button className="x">Buy</button>`);
});

test("classes: an existing empty className refuses expect null, and the returned source is the input", () => {
	const source = `<button className="">Buy</button>`;
	const result = editClassList(source, { ...at(source, "<button", "button"), add: ["x"], expect: null });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "stale-value");
	assert.equal(result.source, source);
	assert.match(result.reason, /className ""/);
	assert.match(result.reason, /no className/);
});

// --- text: refuse / matching expect writes -----------------------------------

test("text: a mismatched expect is refused and the returned source is the input, byte for byte", () => {
	const source = `<button>Buy</button>`;
	const result = editText(source, { ...at(source, "<button>", "button"), text: "Purchase", expect: "Sell" });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "stale-value");
	assert.equal(result.source, source);
	assert.match(result.reason, /"Buy"/);
	assert.match(result.reason, /"Sell"/);
	assert.match(result.reason, /line 1 column 1/);
	assert.match(result.reason, /read the element again/);
});

test("text: the same write with an expect that matches the current copy writes", () => {
	const source = `<button>Buy</button>`;
	const result = editText(source, { ...at(source, "<button>", "button"), text: "Purchase", expect: "Buy" });

	assert.equal(result.ok, true);
	assert.equal(result.before, "Buy");
	assert.equal(result.after, "Purchase");
	assert.equal(result.source, `<button>Purchase</button>`);
});

test("text: the after of one write is accepted as the next expect", () => {
	const source = `<button>Buy</button>`;
	const first = editText(source, { ...at(source, "<button>", "button"), text: "Purchase" });
	assert.equal(first.ok, true);
	const second = editText(first.source, {
		...at(first.source, "<button>", "button"),
		text: "Get",
		expect: first.after,
	});

	assert.equal(second.ok, true);
	assert.equal(second.after, "Get");
	assert.equal(second.source, `<button>Get</button>`);
});

test("text: omitting expect still replaces non-empty copy", () => {
	const source = `<p>Hello</p>`;
	const result = editText(source, { ...at(source, "<p>", "p"), text: "Hi" });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<p>Hi</p>`);
});

test("text: empty children accept expect empty string and write", () => {
	const source = `<p></p>`;
	const result = editText(source, { ...at(source, "<p>", "p"), text: "Hi", expect: "" });

	assert.equal(result.ok, true);
	assert.equal(result.before, "");
	assert.equal(result.after, "Hi");
	assert.equal(result.source, `<p>Hi</p>`);
});

test("text: empty children refuse expect null, and the returned source is the input", () => {
	const source = `<p></p>`;
	const result = editText(source, { ...at(source, "<p>", "p"), text: "Hi", expect: null });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "stale-value");
	assert.equal(result.source, source);
});

test("text: non-empty copy refuses expect null, and the returned source is the input", () => {
	const source = `<p>Hello</p>`;
	const result = editText(source, { ...at(source, "<p>", "p"), text: "Hi", expect: null });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "stale-value");
	assert.equal(result.source, source);
});

// --- prop: refuse / matching expect writes -----------------------------------

test("prop: a mismatched expect is refused and the returned source is the input, byte for byte", () => {
	const source = `<Stack gap={4} />`;
	const result = editProp(source, {
		...at(source, "<Stack", "Stack"),
		prop: "gap",
		value: { as: "expression", value: 8 },
		expect: "gap={8}",
	});

	assert.equal(result.ok, false);
	assert.equal(result.problem, "stale-value");
	assert.equal(result.source, source);
	assert.match(result.reason, /gap=\{4\}/);
	assert.match(result.reason, /gap=\{8\}/);
	assert.match(result.reason, /line 1 column 1/);
	assert.match(result.reason, /read the element again/);
});

test("prop: the same write with an expect that matches the current attribute source writes", () => {
	const source = `<Stack gap={4} />`;
	const result = editProp(source, {
		...at(source, "<Stack", "Stack"),
		prop: "gap",
		value: { as: "expression", value: 8 },
		expect: "gap={4}",
	});

	assert.equal(result.ok, true);
	assert.equal(result.before, "gap={4}");
	assert.equal(result.after, "gap={8}");
	assert.equal(result.source, `<Stack gap={8} />`);
});

test("prop: the after of one write is accepted as the next expect", () => {
	const source = `<Stack gap={4} />`;
	const first = editProp(source, {
		...at(source, "<Stack", "Stack"),
		prop: "gap",
		value: { as: "expression", value: 8 },
	});
	assert.equal(first.ok, true);
	const second = editProp(first.source, {
		...at(first.source, "<Stack", "Stack"),
		prop: "gap",
		value: { as: "expression", value: 16 },
		expect: first.after,
	});

	assert.equal(second.ok, true);
	assert.equal(second.after, "gap={16}");
	assert.equal(second.source, `<Stack gap={16} />`);
});

test("prop: omitting expect still inserts a missing attribute", () => {
	const source = `<Stack />`;
	const result = editProp(source, {
		...at(source, "<Stack", "Stack"),
		prop: "gap",
		value: { as: "expression", value: 8 },
	});

	assert.equal(result.ok, true);
	assert.equal(result.before, "");
	assert.equal(result.after, "gap={8}");
	assert.equal(result.source, `<Stack gap={8} />`);
});

test("prop: a missing attribute accepts expect null and writes", () => {
	const source = `<Stack />`;
	const result = editProp(source, {
		...at(source, "<Stack", "Stack"),
		prop: "gap",
		value: { as: "expression", value: 8 },
		expect: null,
	});

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack gap={8} />`);
});

test("prop: a missing attribute refuses expect empty string, and the returned source is the input", () => {
	const source = `<Stack />`;
	const result = editProp(source, {
		...at(source, "<Stack", "Stack"),
		prop: "gap",
		value: { as: "expression", value: 8 },
		expect: "",
	});

	assert.equal(result.ok, false);
	assert.equal(result.problem, "stale-value");
	assert.equal(result.source, source);
	assert.match(result.reason, /no gap/);
});

test("prop: an existing attribute refuses expect null, and the returned source is the input", () => {
	const source = `<Stack gap={4} />`;
	const result = editProp(source, {
		...at(source, "<Stack", "Stack"),
		prop: "gap",
		value: { as: "expression", value: 8 },
		expect: null,
	});

	assert.equal(result.ok, false);
	assert.equal(result.problem, "stale-value");
	assert.equal(result.source, source);
	assert.match(result.reason, /gap=\{4\}/);
	assert.match(result.reason, /no gap/);
});
