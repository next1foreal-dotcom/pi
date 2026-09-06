/**
 * Turn a persisted scratch set (token-overrides.json) into the CSS text
 * that `tokens.preview()` consumes.
 *
 * Pure function — no I/O, no DOM. The bugs live here, so the tests point here.
 */

export interface ScratchChange {
	name: string;
	light?: string;
	dark?: string;
	media?: string;
}

export interface ScratchSet {
	target: string;
	note?: string;
	updatedAt?: string;
	changes: ScratchChange[];
}

/**
 * Render a scratch set into a CSS string suitable for `tokens.preview()`.
 *
 * The output mirrors what the product's globals.css looks like:
 * - `:root { ... }` for light base tokens
 * - `.dark { ... }` for dark base tokens
 * - `@media (...) { :root { ... } }` for media-scoped light tokens
 * - `@media (...) { .dark { ... } }` for media-scoped dark tokens
 *
 * The selectors match what `scope-token-css.ts` expects so that when
 * the lab scopes this CSS to `.layer`, everything lines up.
 */
export function scratchSetToCss(
	set: ScratchSet,
	lightSelector = ":root",
	darkSelector = ".dark",
): string {
	if (!set.changes || set.changes.length === 0) return "";

	// Bucket changes: base vs media, light vs dark
	const baseLight: Array<{ name: string; value: string }> = [];
	const baseDark: Array<{ name: string; value: string }> = [];
	const mediaLight = new Map<string, Array<{ name: string; value: string }>>();
	const mediaDark = new Map<string, Array<{ name: string; value: string }>>();

	for (const c of set.changes) {
		const mediaKey = typeof c.media === "string" ? c.media.trim() : "";

		if (mediaKey) {
			if (c.light !== undefined) {
				if (!mediaLight.has(mediaKey)) mediaLight.set(mediaKey, []);
				mediaLight.get(mediaKey)!.push({ name: c.name, value: c.light });
			}
			if (c.dark !== undefined) {
				if (!mediaDark.has(mediaKey)) mediaDark.set(mediaKey, []);
				mediaDark.get(mediaKey)!.push({ name: c.name, value: c.dark });
			}
		} else {
			if (c.light !== undefined) {
				baseLight.push({ name: c.name, value: c.light });
			}
			if (c.dark !== undefined) {
				baseDark.push({ name: c.name, value: c.dark });
			}
		}
	}

	const blocks: string[] = [];

	if (baseLight.length > 0) {
		const decls = baseLight.map((d) => `\t${d.name}: ${d.value};`).join("\n");
		blocks.push(`${lightSelector} {\n${decls}\n}`);
	}

	if (baseDark.length > 0) {
		const decls = baseDark.map((d) => `\t${d.name}: ${d.value};`).join("\n");
		blocks.push(`${darkSelector} {\n${decls}\n}`);
	}

	// Collect all media keys and sort for deterministic output
	const allMediaKeys = new Set<string>();
	for (const k of mediaLight.keys()) allMediaKeys.add(k);
	for (const k of mediaDark.keys()) allMediaKeys.add(k);
	const sortedMediaKeys = [...allMediaKeys].sort();

	for (const mk of sortedMediaKeys) {
		const innerBlocks: string[] = [];
		const lightEntries = mediaLight.get(mk);
		if (lightEntries && lightEntries.length > 0) {
			const decls = lightEntries.map((d) => `\t\t${d.name}: ${d.value};`).join("\n");
			innerBlocks.push(`\t${lightSelector} {\n${decls}\n\t}`);
		}
		const darkEntries = mediaDark.get(mk);
		if (darkEntries && darkEntries.length > 0) {
			const decls = darkEntries.map((d) => `\t\t${d.name}: ${d.value};`).join("\n");
			innerBlocks.push(`\t${darkSelector} {\n${decls}\n\t}`);
		}
		if (innerBlocks.length > 0) {
			blocks.push(`@media ${mk} {\n${innerBlocks.join("\n")}\n}`);
		}
	}

	return blocks.join("\n");
}
