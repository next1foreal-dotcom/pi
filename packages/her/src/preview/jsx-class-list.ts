/**
 * Editing the class list of one JSX tag, as a pure function of the file's text.
 *
 * Split out of element-edit.ts so there is ONE of these. Her tool reaches it
 * through a Playwright pick; the lab's properties panel reaches it through the
 * dev server. Two copies of a parser that decides which bytes of someone's
 * source get rewritten is exactly the shape that already cost a night here --
 * spotlight and inspect each had their own fiber walk and disagreed about the
 * same button.
 *
 * Nothing in this file imports anything. That is the point: the dev server
 * plugin loads it without pulling in pi, typebox, or playwright.
 */

const CLASS_ATTRIBUTE = "className";
/** JSX tag names: host tags, dotted members (`Foo.Bar`), namespaced, custom elements. */
const TAG_NAME_CHAR = /[A-Za-z0-9_$.:-]/;
/** An attribute name may start with a letter, `_` or `$`; `data-x` and `aria-y` continue with `-`. */
const ATTR_NAME_START = /[A-Za-z_$]/;
const ATTR_NAME_CHAR = /[A-Za-z0-9_$:.-]/;
/**
 * Characters that cannot appear in a class name we are about to splice into
 * source. Whitespace would silently become two classes; the rest would end the
 * attribute, the tag, or the file's parse. Tailwind's arbitrary values keep
 * working: `w-[calc(100%-2rem)]`, `after:content-['']`, `text-[var(--x)]`.
 */
const UNSAFE_CLASS_CHAR = /[\s<>{}`\\]/;
/** No class name has a control character in it; one landing in source is a corruption, not a class. */
const CONTROL_CHAR_LIMIT = 0x20;
/** The only files whose JSX tags this tool will touch. */
export const EDITABLE_SOURCE = /\.[jt]sx$/;

export type ClassListProblem =
	| "bad-location"
	| "tag-mismatch"
	| "unparseable-tag"
	| "dynamic-class-list"
	| "no-class-attribute"
	| "unsafe-class-name"
	| "nothing-to-do"
	| "stale-value";

export interface ClassEditRequest {
	line: number;
	column: number;
	tag: string;
	add?: readonly string[];
	remove?: readonly string[];
	/** Whole-list replacement. Never combined with add/remove. */
	replace?: readonly string[];
	/**
	 * Write only if the current className value text equals this.
	 * `null` means the attribute is absent — not the same as `""`, which is
	 * an empty `className=""`. Omitted means do not check.
	 */
	expect?: string | null;
}

export type ClassEditResult =
	| {
			ok: true;
			source: string;
			before: string;
			after: string;
			changed: boolean;
			/** The edit emptied the class list, so `className` came off the tag entirely. */
			dropped: boolean;
			/** Names asked to be removed that were not on the tag. */
			missing: string[];
			/** Names asked to be added that were already on the tag. */
			present: string[];
	  }
	| { ok: false; problem: ClassListProblem; reason: string; source?: string };

interface OpenTag {
	/** Offset of the `<`. */
	start: number;
	/** Offset just past the tag name. */
	nameEnd: number;
	name: string;
}

interface JsxAttribute {
	name: string;
	/** Offset of the first character of the attribute's name. */
	start: number;
	/** Offset just past the whole attribute, closing quote or brace included. */
	end: number;
	/** Offset of the first character of the value, inside the quotes or braces. */
	valueStart: number;
	/** Offset just past the last character of the value. */
	valueEnd: number;
	kind: "string" | "expression" | "boolean";
	quote: string;
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
	request: Pick<ClassEditRequest, "line" | "column" | "tag">,
): OpenTag | { problem: ClassListProblem; reason: string } {
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
 * Every attribute of the opening tag that starts at `nameEnd`, or null when the
 * tag does not parse. Null is a refusal, not a fallback: an unparsed tag is one
 * we cannot honestly claim to have located a class list inside.
 */
export function scanAttributes(source: string, nameEnd: number): JsxAttribute[] | null {
	const out: JsxAttribute[] = [];
	let i = nameEnd;
	while (i < source.length) {
		while (i < source.length && /\s/.test(source[i])) i += 1;
		if (i >= source.length) return null;
		const c = source[i];
		if (c === ">") return out;
		if (c === "/" && source[i + 1] === ">") return out;
		if (c === "{") {
			// `{...props}` — a spread, which owns no name we could edit.
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

/** Name the shape of a `className={...}` so the refusal says what it found. */
export function describeExpression(text: string): string {
	const t = text.trim();
	if (t.startsWith("`")) return "a template literal";
	const call = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/.exec(t);
	if (call) return `a call to ${call[1]}(...)`;
	if (/^(["']).*\1$/s.test(t)) return "a string literal wrapped in braces";
	if (/\?[\s\S]*:/.test(t)) return "a conditional";
	if (/^[A-Za-z_$][\w$.]*$/.test(t)) return `the variable ${t}`;
	return "a JavaScript expression";
}

interface Token {
	text: string;
	start: number;
	end: number;
}

function tokenize(value: string): Token[] {
	const out: Token[] = [];
	const re = /\S+/g;
	let m = re.exec(value);
	while (m) {
		out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
		m = re.exec(value);
	}
	return out;
}

/**
 * Drop `names` from a class list, taking one adjacent run of whitespace with
 * each so the survivors keep their own spacing and their order. Right to left,
 * so earlier offsets stay valid.
 */
function removeClasses(value: string, names: readonly string[]): { value: string; removed: string[] } {
	const wanted = new Set(names);
	const tokens = tokenize(value);
	const removed: string[] = [];
	let next = value;
	for (let k = tokens.length - 1; k >= 0; k -= 1) {
		const token = tokens[k];
		if (!wanted.has(token.text)) continue;
		removed.push(token.text);
		let from = token.start;
		let to = token.end;
		while (from > 0 && /\s/.test(next[from - 1])) from -= 1;
		if (from === 0) {
			to = token.end;
			while (to < next.length && /\s/.test(next[to])) to += 1;
		}
		next = next.slice(0, from) + next.slice(to);
	}
	return { value: next, removed: removed.reverse() };
}

/** Append the classes that are not already there, after the last one, leaving the rest byte-identical. */
function addClasses(value: string, names: readonly string[]): { value: string; added: string[]; present: string[] } {
	const tokens = tokenize(value);
	const have = new Set(tokens.map((t) => t.text));
	const added: string[] = [];
	const present: string[] = [];
	for (const name of names) {
		if (have.has(name)) {
			present.push(name);
			continue;
		}
		have.add(name);
		added.push(name);
	}
	if (added.length === 0) return { value, added, present };
	if (tokens.length === 0) return { value: added.join(" "), added, present };
	const last = tokens[tokens.length - 1];
	return { value: `${value.slice(0, last.end)} ${added.join(" ")}${value.slice(last.end)}`, added, present };
}

function unsafeClassNames(names: readonly string[], quote: string): string[] {
	return names.filter(
		(name) =>
			name === "" ||
			UNSAFE_CLASS_CHAR.test(name) ||
			[...name].some((ch) => (ch.codePointAt(0) ?? 0) < CONTROL_CHAR_LIMIT) ||
			(quote !== "" && name.includes(quote)),
	);
}

/**
 * The whole write, as a pure function of the file's text. Returns the new source
 * or the reason there will not be one — nothing here touches the disk, so a
 * refusal cannot half-write a file.
 */
export function editClassList(source: string, request: ClassEditRequest): ClassEditResult {
	const found = findOpeningTag(source, request);
	if ("problem" in found) return { ok: false, problem: found.problem, reason: found.reason };

	const attributes = scanAttributes(source, found.nameEnd);
	if (!attributes) {
		return {
			ok: false,
			problem: "unparseable-tag",
			reason: `could not read the attributes of <${found.name}> at line ${request.line} — the opening tag does not parse as plain JSX, so there is no class list to change safely.`,
		};
	}

	const add = request.add ?? [];
	const remove = request.remove ?? [];
	const replace = request.replace;
	const className = attributes.find((attr) => attr.name === CLASS_ATTRIBUTE);

	if (className && className.kind !== "string") {
		const shape =
			className.kind === "boolean"
				? "no value at all"
				: describeExpression(source.slice(className.valueStart, className.valueEnd));
		return {
			ok: false,
			problem: "dynamic-class-list",
			reason: `<${found.name}> at line ${request.line} has className={...} holding ${shape}. Editing that as text cannot be correct — the class list is computed at render time. Change the expression yourself with edit, or point at an element whose className is a plain string.`,
		};
	}

	const current: string | null = className ? source.slice(className.valueStart, className.valueEnd) : null;
	if (request.expect !== undefined && request.expect !== current) {
		const show = (value: string | null) => (value === null ? "no className" : `className ${JSON.stringify(value)}`);
		return {
			ok: false,
			problem: "stale-value",
			reason: `<${found.name}> at line ${request.line} column ${request.column} has ${show(current)}, not ${show(request.expect)}. Something changed this value since you last wrote it; read the element again rather than overwriting a change you did not make.`,
			source,
		};
	}

	const inserting = replace ?? add;
	const quote = className?.quote ?? '"';
	const unsafe = unsafeClassNames(inserting, quote);
	if (unsafe.length > 0) {
		return {
			ok: false,
			problem: "unsafe-class-name",
			reason: `refusing ${unsafe.map((n) => JSON.stringify(n)).join(", ")}: a class name cannot contain whitespace, the attribute's own ${quote} quote, or any of < > { } \` \\.`,
		};
	}

	if (!className) {
		if (replace === undefined && add.length === 0) {
			return {
				ok: false,
				problem: "no-class-attribute",
				reason: `<${found.name}> at line ${request.line} has no className to change. Add one by calling this with add.`,
			};
		}
		const value = (replace ?? add).join(" ");
		const insert = ` ${CLASS_ATTRIBUTE}="${value}"`;
		return {
			ok: true,
			source: source.slice(0, found.nameEnd) + insert + source.slice(found.nameEnd),
			before: "",
			after: value,
			changed: true,
			dropped: false,
			missing: [...remove],
			present: [],
		};
	}

	const before = source.slice(className.valueStart, className.valueEnd);
	let value = before;
	let missing: string[] = [];
	let present: string[] = [];

	if (replace !== undefined) {
		value = replace.join(" ");
	} else {
		const dropped = removeClasses(value, remove);
		value = dropped.value;
		missing = remove.filter((name) => !dropped.removed.includes(name));
		const appended = addClasses(value, add);
		value = appended.value;
		present = appended.present;
	}

	const changed = value !== before;
	// Taking the last class off used to leave `className=""` standing. It renders
	// the same, so nothing caught it, but it means undoing what you just did does
	// not give you back the tag you started with -- and the whole claim of this
	// tool is that it changes the one element you pointed at and leaves the file
	// otherwise as it was. An empty class list is not a class list.
	//
	// Only when this edit is what emptied it. A `className=""` that was already
	// there and is not being changed stays: tidying it would be an edit nobody
	// asked for, in a file someone else is holding open.
	const dropped = changed && value === "";
	if (dropped) {
		// The whitespace in front of it goes too, or `<h1 className="">` becomes
		// `<h1 >`. Walking back to the previous non-space also does the right thing
		// when the attribute sits on a line of its own.
		let cut = className.start;
		while (cut > 0 && /\s/.test(source[cut - 1])) cut -= 1;
		return {
			ok: true,
			source: source.slice(0, cut) + source.slice(className.end),
			before,
			after: value,
			changed,
			dropped,
			missing,
			present,
		};
	}
	return {
		ok: true,
		source: changed ? source.slice(0, className.valueStart) + value + source.slice(className.valueEnd) : source,
		before,
		after: value,
		changed,
		dropped,
		missing,
		present,
	};
}

/** `"a  b"` -> `["a", "b"]`; anything that is not a string is nothing. */
export function splitClasses(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.flatMap((item) => splitClasses(item));
	if (typeof raw !== "string") return [];
	return raw.split(/\s+/).filter(Boolean);
}
