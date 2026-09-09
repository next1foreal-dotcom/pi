import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PropWrite } from "../src/preview/jsx-attr.ts";
import { EDITABLE_SOURCE, editProp, parsePropWrite } from "../src/preview/jsx-attr.ts";

/**
 * 1-based line/column of the `<` that opens `needle` — the same convention
 * jsx-class-list, jsx-text, and the inspect plugin use.
 */
function locate(source: string, needle: string): { line: number; column: number } {
	const index = source.indexOf(needle);
	assert.ok(index >= 0, `the fixture has no ${needle}`);
	const before = source.slice(0, index);
	return { line: before.split("\n").length, column: index - before.lastIndexOf("\n") };
}

function edit(source: string, needle: string, tag: string, prop: string, value: PropWrite) {
	return editProp(source, { ...locate(source, needle), tag, prop, value });
}

test("jsx-attr.ts imports the class-list scanner, not a third copy and not a package", async () => {
	const src = await readFile(new URL("../src/preview/jsx-attr.ts", import.meta.url), "utf8");
	assert.match(src, /from "\.\/jsx-class-list\.ts"/);
	assert.equal(/\bfunction findOpeningTag\b/.test(src), false, "do not copy findOpeningTag");
	assert.equal(/\bfunction scanAttributes\b/.test(src), false, "do not copy scanAttributes");
	assert.equal(/from ["']node:/.test(src), false, "no node built-ins — the vite plugin loads this file");
	assert.equal(
		/^import\s+.+from\s+["'](?!\.\/jsx-class-list\.ts["'])/m.test(src),
		false,
		"the only import is the sibling scanner",
	);
});

test("EDITABLE_SOURCE is the same gate as the class-list editor", () => {
	assert.equal(EDITABLE_SOURCE.test("screen.tsx"), true);
	assert.equal(EDITABLE_SOURCE.test("icon.jsx"), true);
	assert.equal(EDITABLE_SOURCE.test("note.ts"), false);
	assert.equal(EDITABLE_SOURCE.test("readme.md"), false);
});

// --- parsePropWrite ----------------------------------------------------------

test("parsePropWrite reads the three write shapes", () => {
	assert.deepEqual(parsePropWrite({ as: "string", value: "Hello" }), {
		ok: true,
		value: { as: "string", value: "Hello" },
	});
	assert.deepEqual(parsePropWrite({ as: "expression", value: 8 }), {
		ok: true,
		value: { as: "expression", value: 8 },
	});
	assert.deepEqual(parsePropWrite({ as: "expression", value: true }), {
		ok: true,
		value: { as: "expression", value: true },
	});
	assert.deepEqual(parsePropWrite({ as: "expression", value: null }), {
		ok: true,
		value: { as: "expression", value: null },
	});
	assert.deepEqual(parsePropWrite({ as: "remove" }), { ok: true, value: { as: "remove" } });
});

test("parsePropWrite refuses a value that is not one of the three shapes", () => {
	const parsed = parsePropWrite({ as: "code", value: "foo()" });
	assert.equal(parsed.ok, false);
	assert.match(parsed.error, /string, a simple expression, or remove/);
});

test("parsePropWrite refuses an expression that is not a JSON literal", () => {
	const parsed = parsePropWrite({ as: "expression", value: { x: 1 } });
	assert.equal(parsed.ok, false);
	assert.match(parsed.error, /string, number, boolean or null/);
});

// --- success: quoted string / expression / remove ----------------------------

test('a quoted string write becomes title="Hello", and only that tag changes', () => {
	const source = [
		`export function Probe() {`,
		`\treturn (`,
		`\t\t<div>`,
		`\t\t\t<Card title="Hi" />`,
		`\t\t\t<Card title="Hi" />`,
		`\t\t</div>`,
		`\t);`,
		`}`,
		``,
	].join("\n");
	const first = `<Card title="Hi" />`;
	const result = edit(source, first, "Card", "title", { as: "string", value: "Hello" });

	assert.equal(result.ok, true);
	assert.equal(result.changed, true);
	assert.equal(result.before, `title="Hi"`);
	assert.equal(result.after, `title="Hello"`);
	assert.equal(result.source, source.replace(first, `<Card title="Hello" />`));
	assert.ok(result.source.includes(`\t\t\t<Card title="Hi" />`), "the twin card was rewritten too");
});

test("an expression write of a number becomes gap={8}", () => {
	const source = `<Stack gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.before, "gap={4}");
	assert.equal(result.after, "gap={8}");
	assert.equal(result.source, `<Stack gap={8} />`);
});

test("an expression write of a boolean becomes compact={true}", () => {
	const source = `<Stack compact={false} />`;
	const result = edit(source, "<Stack", "Stack", "compact", { as: "expression", value: true });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack compact={true} />`);
});

test('an expression write of a string becomes title={"Hello"}', () => {
	const source = `<Card title="Hi" />`;
	const result = edit(source, "<Card", "Card", "title", { as: "expression", value: "Hello" });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Card title={"Hello"} />`);
});

test("an expression write of null becomes value={null}", () => {
	const source = `<Field value={0} />`;
	const result = edit(source, "<Field", "Field", "value", { as: "expression", value: null });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Field value={null} />`);
});

test("removing a prop takes the attribute off and leaves the rest of the tag", () => {
	const source = `<Stack align="start" gap={8} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "remove" });

	assert.equal(result.ok, true);
	assert.equal(result.changed, true);
	assert.equal(result.before, "gap={8}");
	assert.equal(result.after, "");
	assert.equal(result.source, `<Stack align="start" />`);
});

test("removing a boolean attribute walks back the space in front of it", () => {
	const source = `<input disabled />`;
	const result = edit(source, "<input", "input", "disabled", { as: "remove" });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<input />`);
});

test("a missing attribute is inserted after the last existing one, with one space", () => {
	const source = `<Stack align="start" compact={true} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.changed, true);
	assert.equal(result.before, "");
	assert.equal(result.after, "gap={8}");
	assert.equal(result.source, `<Stack align="start" compact={true} gap={8} />`);
});

test("a missing attribute on a tag with none is inserted after the name, with one space", () => {
	const source = `<Stack />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack gap={8} />`);
});

test("replacing a value leaves every other byte of a multiline tag alone", () => {
	const source = `<Stack\n\talign="start"\n\tgap={4}\n\tcompact\n/>`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack\n\talign="start"\n\tgap={8}\n\tcompact\n/>`);
});

test("an existing single-quoted string keeps that quote when the value changes", () => {
	const source = `<Card title='Hi' />`;
	const result = edit(source, "<Card", "Card", "title", { as: "string", value: "Hello" });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Card title='Hello' />`);
});

test("a hyphenated attribute name is a regular prop", () => {
	const source = `<div aria-label="old">x</div>`;
	const result = edit(source, "<div", "div", "aria-label", { as: "string", value: "new" });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<div aria-label="new">x</div>`);
});

test("a dotted member tag's prop is editable", () => {
	const source = `<Foo.Bar gap={4} />`;
	const result = edit(source, "<Foo.Bar", "Foo.Bar", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Foo.Bar gap={8} />`);
});

test("spaces inside an expression value are not a reason to refuse a number", () => {
	const source = `<Stack gap={ 4 } />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack gap={8} />`);
});

// --- no-op: same value does not rewrite --------------------------------------

test("the same quoted string as already there does not rewrite the file", () => {
	const source = `<Card title="Hello" />`;
	const result = edit(source, "<Card", "Card", "title", { as: "string", value: "Hello" });

	assert.equal(result.ok, true);
	assert.equal(result.changed, false);
	assert.equal(result.source, source);
});

test("the same number as already there does not rewrite the file", () => {
	const source = `<Stack gap={8} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.changed, false);
	assert.equal(result.source, source);
});

test("writing true onto a boolean attribute that is already present is a no-op", () => {
	const source = `<Stack compact />`;
	const result = edit(source, "<Stack", "Stack", "compact", { as: "expression", value: true });

	assert.equal(result.ok, true);
	assert.equal(result.changed, false);
	assert.equal(result.source, source);
});

test("removing a prop that is not on the tag is a no-op, not a refusal", () => {
	const source = `<Stack align="start" />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "remove" });

	assert.equal(result.ok, true);
	assert.equal(result.changed, false);
	assert.equal(result.source, source);
});

test("a number written with extra spaces around it is still the same number", () => {
	const source = `<Stack gap={ 8 } />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.changed, false);
	assert.equal(result.source, source);
});

// --- tag-mismatch: refuse / same shape succeeds ------------------------------

test("a location whose tag no longer matches is refused, and the source is untouched", () => {
	const source = `<Stack gap={4} />`;
	const result = edit(source, "<Stack", "Card", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "tag-mismatch");
	assert.match(result.reason, /is <Stack>, not <Card>/);
	assert.match(result.reason, /design_element_at/);
});

test("the same location with the matching tag writes", () => {
	const source = `<Stack gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack gap={8} />`);
});

test("a column that is not the start of a tag is refused as stale", () => {
	const source = `<Stack gap={4} />`;
	const at = locate(source, "<Stack");
	const result = editProp(source, {
		line: at.line,
		column: at.column + 1,
		tag: "Stack",
		prop: "gap",
		value: { as: "expression", value: 8 },
	});

	assert.equal(result.ok, false);
	assert.equal(result.problem, "tag-mismatch");
	assert.match(result.reason, /not the "<" of a tag/);
});

test("the same line at the real column writes", () => {
	const source = `<Stack gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack gap={8} />`);
});

test("a line the file does not have is refused", () => {
	const source = `<Stack gap={4} />`;
	const result = editProp(source, {
		line: 99,
		column: 1,
		tag: "Stack",
		prop: "gap",
		value: { as: "expression", value: 8 },
	});

	assert.equal(result.ok, false);
	assert.equal(result.problem, "bad-location");
	assert.match(result.reason, /no line 99/);
});

// --- dynamic-prop: refuse / literal counterpart succeeds ---------------------

test("a variable expression is refused rather than overwritten", () => {
	const source = `<Stack gap={themeGap} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "dynamic-prop");
	assert.match(result.reason, /the variable themeGap/);
	assert.match(result.reason, /plain literal/);
});

test("the same gap written as a number is editable", () => {
	const source = `<Stack gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack gap={8} />`);
});

test("a call expression is refused", () => {
	const source = `<Stack gap={computeGap()} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "dynamic-prop");
	assert.match(result.reason, /a call to computeGap\(\.\.\.\)/);
});

test("the same stack with a numeric gap writes", () => {
	const source = `<Stack gap={8} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 16 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack gap={16} />`);
});

test("a member access is refused", () => {
	const source = `<Icon size={theme.icon} />`;
	const result = edit(source, "<Icon", "Icon", "size", { as: "expression", value: 16 });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "dynamic-prop");
	assert.match(result.reason, /the variable theme\.icon/);
});

test("the same size written as a number is editable", () => {
	const source = `<Icon size={16} />`;
	const result = edit(source, "<Icon", "Icon", "size", { as: "expression", value: 24 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Icon size={24} />`);
});

test("a template literal is refused", () => {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: JSX source under test; the placeholder is the fixture, not a missing template literal
	const source = "<Card title={`Hello ${name}`} />";
	const result = edit(source, "<Card", "Card", "title", { as: "string", value: "Hello" });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "dynamic-prop");
	assert.match(result.reason, /a template literal/);
});

test("the same title written as a quoted string is editable", () => {
	const source = `<Card title="Hello" />`;
	const result = edit(source, "<Card", "Card", "title", { as: "string", value: "Hi" });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Card title="Hi" />`);
});

test("a conditional is refused", () => {
	const source = `<Stack gap={wide ? 16 : 8} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "dynamic-prop");
	assert.match(result.reason, /a conditional/);
});

test("removing a dynamic prop is refused too — that still throws the expression away", () => {
	const source = `<Stack gap={themeGap} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "remove" });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "dynamic-prop");
});

test("true/false/null in braces are literals, not variables, and are editable", () => {
	const source = `<Stack compact={true} />`;
	const result = edit(source, "<Stack", "Stack", "compact", { as: "expression", value: false });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack compact={false} />`);
});

// --- spread-shadow: refuse / counterpart succeeds ----------------------------

test("a tag whose only attributes are a spread refuses a write that might come from it", () => {
	const source = `<Stack {...props} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "spread-shadow");
	assert.match(result.reason, /\{\.\.\.spread\}/);
	assert.match(result.reason, /gap/);
});

test("the same stack without the spread accepts the write", () => {
	const source = `<Stack />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack gap={8} />`);
});

test("an explicit prop sitting before a spread is refused — the spread would win", () => {
	const source = `<Stack gap={4} {...props} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "spread-shadow");
});

test("an explicit prop sitting after a spread is the winner and is editable", () => {
	const source = `<Stack {...props} gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack {...props} gap={8} />`);
});

test("inserting a prop that would land before a trailing spread is refused", () => {
	const source = `<Stack align="start" {...props} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "spread-shadow");
});

test("inserting a prop after the last named attr, which is after the spread, writes", () => {
	const source = `<Stack {...props} align="start" />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack {...props} align="start" gap={8} />`);
});

test("removing a prop while a spread is on the tag is refused — default is not what you would get", () => {
	const source = `<Stack {...props} gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "remove" });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "spread-shadow");
	assert.match(result.reason, /default/);
});

test("removing the same prop with no spread writes", () => {
	const source = `<Stack gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "remove" });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack />`);
});

// --- unsafe-value: refuse / safe counterpart succeeds ------------------------

test("a quoted string containing the attribute's quote is refused rather than escaped", () => {
	const source = `<Card title="Hi" />`;
	const result = edit(source, "<Card", "Card", "title", { as: "string", value: `He said "hi"` });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "unsafe-value");
	assert.match(result.reason, /cannot contain/);
	assert.match(result.reason, /Escaping/);
});

test("the same title without a quote writes", () => {
	const source = `<Card title="Hi" />`;
	const result = edit(source, "<Card", "Card", "title", { as: "string", value: "He said hi" });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Card title="He said hi" />`);
});

test("a quoted string containing the existing single quote is refused", () => {
	const source = `<Card title='Hi' />`;
	const result = edit(source, "<Card", "Card", "title", { as: "string", value: "it's" });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "unsafe-value");
});

test("the same single-quoted title with a safe value writes", () => {
	const source = `<Card title='Hi' />`;
	const result = edit(source, "<Card", "Card", "title", { as: "string", value: "Hello" });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Card title='Hello' />`);
});

test("a non-finite number is refused", () => {
	const source = `<Stack gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: Number.POSITIVE_INFINITY });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "unsafe-value");
	assert.match(result.reason, /finite/);
});

test("the same gap with a finite number writes", () => {
	const source = `<Stack gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack gap={8} />`);
});

// --- unparseable / bad-prop: refuse / counterpart succeeds -------------------

test("an opening tag that does not parse is refused", () => {
	const source = `<Stack @oops gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "unparseable-tag");
	assert.match(result.reason, /does not parse as plain JSX/);
});

test("the same tag without the junk attribute writes", () => {
	const source = `<Stack gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack gap={8} />`);
});

test("an empty prop name is refused", () => {
	const source = `<Stack gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "", { as: "expression", value: 8 });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "bad-prop");
});

test("a prop name that is not a JSX attribute name is refused", () => {
	const source = `<Stack gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap=1", { as: "expression", value: 8 });

	assert.equal(result.ok, false);
	assert.equal(result.problem, "bad-prop");
	assert.match(result.reason, /not a JSX attribute name/);
});

test("the same stack with a real prop name writes", () => {
	const source = `<Stack gap={4} />`;
	const result = edit(source, "<Stack", "Stack", "gap", { as: "expression", value: 8 });

	assert.equal(result.ok, true);
	assert.equal(result.source, `<Stack gap={8} />`);
});
