/**
 * Rewrite token CSS so it only paints inside `scope`.
 * `:root` / `html` become the scope; other selectors are prefixed.
 * Selectors that already start with the scope are left alone.
 */

const NESTED_AT = new Set([
	"media",
	"supports",
	"layer",
	"container",
	"scope",
]);

function alreadyScoped(selector: string, scope: string): boolean {
	if (selector === scope) return true;
	if (!selector.startsWith(scope)) return false;
	const next = selector.charAt(scope.length);
	return next !== "" && /[\s.:#[>+~]/.test(next);
}

function replaceSubject(
	selector: string,
	subject: string,
	scope: string,
): string | null {
	const lower = selector.toLowerCase();
	if (lower === subject) return scope;
	if (!lower.startsWith(subject)) return null;
	const next = selector.charAt(subject.length);
	if (next && /[\s.:#[>+~]/.test(next)) return scope + selector.slice(subject.length);
	return null;
}

function scopeSelector(selector: string, scope: string): string {
	const s = selector.trim();
	if (!s) return s;
	const asRoot = replaceSubject(s, ":root", scope);
	if (asRoot !== null) return asRoot;
	const asHtml = replaceSubject(s, "html", scope);
	if (asHtml !== null) return asHtml;
	if (alreadyScoped(s, scope)) return s;
	return `${scope} ${s}`;
}

function skipCommentOrString(css: string, i: number): number {
	if (css.startsWith("/*", i)) {
		const end = css.indexOf("*/", i + 2);
		return end < 0 ? css.length : end + 2;
	}
	const q = css[i];
	if (q !== '"' && q !== "'") return i;
	let j = i + 1;
	while (j < css.length) {
		if (css[j] === "\\") {
			j += 2;
			continue;
		}
		if (css[j] === q) return j + 1;
		j++;
	}
	return css.length;
}

function indexOfUnquoted(css: string, needle: string, from: number): number {
	let i = from;
	while (i < css.length) {
		const skip = skipCommentOrString(css, i);
		if (skip !== i) {
			i = skip;
			continue;
		}
		if (needle.length === 1 ? css[i] === needle : css.startsWith(needle, i)) {
			return i;
		}
		i++;
	}
	return -1;
}

function extractBlock(
	css: string,
	openBrace: number,
): { inner: string; end: number } {
	let depth = 0;
	let i = openBrace;
	while (i < css.length) {
		const skip = skipCommentOrString(css, i);
		if (skip !== i) {
			i = skip;
			continue;
		}
		const c = css[i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				return { inner: css.slice(openBrace + 1, i), end: i + 1 };
			}
		}
		i++;
	}
	return { inner: css.slice(openBrace + 1), end: css.length };
}

function atName(header: string): string {
	const m = /^@([A-Za-z-]+)/.exec(header.trim());
	return (m?.[1] ?? "").toLowerCase();
}

function rewriteChunk(css: string, scope: string): string {
	let out = "";
	let i = 0;
	const n = css.length;
	while (i < n) {
		if (css.startsWith("/*", i)) {
			const end = css.indexOf("*/", i + 2);
			const j = end < 0 ? n : end + 2;
			out += css.slice(i, j);
			i = j;
			continue;
		}
		if (css[i] === "@") {
			const brace = indexOfUnquoted(css, "{", i);
			const semi = indexOfUnquoted(css, ";", i);
			if (semi >= 0 && (brace < 0 || semi < brace)) {
				out += css.slice(i, semi + 1);
				i = semi + 1;
				continue;
			}
			if (brace < 0) {
				out += css.slice(i);
				break;
			}
			const header = css.slice(i, brace);
			const { inner, end } = extractBlock(css, brace);
			if (NESTED_AT.has(atName(header))) {
				out += `${header}{${rewriteChunk(inner, scope)}}`;
			} else {
				out += `${header}{${inner}}`;
			}
			i = end;
			continue;
		}
		const brace = indexOfUnquoted(css, "{", i);
		if (brace < 0) {
			out += css.slice(i);
			break;
		}
		const raw = css.slice(i, brace);
		const trimmed = raw.trim();
		const start = raw.indexOf(trimmed);
		const leading = start >= 0 ? raw.slice(0, start) : "";
		const trailing =
			start >= 0 ? raw.slice(start + trimmed.length) : raw;
		const rewritten = trimmed
			? trimmed
					.split(",")
					.map((sel) => scopeSelector(sel, scope))
					.join(",")
			: "";
		const { inner, end } = extractBlock(css, brace);
		out += `${leading}${rewritten}${trailing}{${inner}}`;
		i = end;
	}
	return out;
}

export function scopeTokenCss(css: string, scope: string): string {
	return rewriteChunk(css, scope);
}
