import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
import {
	DEFAULT_LAB_PORT,
	errorText,
	labScreenIds,
	lockIntoScreen,
	type PageLike,
	probeListeningPort,
	withLabPage,
} from "./lab-still.ts";

/**
 * Point at a rendered element, then change the class list of the JSX tag that
 * made it.
 *
 * The reading half (`design_element_at`) is the mouse she does not have: the
 * inspect plugin already turns a point into a source location, but only a person
 * shift-clicking in a browser could ever supply the point. This drives the same
 * published api through the same Playwright plumbing `design_lab_still` uses.
 *
 * The writing half (`design_element_classes`) is worth more for what it refuses
 * than for what it writes. A source location goes stale the instant anything
 * edits the file, and in a screen with six buttons the wrong line looks exactly
 * as plausible as the right one. So it re-opens the file, walks to that line and
 * column, and only writes if the tag standing there is still the tag the caller
 * says it selected. A `className={...}` expression is refused by name rather
 * than guessed at, because no amount of textual cleverness makes editing
 * `cn(base, active && "x")` correct.
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
const EDITABLE_SOURCE = /\.[jt]sx$/;

export type ClassListProblem =
	| "bad-location"
	| "tag-mismatch"
	| "unparseable-tag"
	| "dynamic-class-list"
	| "no-class-attribute"
	| "unsafe-class-name"
	| "nothing-to-do";

export interface ClassEditRequest {
	line: number;
	column: number;
	tag: string;
	add?: readonly string[];
	remove?: readonly string[];
	/** Whole-list replacement. Never combined with add/remove. */
	replace?: readonly string[];
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
	| { ok: false; problem: ClassListProblem; reason: string };

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

/** What `design_element_at` learned about one point on one screen. */
export interface PickResult {
	/** Every screen id on the canvas — the useful answer when the requested one is absent. */
	screenIds: string[];
	/** The named screen is on the canvas. */
	found: boolean;
	/** The inspect plugin is not published on `window.lab`. */
	labless?: boolean;
	/** The point is outside the browser viewport even after scrolling to it. */
	offscreen?: boolean;
	selection: LabSelection | null;
	geometry?: PickGeometry;
	/** The selected element's box, in the same screen-relative units as the point. */
	box?: { x: number; y: number; width: number; height: number };
}

/** The inspect plugin's answer. Mirrors `InspectSelection` without importing across packages. */
export interface LabSelection {
	screenId: string | null;
	file: string | null;
	line: number | null;
	column: number | null;
	component: string | null;
	tag: string;
	className: string;
	text: string;
	attached: boolean;
	problem: string | null;
}

export interface PickGeometry {
	/** The screen's own layout size, and how far its content runs. */
	screen: { width: number; height: number; scrollWidth: number; scrollHeight: number };
	point: { x: number; y: number };
	client: { x: number; y: number };
	/** Canvas zoom at the moment of the hit test. */
	scale: number;
	scroll: { top: number; left: number };
	viewport: { width: number; height: number };
}

export interface PickRequest {
	screenId: string;
	x: number;
	y: number;
	port: number;
}

export interface ElementEditDeps {
	repoRoot?: string;
	probePort?: (port: number) => Promise<boolean>;
	pick?: (request: PickRequest) => Promise<PickResult>;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function splitClasses(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.flatMap((item) => splitClasses(item));
	if (typeof raw !== "string") return [];
	return raw.split(/\s+/).filter(Boolean);
}

/** Repo-relative `.tsx`/`.jsx` inside the repo, or the reason it is not. */
export function resolveSourcePath(
	repoRoot: string,
	file: string,
): { ok: true; absolute: string; relative: string } | { ok: false; reason: string } {
	const raw = file.trim();
	if (!raw) return { ok: false, reason: "Missing file. Pass the repo-relative path design_element_at gave you." };
	const absolute = resolve(repoRoot, raw.replaceAll("\\", "/"));
	const rel = relative(repoRoot, absolute).replaceAll("\\", "/");
	if (rel === "" || rel.startsWith("../") || isAbsolute(rel)) {
		return { ok: false, reason: `Refusing ${raw}: it resolves outside the repo.` };
	}
	if (!EDITABLE_SOURCE.test(rel)) {
		return { ok: false, reason: `Refusing ${rel}: this edits JSX tags, so it only opens .tsx and .jsx files.` };
	}
	return { ok: true, absolute, relative: rel };
}

/**
 * Hit-test one point and select what is under it, using the inspect plugin's own
 * published api.
 *
 * `selectAt` takes PAGE units, which need the canvas camera and origin — and
 * `window.lab` publishes neither. `selectElement` over `elementsFromPoint` is
 * what `selectAt` does internally once it has converted, so this reaches the
 * same element by the same route, from coordinates the browser can give us.
 *
 * The point is relative to the screen's scroller, in the screen's own layout
 * pixels, so it stays the same number at any canvas zoom and below the fold.
 */
const pickScript = (screenId: string, x: number, y: number) => `(() => {
  const out = { screenIds: [], found: false, selection: null };
  out.screenIds = [...new Set([...document.querySelectorAll("[data-screen-id]")].map((el) => el.getAttribute("data-screen-id") || ""))].filter(Boolean);
  const screen = document.querySelector('[data-screen-id="${screenId}"]');
  if (!screen) return out;
  out.found = true;
  const api = window.lab && typeof window.lab.plugin === "function" ? window.lab.plugin("inspect") : null;
  if (!api || typeof api.selectElement !== "function") { out.labless = true; return out; }
  const scroller = screen.querySelector("[data-screen-scroll]") || screen;
  const layout = scroller.offsetWidth;
  const scale = layout > 0 ? scroller.getBoundingClientRect().width / layout : 0;
  if (!(scale > 0)) { out.labless = true; return out; }
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  if (maxTop > 0) scroller.scrollTop = Math.min(maxTop, Math.max(0, ${y} - scroller.clientHeight / 2));
  if (maxLeft > 0) scroller.scrollLeft = Math.min(maxLeft, Math.max(0, ${x} - scroller.clientWidth / 2));
  const rect = scroller.getBoundingClientRect();
  const cx = rect.left + (${x} - scroller.scrollLeft) * scale;
  const cy = rect.top + (${y} - scroller.scrollTop) * scale;
  out.geometry = {
    screen: { width: layout, height: scroller.offsetHeight, scrollWidth: scroller.scrollWidth, scrollHeight: scroller.scrollHeight },
    point: { x: ${x}, y: ${y} },
    client: { x: cx, y: cy },
    scale: scale,
    scroll: { top: scroller.scrollTop, left: scroller.scrollLeft },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) { out.offscreen = true; return out; }
  let node = null;
  for (const el of document.elementsFromPoint(cx, cy)) {
    const sel = api.selectElement(el);
    if (sel) { out.selection = sel; node = el; break; }
  }
  if (!node) { if (typeof api.clear === "function") api.clear(); return out; }
  const br = node.getBoundingClientRect();
  out.box = {
    x: (br.left - rect.left) / scale + scroller.scrollLeft,
    y: (br.top - rect.top) / scale + scroller.scrollTop,
    width: br.width / scale,
    height: br.height / scale,
  };
  return out;
})()`;

async function pickWithPlaywright(request: PickRequest): Promise<PickResult> {
	return withLabPage(request.port, async (page: PageLike) => {
		const screenIds = await labScreenIds(page);
		if (!(await lockIntoScreen(page, request.screenId))) return { screenIds, found: false, selection: null };
		const raw = (await page.evaluate(pickScript(request.screenId, request.x, request.y))) as PickResult;
		return { ...raw, screenIds: raw.screenIds?.length ? raw.screenIds : screenIds };
	});
}

function describeSelection(selection: LabSelection, box: PickResult["box"]): string {
	const where =
		selection.file && selection.line !== null && selection.column !== null
			? `${selection.file}:${selection.line}:${selection.column}`
			: `source unknown (${selection.problem ?? "no location"})`;
	const owner = selection.component ? ` rendered by ${selection.component}` : "";
	const classes = selection.className ? `class "${selection.className}"` : "no class attribute";
	const at = box
		? ` It sits at ${Math.round(box.x)},${Math.round(box.y)} and is ${Math.round(box.width)}×${Math.round(box.height)} in the same screen units you aimed with.`
		: "";
	const sample = selection.text ? ` Its text reads "${selection.text}".` : "";
	return `<${selection.tag}>${owner} at ${where}, with ${classes}.${sample}${at}`;
}

export function registerElementEditTools(pi: ExtensionAPI, deps: ElementEditDeps = {}): void {
	const repoRoot = deps.repoRoot ?? SAMANTHA_REPO_ROOT;
	const probePort = deps.probePort ?? probeListeningPort;
	const pick = deps.pick ?? pickWithPlaywright;

	pi.registerTool({
		name: "design_element_at",
		label: "Design Element At",
		description:
			"Point at something on one of your design lab screens and learn which line of JSX made it. " +
			"This is the mouse you do not have: a person gets here by shift-clicking, you get here by naming a point. " +
			"x and y are relative to the screen's top-left in the screen's OWN layout pixels — the same numbers as its " +
			"design width — not pixels measured off a design_lab_still frame, which is the browser viewport at 2x. " +
			"The answer names the file, line and column of the tag, plus the element's box in those same units, so you " +
			"can aim at a neighbour without guessing. Feed file/line/column/tag straight into design_element_classes. " +
			"The lab must be open (design_lab_open); if it is not, this skips and tells you — skip is not failure.",
		parameters: Type.Object({
			screenId: Type.String(),
			x: Type.Number(),
			y: Type.Number(),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params) {
			const screenId = typeof params.screenId === "string" ? params.screenId.trim() : "";
			if (!screenId)
				return textResult("Missing screenId. Pass the id of the screen you want to point at.", { ok: false });
			if (!/^[a-zA-Z0-9._-]+$/.test(screenId)) {
				return textResult(`Refusing screenId "${screenId}": letters, digits, dot, dash and underscore only.`, {
					ok: false,
				});
			}
			const x = typeof params.x === "number" ? params.x : Number.NaN;
			const y = typeof params.y === "number" ? params.y : Number.NaN;
			if (!Number.isFinite(x) || !Number.isFinite(y)) {
				return textResult(
					"Missing x or y. Pass a point relative to the screen's top-left, in its own layout pixels.",
					{
						ok: false,
					},
				);
			}
			const port = typeof params.port === "number" ? params.port : DEFAULT_LAB_PORT;

			if (!(await probePort(port))) {
				return textResult(
					`The design lab is not listening on ${port}, so there is nothing to point at yet. ` +
						"Open it with design_lab_open and try again. This is a skip, not a failure.",
					{ ok: false, skipped: true, reason: "lab-not-running" },
				);
			}

			let result: PickResult;
			try {
				result = await pick({ screenId, x, y, port });
			} catch (error) {
				return textResult(`Could not point at the lab: ${errorText(error)}`, { ok: false });
			}

			if (!result.found) {
				const known = result.screenIds.length ? result.screenIds.join(", ") : "(none)";
				return textResult(`No screen with id "${screenId}" is on the canvas. Screens that are: ${known}.`, {
					ok: false,
					screenIds: result.screenIds,
				});
			}
			if (result.labless) {
				return textResult(
					"The inspect plugin is not published on window.lab, so nothing can resolve a point to source. " +
						"The lab is running but its plugins have not mounted; reload it and try again.",
					{ ok: false, reason: "no-inspect-plugin" },
				);
			}
			const g = result.geometry;
			if (result.offscreen) {
				return textResult(
					`(${x}, ${y}) is off the browser viewport even after scrolling the screen to it. ` +
						(g
							? `The screen is ${Math.round(g.screen.width)}×${Math.round(g.screen.height)} with content running to ${Math.round(g.screen.scrollHeight)}, ` +
								`and the canvas is at ${g.scale.toFixed(2)}x. Aim inside that.`
							: ""),
					{ ok: false, reason: "point-offscreen", geometry: g },
				);
			}
			if (!result.selection) {
				return textResult(
					`Nothing selectable at (${x}, ${y}) on "${screenId}". ` +
						(g
							? `The screen is ${Math.round(g.screen.width)}×${Math.round(g.screen.height)}, content runs to ${Math.round(g.screen.scrollHeight)}. `
							: "") +
						"Lab chrome, sticky notes, labels, rulers and the scroller itself are never hit — aim at content.",
					{ ok: false, reason: "nothing-there", geometry: g },
				);
			}

			return textResult(describeSelection(result.selection, result.box), {
				ok: true,
				selection: result.selection,
				box: result.box,
				geometry: g,
			});
		},
	});

	pi.registerTool({
		name: "design_element_classes",
		label: "Design Element Classes",
		description:
			"Change the class list of ONE JSX tag, at the file/line/column design_element_at gave you. " +
			"Pass the tag you selected: this re-opens the file and refuses to write unless that tag is still standing at " +
			"that line and column, because a location goes stale the moment anything edits the file and editing the wrong " +
			"element of six is worse than editing none. " +
			"add and remove adjust the list in place and leave everything else byte-for-byte; replace rewrites the whole " +
			"list and has to be asked for by name. A className={...} expression — cn(...), a template literal, a " +
			"conditional — is refused and named, never guessed at. " +
			"Writing the file triggers the lab's hot reload, so the next design_lab_still shows the change: take one, " +
			"because a change you have not looked at is not verified.",
		parameters: Type.Object({
			file: Type.String(),
			line: Type.Number(),
			column: Type.Number(),
			tag: Type.String(),
			add: Type.Optional(Type.String()),
			remove: Type.Optional(Type.String()),
			replace: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params) {
			const path = resolveSourcePath(repoRoot, typeof params.file === "string" ? params.file : "");
			if (!path.ok) return textResult(path.reason, { ok: false });

			const line = typeof params.line === "number" ? params.line : Number.NaN;
			const column = typeof params.column === "number" ? params.column : Number.NaN;
			const tag = typeof params.tag === "string" ? params.tag.trim() : "";
			if (!Number.isFinite(line) || !Number.isFinite(column) || !tag) {
				return textResult(
					"Missing line, column or tag. All three come from design_element_at, and the tag is what makes a stale " +
						"location refusable rather than silently wrong.",
					{ ok: false },
				);
			}

			const add = splitClasses(params.add);
			const remove = splitClasses(params.remove);
			const wantsReplace = typeof params.replace === "string" && params.replace.trim() !== "";
			const replace = wantsReplace ? splitClasses(params.replace) : undefined;
			if (replace && (add.length > 0 || remove.length > 0)) {
				return textResult(
					"replace rewrites the whole class list, so it cannot be combined with add or remove. Send one or the other.",
					{ ok: false },
				);
			}
			if (!replace && add.length === 0 && remove.length === 0) {
				return textResult("Nothing to change. Pass add, remove, or replace.", { ok: false });
			}

			let source: string;
			try {
				source = await readFile(path.absolute, "utf8");
			} catch (error) {
				return textResult(`Could not read ${path.relative}: ${errorText(error)}`, { ok: false });
			}

			const edit = editClassList(source, { line, column, tag, add, remove, replace });
			if (!edit.ok) {
				return textResult(`Refusing to edit ${path.relative}: ${edit.reason}`, {
					ok: false,
					problem: edit.problem,
					file: path.relative,
				});
			}
			if (!edit.changed) {
				return textResult(
					`<${tag}> at ${path.relative}:${line} already reads "${edit.before}" — nothing to do. ` +
						(edit.present.length ? `Already there: ${edit.present.join(", ")}. ` : "") +
						(edit.missing.length ? `Not on the tag: ${edit.missing.join(", ")}.` : ""),
					{ ok: true, changed: false, file: path.relative, className: edit.before },
				);
			}

			try {
				await writeFile(path.absolute, edit.source);
			} catch (error) {
				return textResult(`Could not write ${path.relative}: ${errorText(error)}`, { ok: false });
			}

			const notes =
				(edit.present.length ? ` Already there: ${edit.present.join(", ")}.` : "") +
				(edit.missing.length ? ` Not on the tag, so not removed: ${edit.missing.join(", ")}.` : "");
			const became = edit.dropped
				? `has no className at all now (it was "${edit.before}") — an empty class list is not a class list, so the attribute came off with the last name in it`
				: `now reads class "${edit.after}" (was "${edit.before}")`;
			return textResult(
				`<${tag}> at ${path.relative}:${line}:${column} ${became}.${notes} ` +
					"The lab hot-reloads on this write — take a design_lab_still and look at it.",
				{
					ok: true,
					changed: true,
					file: path.relative,
					before: edit.before,
					after: edit.after,
					dropped: edit.dropped,
				},
			);
		},
	});
}
