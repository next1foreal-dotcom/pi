import assert from "node:assert/strict";
import test from "node:test";
import { findOpeningTag as findClassOpeningTag, scanAttributes } from "../src/preview/jsx-class-list.ts";
import { findOpeningTag as findTextOpeningTag, scanTagTail } from "../src/preview/jsx-text.ts";

/**
 * jsx-class-list.ts and jsx-text.ts each ship their own findOpeningTag because
 * the vite plugin loads them with a zero-import constraint. This file is the
 * gate that still notices when the copies drift: the same source, the same
 * line:column:tag, the same hit-or-refuse, and when they hit, the same OpenTag
 * bytes. problem/reason strings are allowed to differ — they serve different
 * tools and their unions are not the same.
 */

interface OpenTag {
	start: number;
	nameEnd: number;
	name: string;
}

type ScanResult = OpenTag | { problem: string; reason: string };

type Fixture = {
	/** What a disagreement on this shape would let through. */
	guards: string;
	source: string;
	expectFound: boolean;
} & ({ needle: string; tag: string } | { request: { line: number; column: number; tag: string } });

/** 1-based line/column of the first character of `needle`, UTF-16 units. */
function at(source: string, needle: string, tag: string): { line: number; column: number; tag: string } {
	const index = source.indexOf(needle);
	assert.ok(index >= 0, `fixture has no ${JSON.stringify(needle)}`);
	const before = source.slice(0, index);
	return { line: before.split("\n").length, column: index - before.lastIndexOf("\n"), tag };
}

function openTag(result: ScanResult): OpenTag | null {
	if ("problem" in result) return null;
	return { start: result.start, nameEnd: result.nameEnd, name: result.name };
}

function describeHit(result: ScanResult): string {
	const hit = openTag(result);
	return hit === null ? "refuse" : `hit name=${hit.name} start=${hit.start} nameEnd=${hit.nameEnd}`;
}

const SPACE_INDENT = [
	`export function Screen() {`,
	`  return (`,
	`    <main>`,
	`      <button type="button">Go</button>`,
	`    </main>`,
	`  );`,
	`}`,
].join("\n");

const TAB_INDENT = [
	`export function Screen() {`,
	`\treturn (`,
	`\t\t<main>`,
	`\t\t\t<button type="button">Go</button>`,
	`\t\t</main>`,
	`\t);`,
	`}`,
].join("\n");

const MULTILINE_OPEN = [`<button`, `\ttype="button"`, `\tclassName="primary"`, `>`, `\tGo`, `</button>`].join("\n");

const GENERIC_NEIGHBOURS = [
	`import { useRef } from "react";`,
	`export function Screen() {`,
	`\tconst el = useRef<HTMLElement>(null);`,
	`\tconst n = foo<Bar>(0);`,
	`\treturn <section ref={el}>Hi</section>;`,
	`}`,
].join("\n");

const CRLF = [
	`export function Screen() {`,
	`\treturn (`,
	`\t\t<article>`,
	`\t\t\t<p>Hi</p>`,
	`\t\t</article>`,
	`\t);`,
	`}`,
].join("\r\n");

const BLOCK_COMMENT = [
	`export function Screen() {`,
	`\treturn (`,
	`\t\t<>`,
	`\t\t\t{/* panel */}`,
	`\t\t\t<section>Hi</section>`,
	`\t\t</>`,
	`\t);`,
	`}`,
].join("\n");

const LINE_COMMENT = [
	`export function Screen() {`,
	`\treturn (`,
	`\t\t// heading`,
	`\t\t<h1>Hi</h1>`,
	`\t);`,
	`}`,
].join("\n");

const FIXTURES: Fixture[] = [
	{
		guards: "space indent: column is a character index, not a visual column after expanding spaces",
		source: SPACE_INDENT,
		needle: `<button type="button">Go</button>`,
		tag: "button",
		expectFound: true,
	},
	{
		guards: "tab indent: a tab is one column, not 2 or 4 spaces",
		source: TAB_INDENT,
		needle: `<button type="button">Go</button>`,
		tag: "button",
		expectFound: true,
	},
	{
		guards: "newline right after the tag name: nameEnd must stop before attributes on the next line",
		source: MULTILINE_OPEN,
		needle: `<button`,
		tag: "button",
		expectFound: true,
	},
	{
		guards: "a '>' inside an attribute string (title=\"a > b\") is not the end of the tag",
		source: `<label title="a > b" data-tip="x>y">Hi</label>`,
		needle: `<label`,
		tag: "label",
		expectFound: true,
	},
	{
		guards:
			"TypeScript generics look like tags; the hit must be the JSX tag at the given line:column, not the first '<' in the file",
		source: GENERIC_NEIGHBOURS,
		needle: `<section`,
		tag: "section",
		expectFound: true,
	},
	{
		guards:
			"useRef<HTMLElement> looks like a tag at that '<' — both copies must give the same answer, not one skip and one hit",
		source: GENERIC_NEIGHBOURS,
		needle: `<HTMLElement`,
		tag: "HTMLElement",
		expectFound: true,
	},
	{
		guards: "foo<Bar>(x) looks like a tag at that '<' — both copies must give the same answer",
		source: GENERIC_NEIGHBOURS,
		needle: `<Bar>`,
		tag: "Bar",
		expectFound: true,
	},
	{
		guards: "dotted component names (Foo.Bar) are one tag name, not a stop at the dot",
		source: `<Foo.Bar variant="x">Hi</Foo.Bar>`,
		needle: `<Foo.Bar`,
		tag: "Foo.Bar",
		expectFound: true,
	},
	{
		guards: "hyphenated host tags (my-thing) keep the hyphen in the name",
		source: `<my-thing open>Hi</my-thing>`,
		needle: `<my-thing`,
		tag: "my-thing",
		expectFound: true,
	},
	{
		guards: "a self-closing tag still has an opening '<' the two copies must agree on",
		source: `<Icon size={16} />`,
		needle: `<Icon`,
		tag: "Icon",
		expectFound: true,
	},
	{
		guards:
			"tag does not match the name at that location: both copies must refuse, not one rewrite a different element",
		source: `<button type="button">Go</button>`,
		needle: `<button`,
		tag: "div",
		expectFound: false,
	},
	{
		guards: "line past the end of the file: both copies must refuse",
		source: `<div>Hi</div>\n`,
		request: { line: 40, column: 1, tag: "div" },
		expectFound: false,
	},
	{
		guards: "column past the end of the line: both copies must refuse",
		source: `<div>Hi</div>`,
		request: { line: 1, column: 80, tag: "div" },
		expectFound: false,
	},
	{
		guards: "CRLF line endings: a line starts after '\\n', and '\\r' is just another character on the line",
		source: CRLF,
		needle: `<p>`,
		tag: "p",
		expectFound: true,
	},
	{
		guards: "a {/* comment */} on the line before the tag is not the '<' we were pointed at",
		source: BLOCK_COMMENT,
		needle: `<section`,
		tag: "section",
		expectFound: true,
	},
	{
		guards: "a // comment on the previous line must not shift the column of the tag below it",
		source: LINE_COMMENT,
		needle: `<h1>`,
		tag: "h1",
		expectFound: true,
	},
	{
		guards: "non-BMP in an attribute (emoji): start/nameEnd stay UTF-16 offsets, not code points or bytes",
		source: `<button title="👋 hello">Go</button>`,
		needle: `<button`,
		tag: "button",
		expectFound: true,
	},
	{
		guards:
			"non-BMP before the tag on the same line: a surrogate pair shifts the '<' by two UTF-16 units, not one code point",
		source: `const n = "👋"; <span title="🎉">x</span>`,
		needle: `<span`,
		tag: "span",
		expectFound: true,
	},
];

test("the two findOpeningTag copies agree on every fixture", () => {
	const mismatches: string[] = [];
	for (const fixture of FIXTURES) {
		const request = "request" in fixture ? fixture.request : at(fixture.source, fixture.needle, fixture.tag);
		const classResult = findClassOpeningTag(fixture.source, request);
		const textResult = findTextOpeningTag(fixture.source, request);
		const classHit = openTag(classResult);
		const textHit = openTag(textResult);
		const where = `${fixture.guards} (line ${request.line} column ${request.column} tag=${request.tag})`;

		if ((classHit === null) !== (textHit === null)) {
			mismatches.push(
				`${where}: found/refused split — class-list ${describeHit(classResult)}; jsx-text ${describeHit(textResult)}`,
			);
			continue;
		}

		if (classHit === null || textHit === null) {
			if (fixture.expectFound) {
				mismatches.push(`${where}: both refused, but this shape is a hit`);
			}
			continue;
		}

		if (!fixture.expectFound) {
			mismatches.push(`${where}: both hit ${describeHit(classResult)}, but this shape is a refusal on both copies`);
			continue;
		}

		if (classHit.start !== textHit.start || classHit.nameEnd !== textHit.nameEnd || classHit.name !== textHit.name) {
			mismatches.push(
				`${where}: OpenTag fields differ — class-list ${describeHit(classResult)}; jsx-text ${describeHit(textResult)}`,
			);
		}
	}
	assert.equal(mismatches.length, 0, mismatches.join("\n"));
});

/**
 * Second pair: scanAttributes (class-list) vs scanTagTail.attributes (jsx-text).
 * findOpeningTag only decides "is this the tag"; these two decide which bytes
 * of className (and every other attr) get rewritten. nameEnd comes from the
 * already-pinned findOpeningTag (class-list copy) — not hardcoded — because
 * the test above already requires the two copies to give the same number.
 */

interface Attr {
	name: string;
	start: number;
	end: number;
	valueStart: number;
	valueEnd: number;
	kind: string;
	quote: string;
}

const ATTR_FIELDS = ["name", "start", "end", "valueStart", "valueEnd", "kind", "quote"] as const;

type AttrFixture = {
	/** What a disagreement on this shape would let through. */
	guards: string;
	source: string;
	needle: string;
	tag: string;
	expectNull: boolean;
};

function describeAttr(attr: Attr): string {
	return `${attr.name} start=${attr.start} end=${attr.end} valueStart=${attr.valueStart} valueEnd=${attr.valueEnd} kind=${attr.kind} quote=${JSON.stringify(attr.quote)}`;
}

function describeAttrs(attrs: Attr[] | null): string {
	if (attrs === null) return "null";
	if (attrs.length === 0) return "[]";
	return attrs.map((attr, i) => `[${i}] ${describeAttr(attr)}`).join("; ");
}

const ATTR_FIXTURES: AttrFixture[] = [
	{
		guards: "no attributes: both must return an empty list, not invent a className or refuse",
		source: `<p>Hi</p>`,
		needle: `<p>`,
		tag: "p",
		expectNull: false,
	},
	{
		guards: "one attribute: start/end/valueStart/valueEnd of that one attr must match",
		source: `<button type="button">Go</button>`,
		needle: `<button`,
		tag: "button",
		expectNull: false,
	},
	{
		guards: "several attributes: count, order, and every field of each attr",
		source: `<label title="tip" htmlFor="x" className="row">Hi</label>`,
		needle: `<label`,
		tag: "label",
		expectNull: false,
	},
	{
		guards: "boolean attribute (disabled): kind=boolean, valueStart===valueEnd===end of the name",
		source: `<input disabled>`,
		needle: `<input`,
		tag: "input",
		expectNull: false,
	},
	{
		guards: "a '>' inside an attribute string is not the end of the tag",
		source: `<a title="a > b">x</a>`,
		needle: `<a`,
		tag: "a",
		expectNull: false,
	},
	{
		guards: "a '/' inside an attribute string is not a self-closing slash",
		source: `<a href="a/b">x</a>`,
		needle: `<a`,
		tag: "a",
		expectNull: false,
	},
	{
		guards: "the other quote nested inside a quoted value",
		source: `<span title='he said "hi"'>x</span>`,
		needle: `<span`,
		tag: "span",
		expectNull: false,
	},
	{
		guards: "nested braces in an expression value: the inner '}' is not the end of the attr",
		source: `<div style={{ a: { b: 1 } }}>x</div>`,
		needle: `<div`,
		tag: "div",
		expectNull: false,
	},
	{
		guards: "a '}' inside a string inside an expression is not the closing brace",
		source: `<button onClick={() => f("}")}>x</button>`,
		needle: `<button`,
		tag: "button",
		expectNull: false,
	},
	{
		guards: "a spread owns no name; both copies must skip it the same way",
		source: `<Foo {...props} />`,
		needle: `<Foo`,
		tag: "Foo",
		expectNull: false,
	},
	{
		guards: "a spread between two named attrs: offsets of the named ones still match, spread is skipped on both",
		source: `<Foo a="1" {...props} b="2" />`,
		needle: `<Foo`,
		tag: "Foo",
		expectNull: false,
	},
	{
		guards: "hyphenated attribute names (data-pane-actions) stay one name, not a stop at the hyphen",
		source: `<div data-pane-actions="x">y</div>`,
		needle: `<div`,
		tag: "div",
		expectNull: false,
	},
	{
		guards: "colonated attribute names (xlink:href) stay one name, not a stop at the colon",
		source: `<use xlink:href="#icon" />`,
		needle: `<use`,
		tag: "use",
		expectNull: false,
	},
	{
		guards: "template-literal attribute value: both copies must treat the whole `{`...`}` as one expression",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: JSX source under test; the placeholder is the fixture, not a missing template literal
		source: "<button aria-label={`Close ${title}`}>x</button>",
		needle: `<button`,
		tag: "button",
		expectNull: false,
	},
	{
		guards: "self-closing with a space before /> — one copy must not treat the slash as an attr name",
		source: `<Foo />`,
		needle: `<Foo`,
		tag: "Foo",
		expectNull: false,
	},
	{
		guards: "self-closing with no space before /> — one copy must not eat the slash as an attr name",
		source: `<Foo/>`,
		needle: `<Foo`,
		tag: "Foo",
		expectNull: false,
	},
	{
		guards: "attributes split across lines: offsets stay UTF-16 indices, not visual columns",
		source: [`<button`, `\ttype="button"`, `\tclassName="primary"`, `>`, `\tGo`, `</button>`].join("\n"),
		needle: `<button`,
		tag: "button",
		expectNull: false,
	},
	{
		guards: "unclosed tag: both copies must return null, not one invent a closing '>' at EOF",
		source: `<div className="x"`,
		needle: `<div`,
		tag: "div",
		expectNull: true,
	},
	{
		guards: "unclosed string value: both copies must return null, not one treat EOF as the closing quote",
		source: `<div title="oops>`,
		needle: `<div`,
		tag: "div",
		expectNull: true,
	},
	{
		guards: "CRLF line endings inside a multi-line tag: '\\r' is a character, not a line start",
		source: [`<button`, `\ttype="button"`, `>`, `\tGo`, `</button>`].join("\r\n"),
		needle: `<button`,
		tag: "button",
		expectNull: false,
	},
];

test("the two attribute scanners agree on every fixture", () => {
	const mismatches: string[] = [];
	for (const fixture of ATTR_FIXTURES) {
		const request = at(fixture.source, fixture.needle, fixture.tag);
		const found = findClassOpeningTag(fixture.source, request);
		const where = `${fixture.guards} (line ${request.line} column ${request.column} tag=${request.tag} nameEnd from findOpeningTag)`;

		if ("problem" in found) {
			mismatches.push(
				`${where}: findOpeningTag refused (${found.problem}: ${found.reason}), so nameEnd is unavailable`,
			);
			continue;
		}

		const classAttrs = scanAttributes(fixture.source, found.nameEnd);
		const textTail = scanTagTail(fixture.source, found.nameEnd);
		const textAttrs = textTail === null ? null : textTail.attributes;

		if ((classAttrs === null) !== (textAttrs === null)) {
			mismatches.push(
				`${where}: null/success split — class-list ${describeAttrs(classAttrs)}; jsx-text ${describeAttrs(textAttrs)}`,
			);
			continue;
		}

		if (classAttrs === null || textAttrs === null) {
			if (!fixture.expectNull) {
				mismatches.push(`${where}: both returned null, but this shape is a successful scan`);
			}
			continue;
		}

		if (fixture.expectNull) {
			mismatches.push(
				`${where}: both returned ${describeAttrs(classAttrs)}, but this shape is a refusal on both copies`,
			);
			continue;
		}

		if (classAttrs.length !== textAttrs.length) {
			mismatches.push(
				`${where}: attribute count ${classAttrs.length} vs ${textAttrs.length} — class-list ${describeAttrs(classAttrs)}; jsx-text ${describeAttrs(textAttrs)}`,
			);
		}

		const n = Math.max(classAttrs.length, textAttrs.length);
		for (let i = 0; i < n; i += 1) {
			const a = classAttrs[i];
			const b = textAttrs[i];
			if (a === undefined) {
				mismatches.push(`${where}: attr[${i}] only on jsx-text: ${describeAttr(b)}`);
				continue;
			}
			if (b === undefined) {
				mismatches.push(`${where}: attr[${i}] only on class-list: ${describeAttr(a)}`);
				continue;
			}
			for (const field of ATTR_FIELDS) {
				if (a[field] !== b[field]) {
					mismatches.push(
						`${where}: attr[${i}].${field} class-list=${JSON.stringify(a[field])} jsx-text=${JSON.stringify(b[field])}`,
					);
				}
			}
		}
	}
	assert.equal(mismatches.length, 0, mismatches.join("\n"));
});
