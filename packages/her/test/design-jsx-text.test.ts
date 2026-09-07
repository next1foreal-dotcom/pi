import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EDITABLE_SOURCE, editText } from "../src/preview/jsx-text.ts";

/**
 * 1-based line/column of the `<` that opens `needle` — the same convention
 * jsx-class-list and the inspect plugin use.
 */
function locate(source: string, needle: string): { line: number; column: number } {
	const index = source.indexOf(needle);
	assert.ok(index >= 0, `the fixture has no ${needle}`);
	const before = source.slice(0, index);
	return { line: before.split("\n").length, column: index - before.lastIndexOf("\n") };
}

function edit(source: string, needle: string, tag: string, text: string) {
	return editText(source, { ...locate(source, needle), tag, text });
}

test("jsx-text.ts imports nothing", async () => {
	const src = await readFile(new URL("../src/preview/jsx-text.ts", import.meta.url), "utf8");
	assert.equal(/^\s*import\b/m.test(src), false, "an import would drag pi/typebox/playwright into the vite plugin");
});

test("EDITABLE_SOURCE is the same gate as the class-list editor", () => {
	assert.equal(EDITABLE_SOURCE.test("screen.tsx"), true);
	assert.equal(EDITABLE_SOURCE.test("icon.jsx"), true);
	assert.equal(EDITABLE_SOURCE.test("note.ts"), false);
	assert.equal(EDITABLE_SOURCE.test("readme.md"), false);
});

// --- success: a single static text child ------------------------------------

test("a static text child is replaced, and only that element changes", () => {
	const source = [
		`export function Probe() {`,
		`\treturn (`,
		`\t\t<div>`,
		`\t\t\t<button type="button">Buy</button>`,
		`\t\t\t<button type="button">Buy</button>`,
		`\t\t</div>`,
		`\t);`,
		`}`,
		``,
	].join("\n");
	const first = `<button type="button">Buy</button>`;
	const result = edit(source, first, "button", "Purchase");

	assert.equal(result.ok, true);
	assert.equal(result.changed, true);
	assert.equal(result.before, "Buy");
	assert.equal(result.after, "Purchase");
	assert.equal(result.source, source.replace(first, `<button type="button">Purchase</button>`));
	assert.ok(result.source.includes(`\t\t\t<button type="button">Buy</button>`), "the twin button was rewritten too");
});

test("surrounding whitespace and indent stay byte-identical", () => {
	const source = `<button>\n\t\t\tHello\n\t\t</button>`;
	const result = edit(source, "<button>", "button", "Hi");

	assert.equal(result.ok, true);
	assert.equal(result.before, "Hello");
	assert.equal(result.after, "Hi");
	assert.equal(result.source, `<button>\n\t\t\tHi\n\t\t</button>`);
});

test("a phrase with internal spaces is one static child and is replaced whole", () => {
	const source = `<p>Hello world</p>`;
	const result = edit(source, "<p>", "p", "Hi");

	assert.equal(result.ok, true);
	assert.equal(result.before, "Hello world");
	assert.equal(result.source, `<p>Hi</p>`);
});

test("clearing the copy keeps the surrounding whitespace", () => {
	const source = `<h1>\n\tTitle\n</h1>`;
	const result = edit(source, "<h1>", "h1", "");

	assert.equal(result.ok, true);
	assert.equal(result.before, "Title");
	assert.equal(result.after, "");
	assert.equal(result.source, `<h1>\n\t\n</h1>`);
});

test("the same text as already there does not rewrite the file", () => {
	const source = `<button>\n\t\t\tHello\n\t\t</button>`;
	const result = edit(source, "<button>", "button", "Hello");

	assert.equal(result.ok, true);
	assert.equal(result.changed, false);
	assert.equal(result.before, "Hello");
	assert.equal(result.after, "Hello");
	assert.equal(result.source, source);
});

test("a tag with attributes still has its text child replaced", () => {
	const source = `<button type="button" className="btn" disabled>Go</button>`;
	const result = edit(source, "<button", "button", "Stop");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<button type="button" className="btn" disabled>Stop</button>`);
});

test("a brace in an attribute does not count as an expression child", () => {
	const source = `<button onClick={() => { setX(1); }} title={"go"}>Go</button>`;
	const result = edit(source, "<button", "button", "Stop");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<button onClick={() => { setX(1); }} title={"go"}>Stop</button>`);
});

test("a greater-than inside an attribute value is not the end of the tag", () => {
	const source = `<div data-tip="a>b">Hello</div>`;
	const result = edit(source, "<div", "div", "Hi");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<div data-tip="a>b">Hi</div>`);
});

test("a dotted member tag's text child is editable", () => {
	const source = `<Foo.Title>Hello</Foo.Title>`;
	const result = edit(source, "<Foo.Title>", "Foo.Title", "Hi");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Foo.Title>Hi</Foo.Title>`);
});

test("empty children accept new text", () => {
	const source = `<hr></hr>`;
	const result = edit(source, "<hr>", "hr", "x");

	assert.equal(result.ok, true);
	assert.equal(result.before, "");
	assert.equal(result.after, "x");
	assert.equal(result.source, `<hr>x</hr>`);
});

test("an existing greater-than in the copy can be replaced with safe text", () => {
	const source = `<span>5 > 3</span>`;
	const result = edit(source, "<span>", "span", "yes");

	assert.equal(result.ok, true);
	assert.equal(result.before, "5 > 3");
	assert.equal(result.source, `<span>yes</span>`);
});

test("a no-op on copy that already contains > does not refuse", () => {
	const source = `<span>5 > 3</span>`;
	const result = edit(source, "<span>", "span", "5 > 3");

	assert.equal(result.ok, true);
	assert.equal(result.changed, false);
	assert.equal(result.source, source);
});

// --- tag-mismatch: refuse / same shape succeeds -----------------------------

test("a location whose tag no longer matches is refused, and the source is untouched", () => {
	const source = `<div>Hello</div>`;
	const result = edit(source, "<div>", "button", "Hi");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "tag-mismatch");
	assert.match(result.reason, /is <div>, not <button>/);
	assert.match(result.reason, /design_element_at/);
});

test("the same location with the matching tag writes", () => {
	const source = `<div>Hello</div>`;
	const result = edit(source, "<div>", "div", "Hi");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<div>Hi</div>`);
});

test("a column that is not the start of a tag is refused as stale", () => {
	const source = `<button>Buy</button>`;
	const at = locate(source, "<button>");
	const result = editText(source, { line: at.line, column: at.column + 1, tag: "button", text: "Hi" });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "tag-mismatch");
	assert.match(result.reason, /not the "<" of a tag/);
});

test("the same line at the real column writes", () => {
	const source = `<button>Buy</button>`;
	const result = edit(source, "<button>", "button", "Hi");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<button>Hi</button>`);
});

test("a line the file does not have is refused", () => {
	const source = `<button>Buy</button>`;
	const result = editText(source, { line: 99, column: 1, tag: "button", text: "Hi" });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "bad-location");
	assert.match(result.reason, /no line 99/);
});

// --- self-closing: refuse / open-and-close succeeds -------------------------

test("a self-closing host tag is refused", () => {
	const source = `<div><hr /></div>`;
	const result = edit(source, "<hr />", "hr", "x");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "self-closing");
	assert.match(result.reason, /self-closing/);
	assert.match(result.reason, /no children/);
});

test("the same host tag written with a close is editable", () => {
	const source = `<div><hr></hr></div>`;
	const result = edit(source, "<hr>", "hr", "x");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<div><hr>x</hr></div>`);
});

test("a self-closing component is refused", () => {
	const source = `<Icon name="star" />`;
	const result = edit(source, "<Icon", "Icon", "star");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "self-closing");
});

test("the same component with a text child writes", () => {
	const source = `<Icon name="star">star</Icon>`;
	const result = edit(source, "<Icon", "Icon", "moon");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Icon name="star">moon</Icon>`);
});

// --- expression child: refuse / static counterpart succeeds -----------------

test("a {expression} child is refused", () => {
	const source = `<span>{label}</span>`;
	const result = edit(source, "<span>", "span", "x");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "expression-child");
	assert.match(result.reason, /\{expression\}/);
	assert.match(result.reason, /computed at render time/);
});

test("the same span with static copy writes", () => {
	const source = `<span>label</span>`;
	const result = edit(source, "<span>", "span", "x");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<span>x</span>`);
});

test("mixed static text and a {expression} is refused", () => {
	const source = `<button>Buy {count}</button>`;
	const result = edit(source, "<button>", "button", "Buy 3");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "expression-child");
});

test("the same button with only static copy writes", () => {
	const source = `<button>Buy 3</button>`;
	const result = edit(source, "<button>", "button", "Buy now");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<button>Buy now</button>`);
});

test("a JSX comment is an expression child and is refused", () => {
	const source = `<p>{/* note */}Hello</p>`;
	const result = edit(source, "<p>", "p", "Hi");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "expression-child");
});

test("the same paragraph without the comment writes", () => {
	const source = `<p>Hello</p>`;
	const result = edit(source, "<p>", "p", "Hi");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<p>Hi</p>`);
});

test("a string wrapped in braces is still an expression and is refused", () => {
	const source = `<span>{"Buy"}</span>`;
	const result = edit(source, "<span>", "span", "Hi");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "expression-child");
});

// --- nested element: refuse / flat counterpart succeeds ---------------------

test("a nested element child is refused", () => {
	const source = `<p>Hello <b>world</b></p>`;
	const result = edit(source, "<p>", "p", "Hello world");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "element-child");
	assert.match(result.reason, /nested <b>/);
	assert.match(result.reason, /delete/);
});

test("the same paragraph without nested markup writes", () => {
	const source = `<p>Hello world</p>`;
	const result = edit(source, "<p>", "p", "Hi");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<p>Hi</p>`);
});

test("a nested fragment is refused as an element child", () => {
	const source = `<div><><span>x</span></></div>`;
	const result = edit(source, "<div>", "div", "x");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "element-child");
	assert.match(result.reason, /fragment|nested/);
});

test("the same div with only static copy writes", () => {
	const source = `<div>x</div>`;
	const result = edit(source, "<div>", "div", "y");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<div>y</div>`);
});

test("a nested self-closing child is refused", () => {
	const source = `<p>line<br />break</p>`;
	const result = edit(source, "<p>", "p", "line break");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "element-child");
	assert.match(result.reason, /nested <br>/);
});

// --- unsafe new text: refuse / safe counterpart succeeds --------------------

test("new text containing { is refused rather than escaped", () => {
	const source = `<span>Hello</span>`;
	const result = edit(source, "<span>", "span", "Hello {n}");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "unsafe-text");
	assert.match(result.reason, /cannot contain/);
	assert.match(result.reason, /Escaping/);
});

test("new text containing } is refused", () => {
	const source = `<span>Hello</span>`;
	const result = edit(source, "<span>", "span", "Hello }");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "unsafe-text");
});

test("new text containing < is refused", () => {
	const source = `<span>Hello</span>`;
	const result = edit(source, "<span>", "span", "a < b");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "unsafe-text");
});

test("new text containing > is refused", () => {
	const source = `<span>Hello</span>`;
	const result = edit(source, "<span>", "span", "a > b");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "unsafe-text");
});

test("the same span with safe new copy writes", () => {
	const source = `<span>Hello</span>`;
	const result = edit(source, "<span>", "span", "Hello n");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<span>Hello n</span>`);
});

// --- unparseable: refuse / well-formed counterpart succeeds -----------------

test("an opening tag that does not parse is refused", () => {
	const source = `<div @oops>Hello</div>`;
	const result = edit(source, "<div", "div", "Hi");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "unparseable-tag");
	assert.match(result.reason, /does not parse as plain JSX/);
});

test("the same tag without the junk attribute writes", () => {
	const source = `<div>Hello</div>`;
	const result = edit(source, "<div", "div", "Hi");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<div>Hi</div>`);
});

test("a tag with no closing tag is refused", () => {
	const source = `<div>Hello`;
	const result = edit(source, "<div>", "div", "Hi");

	assert.equal(result.ok, false);
	assert.equal(result.problem, "unparseable-tag");
	assert.match(result.reason, /closing/);
});

test("the same tag once closed writes", () => {
	const source = `<div>Hello</div>`;
	const result = edit(source, "<div>", "div", "Hi");

	assert.equal(result.ok, true);
	assert.equal(result.source, `<div>Hi</div>`);
});
