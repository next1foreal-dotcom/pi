/**
 * Editing the text child of one JSX element, as a pure function of the file's text.
 *
 * Pair of jsx-class-list.ts: that file rewrites a className, this one rewrites
 * the single static text child. Same consumers (her tool, the lab properties
 * panel via the dev server), same constraint: nothing in this file imports
 * anything, because the vite plugin loads it without pulling in pi, typebox,
 * or playwright.
 *
 * findOpeningTag and the attribute scanner are copied from jsx-class-list.ts
 * rather than imported. An import would still be an import — the zero-import
 * rule does not make an exception for a sibling — and the duplication is the
 * cost of that rule.
 */

/** JSX tag names: host tags, dotted members (`Foo.Bar`), namespaced, custom elements. */
const TAG_NAME_CHAR = /[A-Za-z0-9_$.:-]/;
/** An attribute name may start with a letter, `_` or `$`; `data-x` and `aria-y` continue with `-`. */
const ATTR_NAME_START = /[A-Za-z_$]/;
const ATTR_NAME_CHAR = /[A-Za-z0-9_$:.-]/;
/** Characters that would change the shape of the JSX if spliced into a text child. */
const UNSAFE_TEXT_CHAR = /[<>{}]/;
/** The only files whose JSX tags this tool will touch. */
export const EDITABLE_SOURCE = /\.[jt]sx$/;

export type TextEditProblem =
	| "bad-location"
	| "tag-mismatch"
	| "unparseable-tag"
	| "self-closing"
	| "expression-child"
	| "element-child"
	| "unsafe-text";

export interface TextEditRequest {
	line: number;
	column: number;
	tag: string;
	text: string;
}

export type TextEditResult =
	| {
			ok: true;
			source: string;
			before: string;
			after: string;
			changed: boolean;
	  }
	| { ok: false; problem: TextEditProblem; reason: string };

interface OpenTag {
	/** Offset of the `<`. */
	start: number;
	/** Offset just past the tag name. */
	nameEnd: number;
	name: string;
}

interface JsxAttribute {
	name: string;
	start: number;
	end: number;
	valueStart: number;
	valueEnd: number;
	kind: "string" | "expression" | "boolean";
	quote: string;
}

interface TagTail {
	attributes: JsxAttribute[];
	/** Offset just past the `>` that closes the opening tag. */
	end: number;
	selfClosing: boolean;
}

/** Byte offset where 1-based `line` starts, or null when the file has no such line. */
function lineStartOffset(source: string, line: number): number | null {
	if (!Number.isInteger(line) || line < 1) return null;
	let offset = 0;
	for (let n = 1; n < line; n += 1) {
		const nl = source.indexOf("\n", offset);
		if (nl === -1) return null;
		offset = nl + 1;
	}
	return offset;
}

/** Skip a quoted run starting at `start`. JSX attribute strings have no escapes; JS strings do. */
function skipQuoted(source: string, start: number, escapes: boolean): number {
	const quote = source[start];
	let i = start + 1;
	while (i < source.length) {
		const c = source[i];
		if (escapes && c === "\\") {
			i += 2;
			continue;
		}
		if (c === quote) return i + 1;
		i += 1;
	}
	return -1;
}

/** Skip a template literal, including any `${ ... }` holes and what nests inside them. */
function skipTemplate(source: string, start: number): number {
	let i = start + 1;
	while (i < source.length) {
		const c = source[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "`") return i + 1;
		if (c === "$" && source[i + 1] === "{") {
			let depth = 1;
			i += 2;
			while (i < source.length && depth > 0) {
				const d = source[i];
				if (d === "{") depth += 1;
				else if (d === "}") depth -= 1;
				else if (d === "`") {
					const next = skipTemplate(source, i);
					if (next === -1) return -1;
					i = next;
					continue;
				} else if (d === '"' || d === "'") {
					const next = skipQuoted(source, i, true);
					if (next === -1) return -1;
					i = next;
					continue;
				}
				i += 1;
			}
			continue;
		}
		i += 1;
	}
	return -1;
}

/**
 * Offset just past the `}` that closes the `{` at `start`, or -1.
 * Strings, template literals and comments inside the braces do not count.
 */
function skipBraces(source: string, start: number): number {
	let depth = 0;
	let i = start;
	while (i < source.length) {
		const c = source[i];
		if (c === '"' || c === "'") {
			const next = skipQuoted(source, i, true);
			if (next === -1) return -1;
			i = next;
			continue;
		}
		if (c === "`") {
			const next = skipTemplate(source, i);
			if (next === -1) return -1;
			i = next;
			continue;
		}
		if (c === "/" && source[i + 1] === "*") {
			const close = source.indexOf("*/", i + 2);
			if (close === -1) return -1;
			i = close + 2;
			continue;
		}
		if (c === "/" && source[i + 1] === "/") {
			const nl = source.indexOf("\n", i);
			if (nl === -1) return -1;
			i = nl + 1;
			continue;
		}
		if (c === "{") depth += 1;
		else if (c === "}") {
			depth -= 1;
			if (depth === 0) return i + 1;
			if (depth < 0) return -1;
		}
		i += 1;
	}
	return -1;
}

/**
 * The `<tag` the caller says it selected, at exactly the line and column it
 * gave. Everything about this function is the stale-location check: a location
 * that has drifted by one line names a different element, and editing that one
 * is worse than editing nothing.
 */
export function findOpeningTag(
	source: string,
	request: Pick<TextEditRequest, "line" | "column" | "tag">,
): OpenTag | { problem: TextEditProblem; reason: string } {
	const { line, column, tag } = request;
	const lineStart = lineStartOffset(source, line);
	if (lineStart === null) return { problem: "bad-location", reason: `the file has no line ${line}` };
	if (!Number.isInteger(column) || column < 1) {
		return { problem: "bad-location", reason: `column ${column} is not a position` };
	}
	const nl = source.indexOf("\n", lineStart);
	const lineEnd = nl === -1 ? source.length : nl;
	const at = lineStart + column - 1;
	if (at >= lineEnd) {
		return { problem: "bad-location", reason: `line ${line} is shorter than column ${column}` };
	}
	if (source[at] !== "<") {
		const glimpse = source.slice(at, Math.min(lineEnd, at + 24));
		return {
			problem: "tag-mismatch",
			reason: `line ${line} column ${column} is not the "<" of a tag — it reads ${JSON.stringify(glimpse)}. That location is stale; point at the element again with design_element_at.`,
		};
	}
	let i = at + 1;
	while (i < source.length && TAG_NAME_CHAR.test(source[i])) i += 1;
	const name = source.slice(at + 1, i);
	if (!name) {
		return { problem: "tag-mismatch", reason: `there is no tag name after the "<" at line ${line} column ${column}` };
	}
	if (name.toLowerCase() !== tag.trim().toLowerCase()) {
		return {
			problem: "tag-mismatch",
			reason: `the tag at line ${line} column ${column} is <${name}>, not <${tag}>. Something edited this file since you pointed at it; point again with design_element_at rather than editing a tag you did not select.`,
		};
	}
	return { start: at, nameEnd: i, name };
}

/**
 * Every attribute of the opening tag that starts at `nameEnd`, plus where that
 * tag ends and whether it was written `/>`. Null is a refusal, not a fallback.
 */
export function scanTagTail(source: string, nameEnd: number): TagTail | null {
	const out: JsxAttribute[] = [];
	let i = nameEnd;
	while (i < source.length) {
		while (i < source.length && /\s/.test(source[i])) i += 1;
		if (i >= source.length) return null;
		const c = source[i];
		if (c === ">") return { attributes: out, end: i + 1, selfClosing: false };
		if (c === "/" && source[i + 1] === ">") return { attributes: out, end: i + 2, selfClosing: true };
		if (c === "{") {
			const next = skipBraces(source, i);
			if (next === -1) return null;
			i = next;
			continue;
		}
		if (!ATTR_NAME_START.test(c)) return null;
		const nameStart = i;
		i += 1;
		while (i < source.length && ATTR_NAME_CHAR.test(source[i])) i += 1;
		const name = source.slice(nameStart, i);
		let after = i;
		while (after < source.length && /\s/.test(source[after])) after += 1;
		if (source[after] !== "=") {
			out.push({ name, start: nameStart, end: i, valueStart: i, valueEnd: i, kind: "boolean", quote: "" });
			continue;
		}
		let value = after + 1;
		while (value < source.length && /\s/.test(source[value])) value += 1;
		const opener = source[value];
		if (opener === '"' || opener === "'") {
			const next = skipQuoted(source, value, false);
			if (next === -1) return null;
			out.push({
				name,
				start: nameStart,
				end: next,
				valueStart: value + 1,
				valueEnd: next - 1,
				kind: "string",
				quote: opener,
			});
			i = next;
			continue;
		}
		if (opener === "{") {
			const next = skipBraces(source, value);
			if (next === -1) return null;
			out.push({
				name,
				start: nameStart,
				end: next,
				valueStart: value + 1,
				valueEnd: next - 1,
				kind: "expression",
				quote: "",
			});
			i = next;
			continue;
		}
		return null;
	}
	return null;
}

/**
 * Lead / body / trail of a static text child. Lead and trail are the
 * surrounding whitespace that must not move when the copy changes; body is
 * from the first non-space to the last.
 */
function splitAroundText(inner: string): { lead: string; body: string; trail: string } {
	const start = inner.search(/\S/);
	if (start === -1) return { lead: inner, body: "", trail: "" };
	let end = inner.length - 1;
	while (end >= start && /\s/.test(inner[end] ?? "")) end -= 1;
	return {
		lead: inner.slice(0, start),
		body: inner.slice(start, end + 1),
		trail: inner.slice(end + 1),
	};
}

/**
 * The inner bytes of `name` starting at `contentStart`, but only when those
 * bytes are a single static text child. Anything else is a named refusal.
 */
function readStaticTextChild(
	source: string,
	contentStart: number,
	tagName: string,
	line: number,
): { inner: string; innerStart: number } | { problem: TextEditProblem; reason: string } {
	let i = contentStart;
	while (i < source.length) {
		const c = source[i];
		if (c === "{") {
			return {
				problem: "expression-child",
				reason: `<${tagName}> at line ${line} has a {expression} in its children. That copy is computed at render time, so changing a source literal would not change what you see. Edit the expression yourself, or point at an element whose children are a single piece of static text.`,
			};
		}
		if (c === "<") {
			let j = i + 1;
			if (source[j] === "/") {
				j += 1;
				while (j < source.length && /\s/.test(source[j] ?? "")) j += 1;
				const nameStart = j;
				while (j < source.length && TAG_NAME_CHAR.test(source[j] ?? "")) j += 1;
				const closeName = source.slice(nameStart, j);
				while (j < source.length && /\s/.test(source[j] ?? "")) j += 1;
				if (source[j] !== ">") {
					return {
						problem: "unparseable-tag",
						reason: `could not find the closing </${tagName}> for the <${tagName}> at line ${line} — the element does not parse as plain JSX, so there is no text child to change safely.`,
					};
				}
				if (closeName.toLowerCase() === tagName.toLowerCase()) {
					return { inner: source.slice(contentStart, i), innerStart: contentStart };
				}
				return {
					problem: "unparseable-tag",
					reason: `the <${tagName}> at line ${line} ran into </${closeName}> before its own closing tag. The file does not parse as the element you selected.`,
				};
			}
			if (source[j] === ">") {
				return {
					problem: "element-child",
					reason: `<${tagName}> at line ${line} contains a nested fragment. Replacing its children with plain text would delete that markup. Point at the text node you mean, or edit the file yourself.`,
				};
			}
			const nameStart = j;
			while (j < source.length && TAG_NAME_CHAR.test(source[j] ?? "")) j += 1;
			const nested = source.slice(nameStart, j);
			return {
				problem: "element-child",
				reason: nested
					? `<${tagName}> at line ${line} contains a nested <${nested}>. Replacing its children with plain text would delete that markup. Point at the text node you mean, or edit the file yourself.`
					: `<${tagName}> at line ${line} contains other markup. Replacing its children with plain text would delete that markup. Point at the text node you mean, or edit the file yourself.`,
			};
		}
		i += 1;
	}
	return {
		problem: "unparseable-tag",
		reason: `could not find the closing </${tagName}> for the <${tagName}> at line ${line} — the element does not parse as plain JSX, so there is no text child to change safely.`,
	};
}

/**
 * The whole write, as a pure function of the file's text. Returns the new source
 * or the reason there will not be one — nothing here touches the disk, so a
 * refusal cannot half-write a file.
 */
export function editText(source: string, request: TextEditRequest): TextEditResult {
	const found = findOpeningTag(source, request);
	if ("problem" in found) return { ok: false, problem: found.problem, reason: found.reason };

	const tail = scanTagTail(source, found.nameEnd);
	if (!tail) {
		return {
			ok: false,
			problem: "unparseable-tag",
			reason: `could not read the attributes of <${found.name}> at line ${request.line} — the opening tag does not parse as plain JSX, so there is no text child to change safely.`,
		};
	}
	if (tail.selfClosing) {
		return {
			ok: false,
			problem: "self-closing",
			reason: `<${found.name} /> at line ${request.line} is self-closing, so it has no children. Point at an element that wraps a piece of text, not a void tag.`,
		};
	}

	const child = readStaticTextChild(source, tail.end, found.name, request.line);
	if ("problem" in child) return { ok: false, problem: child.problem, reason: child.reason };

	const { lead, body } = splitAroundText(child.inner);
	const next = request.text;
	if (next === body) {
		return { ok: true, source, before: body, after: body, changed: false };
	}
	if (UNSAFE_TEXT_CHAR.test(next)) {
		return {
			ok: false,
			problem: "unsafe-text",
			reason: `refusing to write ${JSON.stringify(next)}: new text cannot contain < > { or }. Escaping them would write something other than what you typed. Remove those characters, or edit the file yourself.`,
		};
	}

	const bodyStart = child.innerStart + lead.length;
	const bodyEnd = bodyStart + body.length;
	return {
		ok: true,
		source: source.slice(0, bodyStart) + next + source.slice(bodyEnd),
		before: body,
		after: next,
		changed: true,
	};
}
