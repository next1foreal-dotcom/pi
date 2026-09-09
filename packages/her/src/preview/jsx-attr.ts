/**
 * Editing one JSX attribute on one tag, as a pure function of the file's text.
 *
 * Pair of jsx-class-list.ts / jsx-text.ts: those rewrite a className and a
 * static text child; this one rewrites a named prop on the same opening tag.
 * Same consumers (the lab properties panel via the dev server).
 *
 * Sibling import is allowed. Node built-ins and third-party packages are not:
 * the vite plugin loads this file the same way it loads jsx-class-list.ts, and
 * an import of pi / typebox / playwright would drag those into the dev server.
 * The scanner is NOT copied. findOpeningTag, scanAttributes, describeExpression
 * and EDITABLE_SOURCE come from ./jsx-class-list.ts.
 */

import { describeExpression, EDITABLE_SOURCE, findOpeningTag, scanAttributes } from "./jsx-class-list.ts";

export { EDITABLE_SOURCE };

/** A JSX attribute name: letters, `_`, `$`, then digits / `:` / `.` / `-`. */
const ATTR_NAME = /^[A-Za-z_$][A-Za-z0-9_$:.-]*$/;
/** JSON-number shape, so `08` or `0x10` is not treated as a literal we understand. */
const JSON_NUMBER = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export type PropWrite =
	| { as: "string"; value: string }
	| { as: "expression"; value: string | number | boolean | null }
	| { as: "remove" };

export type PropEditProblem =
	| "bad-location"
	| "tag-mismatch"
	| "unparseable-tag"
	| "bad-prop"
	| "dynamic-prop"
	| "spread-shadow"
	| "unsafe-value"
	| "stale-value";

export interface PropEditRequest {
	line: number;
	column: number;
	tag: string;
	prop: string;
	value: PropWrite;
	/**
	 * Write only if the current attribute source equals this (`gap={4}`).
	 * `null` means the attribute is absent — not the same as `""`.
	 * Omitted means do not check.
	 */
	expect?: string | null;
}

export type PropEditResult =
	| {
			ok: true;
			source: string;
			before: string;
			after: string;
			changed: boolean;
	  }
	| { ok: false; problem: PropEditProblem; reason: string; source?: string };

type JsxAttribute = NonNullable<ReturnType<typeof scanAttributes>>[number];

/**
 * The HTTP body field. Kept here so the plugin cannot invent a fourth shape.
 * `as` chooses the syntax (`title="x"` vs `gap={8}` vs drop the attribute);
 * `value` is the payload, never raw JavaScript to splice.
 */
export function parsePropWrite(raw: unknown): { ok: true; value: PropWrite } | { ok: false; error: string } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return {
			ok: false,
			error: "value is how this prop should be written: a quoted string, a simple expression, or remove",
		};
	}
	const rec = raw as { as?: unknown; value?: unknown };
	if (rec.as === "remove") return { ok: true, value: { as: "remove" } };
	if (rec.as === "string") {
		if (typeof rec.value !== "string") {
			return { ok: false, error: "a quoted string write needs a string" };
		}
		return { ok: true, value: { as: "string", value: rec.value } };
	}
	if (rec.as === "expression") {
		const v = rec.value;
		if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
			return { ok: false, error: "an expression write needs a string, number, boolean or null" };
		}
		return { ok: true, value: { as: "expression", value: v } };
	}
	return {
		ok: false,
		error: "value is how this prop should be written: a quoted string, a simple expression, or remove",
	};
}

/**
 * Offset of the last `{` that sits at attribute position (a JSX spread), or
 * null. Named attributes come from scanAttributes; this only looks at the
 * leftover gaps, so it is not a third scanner.
 */
function lastSpreadStart(source: string, nameEnd: number, attributes: readonly JsxAttribute[]): number | null {
	let last: number | null = null;
	const noteGap = (from: number, to: number) => {
		const gap = source.slice(from, to);
		const at = gap.lastIndexOf("{");
		if (at !== -1) last = from + at;
	};
	let cursor = nameEnd;
	for (const attr of attributes) {
		noteGap(cursor, attr.start);
		cursor = attr.end;
	}
	const rest = source.slice(cursor);
	let depth = 0;
	for (let i = 0; i < rest.length; i += 1) {
		const c = rest[i];
		if (c === "{") {
			if (depth === 0) last = cursor + i;
			depth += 1;
		} else if (c === "}") {
			depth -= 1;
		} else if (depth === 0 && c === ">") {
			break;
		}
	}
	return last;
}

/** Number / boolean / null / quoted string. Anything else is code we must not overwrite. */
function parseSimpleLiteral(text: string): { value: string | number | boolean | null } | null {
	const t = text.trim();
	if (t === "true") return { value: true };
	if (t === "false") return { value: false };
	if (t === "null") return { value: null };
	if (JSON_NUMBER.test(t)) {
		const n = Number(t);
		if (!Number.isFinite(n)) return null;
		return { value: n };
	}
	if (t.length >= 2) {
		const quote = t[0];
		if ((quote === '"' || quote === "'") && t[t.length - 1] === quote) {
			const inner = t.slice(1, -1);
			if (!inner.includes(quote) && !inner.includes("\\")) return { value: inner };
			if (quote === '"') {
				try {
					const parsed = JSON.parse(t) as unknown;
					if (typeof parsed === "string") return { value: parsed };
				} catch {
					return null;
				}
			}
			return null;
		}
	}
	return null;
}

function currentIsLiteral(attr: JsxAttribute, source: string): true | string {
	if (attr.kind === "string" || attr.kind === "boolean") return true;
	const inner = source.slice(attr.valueStart, attr.valueEnd);
	if (parseSimpleLiteral(inner)) return true;
	return describeExpression(inner);
}

function sameAsWrite(attr: JsxAttribute | undefined, source: string, write: PropWrite): boolean {
	if (write.as === "remove") return !attr;
	if (!attr) return false;
	if (write.as === "string") {
		if (attr.kind !== "string") return false;
		return source.slice(attr.valueStart, attr.valueEnd) === write.value;
	}
	if (attr.kind === "boolean") return write.value === true;
	if (attr.kind === "string") return false;
	const parsed = parseSimpleLiteral(source.slice(attr.valueStart, attr.valueEnd));
	if (!parsed) return false;
	return parsed.value === write.value;
}

function serializeLiteral(
	value: string | number | boolean | null,
): string | { problem: "unsafe-value"; reason: string } {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			return {
				problem: "unsafe-value",
				reason: `refusing to write ${String(value)}: an expression must be a finite number, a boolean, null, or a string.`,
			};
		}
		return JSON.stringify(value);
	}
	return JSON.stringify(value);
}

function quotedAttr(name: string, value: string, quote: string): string | PropEditResult {
	if (value.includes(quote)) {
		return {
			ok: false,
			problem: "unsafe-value",
			reason: `refusing to write ${JSON.stringify(value)}: a quoted attribute cannot contain ${quote}. Escaping it would write something other than what you typed. Remove the quote, or edit the file yourself.`,
		};
	}
	return `${name}=${quote}${value}${quote}`;
}

function buildAttr(name: string, write: Exclude<PropWrite, { as: "remove" }>, quote: string): string | PropEditResult {
	if (write.as === "string") return quotedAttr(name, write.value, quote);
	const inner = serializeLiteral(write.value);
	if (typeof inner !== "string") return { ok: false, problem: inner.problem, reason: inner.reason };
	return `${name}={${inner}}`;
}

/**
 * The whole write, as a pure function of the file's text. Returns the new source
 * or the reason there will not be one — nothing here touches the disk, so a
 * refusal cannot half-write a file.
 */
export function editProp(source: string, request: PropEditRequest): PropEditResult {
	const prop = request.prop.trim();
	if (!prop) {
		return { ok: false, problem: "bad-prop", reason: "prop is the attribute name to change" };
	}
	if (!ATTR_NAME.test(prop)) {
		return {
			ok: false,
			problem: "bad-prop",
			reason: `refusing ${JSON.stringify(request.prop)}: that is not a JSX attribute name.`,
		};
	}

	const found = findOpeningTag(source, request);
	if ("problem" in found) {
		const problem: PropEditProblem =
			found.problem === "tag-mismatch" || found.problem === "bad-location" ? found.problem : "unparseable-tag";
		return { ok: false, problem, reason: found.reason };
	}

	const attributes = scanAttributes(source, found.nameEnd);
	if (!attributes) {
		return {
			ok: false,
			problem: "unparseable-tag",
			reason: `could not read the attributes of <${found.name}> at line ${request.line} — the opening tag does not parse as plain JSX, so there is no attribute to change safely.`,
		};
	}

	let attr: JsxAttribute | undefined;
	for (const candidate of attributes) {
		if (candidate.name === prop) attr = candidate;
	}

	if (attr) {
		const literal = currentIsLiteral(attr, source);
		if (literal !== true) {
			return {
				ok: false,
				problem: "dynamic-prop",
				reason: `<${found.name}> at line ${request.line} has ${prop}={...} holding ${literal}. Overwriting that would throw away code that is not a plain literal. Change the expression yourself, or point at a tag whose ${prop} is a string or a simple literal.`,
			};
		}
	}

	const current: string | null = attr ? source.slice(attr.start, attr.end) : null;
	if (request.expect !== undefined && request.expect !== current) {
		const show = (value: string | null) =>
			value === null ? `no ${prop}` : value === "" ? JSON.stringify(value) : value;
		return {
			ok: false,
			problem: "stale-value",
			reason: `<${found.name}> at line ${request.line} column ${request.column} has ${show(current)}, not ${show(request.expect)}. Something changed this value since you last wrote it; read the element again rather than overwriting a change you did not make.`,
			source,
		};
	}

	const write = request.value;
	const before = attr ? source.slice(attr.start, attr.end) : "";
	if (write.as === "remove" && !attr) {
		return { ok: true, source, before: "", after: "", changed: false };
	}

	const lastSpread = lastSpreadStart(source, found.nameEnd, attributes);
	if (write.as === "remove" && attr && lastSpread !== null) {
		return {
			ok: false,
			problem: "spread-shadow",
			reason: `<${found.name}> at line ${request.line} has {...spread} on the tag, so removing ${prop} would not return to the component default — the spread may still supply it. Remove the spread first, or edit the file yourself.`,
		};
	}

	const insertAt = attributes.length > 0 ? attributes[attributes.length - 1].end : found.nameEnd;
	const writeAt = attr ? attr.start : insertAt;
	if (lastSpread !== null && writeAt < lastSpread) {
		return {
			ok: false,
			problem: "spread-shadow",
			reason: `<${found.name}> at line ${request.line} has {...spread} on the tag, so ${prop} may come from that spread — or the spread may overwrite what you write. Either way the panel would lie about what rendered. Put ${prop} after the spread, or remove the spread, then try again.`,
		};
	}

	if (write.as === "remove" && attr) {
		let cut = attr.start;
		while (cut > 0 && /\s/.test(source[cut - 1] ?? "")) cut -= 1;
		return {
			ok: true,
			source: source.slice(0, cut) + source.slice(attr.end),
			before,
			after: "",
			changed: true,
		};
	}

	if (write.as === "remove") {
		return { ok: true, source, before: "", after: "", changed: false };
	}

	if (sameAsWrite(attr, source, write)) {
		return { ok: true, source, before, after: before, changed: false };
	}

	const quote = attr?.kind === "string" && attr.quote ? attr.quote : '"';
	const sameForm =
		attr !== undefined &&
		((write.as === "string" && attr.kind === "string") || (write.as === "expression" && attr.kind === "expression"));

	if (sameForm && attr) {
		let inner: string;
		if (write.as === "string") {
			if (write.value.includes(quote)) {
				return {
					ok: false,
					problem: "unsafe-value",
					reason: `refusing to write ${JSON.stringify(write.value)}: a quoted attribute cannot contain ${quote}. Escaping it would write something other than what you typed. Remove the quote, or edit the file yourself.`,
				};
			}
			inner = write.value;
		} else {
			const serialized = serializeLiteral(write.value);
			if (typeof serialized !== "string") {
				return { ok: false, problem: serialized.problem, reason: serialized.reason };
			}
			inner = serialized;
		}
		const next = source.slice(0, attr.valueStart) + inner + source.slice(attr.valueEnd);
		const afterEnd = attr.end - (attr.valueEnd - attr.valueStart) + inner.length;
		return {
			ok: true,
			source: next,
			before,
			after: next.slice(attr.start, afterEnd),
			changed: true,
		};
	}

	const built = buildAttr(prop, write, quote);
	if (typeof built !== "string") return built;

	if (attr) {
		return {
			ok: true,
			source: source.slice(0, attr.start) + built + source.slice(attr.end),
			before,
			after: built,
			changed: true,
		};
	}

	return {
		ok: true,
		source: source.slice(0, insertAt) + ` ${built}` + source.slice(insertAt),
		before: "",
		after: built,
		changed: true,
	};
}
