import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";

export const DEFAULT_TARGET = "samantha-ui";
const DISCIPLINE =
	"These are the values the product actually ships. Design with them — do not invent a colour, radius or easing. If you need a role that does not exist yet, say why it must exist before you add it.";
const GIT_HEAD_TIMEOUT_MS = 8_000;
const PRODUCT_CSS_REL = "packages/design-lab/src/tokens/product.css";

export const TARGETS = {
	"samantha-ui": {
		cssPath: ["..", "samantha-ui", "src", "app", "globals.css"],
		repoDir: ["..", "samantha-ui"],
		light: ":root",
		dark: ".dark",
	},
} as const;

export type TargetName = keyof typeof TARGETS;

/** Breakpoint-scoped token values, keyed by the raw media condition string. */
export type MediaTokens = Map<string, Map<string, string>>;

export interface DesignSystemDeps {
	repoRoot?: string;
	now?: () => string;
	readSource?: (absPath: string) => Promise<string>;
	writeSource?: (absPath: string, content: string) => Promise<void>;
	headOf?: (repoDir: string) => Promise<string | undefined>;
	/** Override for usage-scan root (defaults to <repoRoot>/../samantha-ui). */
	usageScanRoot?: string;
}

export function registerDesignSystemTools(pi: ExtensionAPI, deps: DesignSystemDeps = {}): void {
	const repoRoot = deps.repoRoot ?? SAMANTHA_REPO_ROOT;
	const now = deps.now ?? (() => new Date().toISOString());
	const readSource = deps.readSource ?? defaultReadSource;
	const headOf = deps.headOf ?? defaultHeadOf;
	const writeSource = deps.writeSource ?? defaultWriteSource;

	pi.registerTool({
		name: "design_system_load",
		label: "Design System Load",
		description:
			"Load the product's real design tokens before you draw. " +
			"These are the values the product actually ships — not a palette you invent for the screen. " +
			"Writes tokens.md, tokens.css, a receipt, a snapshot, and a copy into the design lab.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: 'design system to load; default "samantha-ui"' })),
		}),
		async execute(_toolCallId, params) {
			const raw = typeof params.target === "string" ? params.target.trim() : "";
			const target = raw || DEFAULT_TARGET;
			const spec = TARGETS[target as TargetName];
			if (!spec) {
				return textResult(`Unknown target "${target}". Known targets: ${Object.keys(TARGETS).join(", ")}.`, {
					ok: false,
				});
			}

			const sourcePath = spec.cssPath.join("/");
			const absCss = join(repoRoot, ...spec.cssPath);
			let css: string;
			try {
				css = await readSource(absCss);
			} catch {
				return textResult(`No design-system CSS at ${absCss}.`, { ok: false });
			}

			const light = tokensFor(css, spec.light);
			const dark = tokensFor(css, spec.dark);
			if (light.size === 0 || dark.size === 0) {
				return textResult(
					`Refusing: light has ${light.size} tokens, dark has ${dark.size}. 半套主题不是一个设计系统.`,
					{ ok: false },
				);
			}

			const mediaLight = tokensForMedia(css, spec.light);
			const mediaDark = tokensForMedia(css, spec.dark);

			const usageScanDir = deps.usageScanRoot ?? join(repoRoot, ...spec.repoDir);
			const usage = await scanTokenUsage(usageScanDir, light, dark);

			const iso = now();
			const sourceHead = await headOf(join(repoRoot, ...spec.repoDir));
			const headLabel = sourceHead ?? "no-git-head";
			const mdRel = `design/system/${target}/tokens.md`;
			const cssRel = `design/system/${target}/tokens.css`;
			const receiptRel = `design/system/${target}/receipt.json`;
			const snapshotRel = `design/system/${target}/snapshot.css`;
			const mdText = renderMd(
				target,
				sourcePath,
				headLabel,
				iso,
				docCommentBefore(css, spec.light),
				light,
				dark,
				mediaLight,
				mediaDark,
			);
			const cssText = renderCss(sourcePath, headLabel, iso, light, dark, mediaLight, mediaDark);
			const receiptText = `${JSON.stringify(
				{
					target,
					sourcePath,
					sourceHead: sourceHead ?? null,
					loadedAt: iso,
					tokenCount: { light: light.size, dark: dark.size },
					mediaBreakpoints: mergeMediaKeys(mediaLight, mediaDark),
					usage,
				},
				null,
				"\t",
			)}\n`;

			await writeRel(repoRoot, mdRel, mdText);
			await writeRel(repoRoot, cssRel, cssText);
			await writeRel(repoRoot, receiptRel, receiptText);
			await writeRel(repoRoot, snapshotRel, css);
			await writeRel(repoRoot, PRODUCT_CSS_REL, cssText);

			const mediaSummary =
				mediaLight.size + mediaDark.size > 0
					? ` ${mergeMediaKeys(mediaLight, mediaDark).length} breakpoint group(s).`
					: "";

			return textResult(
				`Loaded ${light.size} light and ${dark.size} dark tokens.${mediaSummary}\n` +
					`Wrote ${mdRel}, ${cssRel}, ${receiptRel}, ${snapshotRel}, and ${PRODUCT_CSS_REL}.\n` +
					DISCIPLINE,
				{ ok: true, paths: [mdRel, cssRel, receiptRel, snapshotRel, PRODUCT_CSS_REL] },
			);
		},
	});

	pi.registerTool({
		name: "design_system_apply",
		label: "Design System Apply",
		description:
			"Write token changes back to the product's globals.css. " +
			"This modifies the actual source code — not a preview. " +
			"Only tokens that design_system_load can read are accepted; " +
			"unknown names reject the entire write. " +
			"Changes can target a specific breakpoint via the media field " +
			"(the exact media condition string, e.g. '(min-width: 768px)'). " +
			"For preview-only changes, use window.lab.tokens.preview.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: 'target project; default "samantha-ui"' })),
			changes: Type.Array(
				Type.Object({
					name: Type.String({ description: "CSS custom property name, e.g. --background" }),
					light: Type.Optional(Type.String({ description: "new value for the light-mode declaration" })),
					dark: Type.Optional(Type.String({ description: "new value for the dark-mode declaration" })),
					media: Type.Optional(
						Type.String({
							description:
								"media condition to target, e.g. '(min-width: 768px)'. Omit for the base (non-media) block.",
						}),
					),
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const raw = typeof params.target === "string" ? params.target.trim() : "";
			const target = raw || DEFAULT_TARGET;
			const spec = TARGETS[target as TargetName];
			if (!spec) {
				return textResult(`Unknown target "${target}". Known targets: ${Object.keys(TARGETS).join(", ")}.`, {
					ok: false,
				});
			}

			const changes = params.changes as Array<{
				name: string;
				light?: string;
				dark?: string;
				media?: string;
			}>;
			if (!changes || changes.length === 0) {
				return textResult("No changes provided.", { ok: false });
			}

			const absCss = join(repoRoot, ...spec.cssPath);
			let css: string;
			try {
				css = await readSource(absCss);
			} catch {
				return textResult(`Cannot read ${absCss}. The file may not exist.`, { ok: false });
			}

			const knownLight = tokensFor(css, spec.light);
			const knownDark = tokensFor(css, spec.dark);
			const knownMediaLight = tokensForMedia(css, spec.light);
			const knownMediaDark = tokensForMedia(css, spec.dark);

			const unknowns: string[] = [];
			for (const change of changes) {
				const mediaKey = typeof change.media === "string" ? change.media.trim() : "";
				if (mediaKey) {
					if (change.light !== undefined) {
						const mediaMap = knownMediaLight.get(mediaKey);
						if (!mediaMap || !mediaMap.has(change.name)) {
							if (!unknowns.includes(`${change.name} @media ${mediaKey} (light)`))
								unknowns.push(`${change.name} @media ${mediaKey} (light)`);
						}
					}
					if (change.dark !== undefined) {
						const mediaMap = knownMediaDark.get(mediaKey);
						if (!mediaMap || !mediaMap.has(change.name)) {
							if (!unknowns.includes(`${change.name} @media ${mediaKey} (dark)`))
								unknowns.push(`${change.name} @media ${mediaKey} (dark)`);
						}
					}
				} else {
					if (change.light !== undefined && !knownLight.has(change.name)) {
						if (!unknowns.includes(change.name)) unknowns.push(change.name);
					}
					if (change.dark !== undefined && !knownDark.has(change.name)) {
						if (!unknowns.includes(change.name)) unknowns.push(change.name);
					}
				}
			}

			if (unknowns.length > 0) {
				return textResult(
					`Refused: these tokens do not exist in ${target} globals.css:\n` +
						unknowns.map((n) => `  • ${n}`).join("\n") +
						"\n\nAdding a new token is a product decision. Add it to globals.css by hand first.",
					{ ok: false, unknowns },
				);
			}

			let modified = css;
			const allApplied: Array<{ name: string; side: string; before: string; after: string }> = [];

			// Group changes: base changes (no media) and per-media changes
			const baseLightPatches = new Map<string, string>();
			const baseDarkPatches = new Map<string, string>();
			const mediaLightPatches = new Map<string, Map<string, string>>();
			const mediaDarkPatches = new Map<string, Map<string, string>>();

			for (const change of changes) {
				const mediaKey = typeof change.media === "string" ? change.media.trim() : "";
				if (mediaKey) {
					if (change.light !== undefined) {
						if (!mediaLightPatches.has(mediaKey)) mediaLightPatches.set(mediaKey, new Map());
						mediaLightPatches.get(mediaKey)!.set(change.name, change.light);
					}
					if (change.dark !== undefined) {
						if (!mediaDarkPatches.has(mediaKey)) mediaDarkPatches.set(mediaKey, new Map());
						mediaDarkPatches.get(mediaKey)!.set(change.name, change.dark);
					}
				} else {
					if (change.light !== undefined) baseLightPatches.set(change.name, change.light);
					if (change.dark !== undefined) baseDarkPatches.set(change.name, change.dark);
				}
			}

			if (baseLightPatches.size > 0) {
				const result = patchSelectorBlock(modified, spec.light, baseLightPatches);
				if (typeof result === "string") return textResult(result, { ok: false });
				modified = result.css;
				for (const a of result.applied) allApplied.push({ ...a, side: "light" });
			}

			if (baseDarkPatches.size > 0) {
				const result = patchSelectorBlock(modified, spec.dark, baseDarkPatches);
				if (typeof result === "string") return textResult(result, { ok: false });
				modified = result.css;
				for (const a of result.applied) allApplied.push({ ...a, side: "dark" });
			}

			for (const [mediaKey, patches] of mediaLightPatches) {
				const result = patchMediaSelectorBlock(modified, mediaKey, spec.light, patches);
				if (typeof result === "string") return textResult(result, { ok: false });
				modified = result.css;
				for (const a of result.applied) allApplied.push({ ...a, side: `light @media ${mediaKey}` });
			}

			for (const [mediaKey, patches] of mediaDarkPatches) {
				const result = patchMediaSelectorBlock(modified, mediaKey, spec.dark, patches);
				if (typeof result === "string") return textResult(result, { ok: false });
				modified = result.css;
				for (const a of result.applied) allApplied.push({ ...a, side: `dark @media ${mediaKey}` });
			}

			try {
				await writeSource(absCss, modified);
			} catch (e) {
				return textResult(`Failed to write ${absCss}: ${e instanceof Error ? e.message : String(e)}`, {
					ok: false,
				});
			}

			const lines = [`Applied ${allApplied.length} change(s) to ${target} globals.css.\n`];
			for (const a of allApplied) {
				lines.push(`${a.name}: ${a.before} → ${a.after} (${a.side})`);
			}
			lines.push("", "⚠️ This modified the product source code. Preview-only changes use window.lab.tokens.preview.");

			return textResult(lines.join("\n"), { ok: true, applied: allApplied });
		},
	});

	pi.registerTool({
		name: "design_system_review",
		label: "Design System Review",
		description:
			"Compare the product's current CSS against the snapshot saved at the last design_system_load. " +
			"Reports which tokens changed, were added, or disappeared — without accepting any of them. " +
			"Product-side changes may be intentional or accidental; this tool only reports. " +
			"To accept the current state, run design_system_load again.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: 'target project; default "samantha-ui"' })),
		}),
		async execute(_toolCallId, params) {
			const raw = typeof params.target === "string" ? params.target.trim() : "";
			const target = raw || DEFAULT_TARGET;
			const spec = TARGETS[target as TargetName];
			if (!spec) {
				return textResult(`Unknown target "${target}". Known targets: ${Object.keys(TARGETS).join(", ")}.`, {
					ok: false,
				});
			}

			const snapshotRel = `design/system/${target}/snapshot.css`;
			const absSnapshot = join(repoRoot, ...snapshotRel.split("/"));
			let snapshotCss: string;
			try {
				snapshotCss = await readSource(absSnapshot);
			} catch {
				return textResult(
					`No snapshot found at ${snapshotRel}. Run design_system_load first to create a baseline.`,
					{ ok: false, reason: "no-snapshot" },
				);
			}

			const absCss = join(repoRoot, ...spec.cssPath);
			let currentCss: string;
			try {
				currentCss = await readSource(absCss);
			} catch {
				return textResult(`Cannot read ${absCss}. The file may not exist.`, { ok: false });
			}

			const oldLight = tokensFor(snapshotCss, spec.light);
			const oldDark = tokensFor(snapshotCss, spec.dark);
			const newLight = tokensFor(currentCss, spec.light);
			const newDark = tokensFor(currentCss, spec.dark);

			const diffs: Array<{ name: string; side: string; type: string; old?: string; new?: string }> = [];

			diffMaps(oldLight, newLight, "light", diffs);
			diffMaps(oldDark, newDark, "dark", diffs);

			if (diffs.length === 0) {
				return textResult(`No token changes in ${target} since the last load.`, { ok: true, changes: [] });
			}

			const lines = [`${diffs.length} token change(s) in ${target} since last load:`];
			for (const d of diffs) {
				if (d.type === "changed") lines.push(`  ${d.name} (${d.side}): ${d.old} → ${d.new}`);
				else if (d.type === "added") lines.push(`  ${d.name} (${d.side}): NEW ${d.new}`);
				else if (d.type === "removed") lines.push(`  ${d.name} (${d.side}): REMOVED (was ${d.old})`);
			}
			lines.push("", "To accept these changes, run design_system_load again.");

			return textResult(lines.join("\n"), { ok: true, changes: diffs });
		},
	});
}

async function defaultReadSource(absPath: string): Promise<string> {
	return await readFile(absPath, "utf8");
}

function defaultHeadOf(repoDir: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["rev-parse", "HEAD"],
			{ cwd: repoDir, timeout: GIT_HEAD_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
			(error, stdout) => {
				if (error) {
					resolve(undefined);
					return;
				}
				const head = stdout.trim();
				resolve(head || undefined);
			},
		);
	});
}

async function defaultWriteSource(absPath: string, content: string): Promise<void> {
	await writeFile(absPath, content);
}

async function writeRel(repoRoot: string, rel: string, contents: string): Promise<void> {
	const abs = join(repoRoot, ...rel.split("/"));
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, contents);
}

/**
 * The paragraph a product writes directly above its own token block is the design
 * system; the values under it are only numbers. A shipped globals.css opens with
 * @import lines, so "comment at the top of the file" would miss that paragraph
 * every time — anchor on the selector instead.
 */
function docCommentBefore(css: string, selector: string): string | undefined {
	const ruleStart = findSelectorRule(css, selector);
	if (ruleStart < 0) return undefined;
	const before = trimTrailingWhitespace(css.slice(0, ruleStart));
	if (!before.endsWith("*/")) return undefined;
	const open = before.lastIndexOf("/*");
	if (open < 0) return undefined;
	// The source may be CRLF; a generated artifact should not inherit that.
	return stripCarriageReturns(before.slice(open));
}

/** Index of the start of the line on which `selector {` opens, or -1. */
function findSelectorRule(css: string, selector: string): number {
	let from = 0;
	for (;;) {
		const hit = css.indexOf(selector, from);
		if (hit < 0) return -1;
		const lineStart = css.lastIndexOf("\n", hit) + 1;
		let after = hit + selector.length;
		while (after < css.length && (css[after] === " " || css[after] === "\t")) after++;
		if (css.slice(lineStart, hit).trim() === "" && css[after] === "{") return lineStart;
		from = hit + selector.length;
	}
}

function trimTrailingWhitespace(value: string): string {
	let end = value.length;
	while (end > 0 && /\s/.test(value[end - 1]!)) end--;
	return value.slice(0, end);
}
function stripCarriageReturns(value: string): string {
	let out = "";
	for (const ch of value) {
		if (ch !== "\r") out += ch;
	}
	return out;
}

interface CssRule {
	selector: string;
	body: string;
}

export function tokensFor(css: string, wanted: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const rule of collectRules(stripComments(css))) {
		if (!selectorListContains(rule.selector, wanted)) continue;
		for (const { name, value } of customProperties(rule.body)) {
			map.set(name, value);
		}
	}
	return map;
}

function collectRules(src: string, into: CssRule[] = []): CssRule[] {
	parseTopLevel(src, (rule) => {
		into.push(rule);
		collectRules(rule.body, into);
	});
	return into;
}

function parseTopLevel(src: string, onRule: (rule: CssRule) => void): void {
	let i = 0;
	const n = src.length;
	while (i < n) {
		while (i < n && /\s/.test(src[i]!)) i++;
		if (i >= n) break;
		const preludeStart = i;
		let inStr: string | undefined;
		let paren = 0;
		let handled = false;
		while (i < n) {
			const c = src[i]!;
			if (inStr) {
				if (c === "\\") {
					i += 2;
					continue;
				}
				if (c === inStr) inStr = undefined;
				i++;
				continue;
			}
			if (c === '"' || c === "'") {
				inStr = c;
				i++;
				continue;
			}
			if (c === "(") {
				paren++;
				i++;
				continue;
			}
			if (c === ")") {
				paren = Math.max(0, paren - 1);
				i++;
				continue;
			}
			if (paren === 0 && c === ";") {
				i++;
				handled = true;
				break;
			}
			if (paren === 0 && c === "{") {
				const selector = src.slice(preludeStart, i).trim();
				const block = readBlock(src, i);
				onRule({ selector, body: block.body });
				i = block.end;
				handled = true;
				break;
			}
			i++;
		}
		if (!handled) break;
	}
}

function readBlock(src: string, openIndex: number): { body: string; end: number } {
	let i = openIndex + 1;
	let depth = 1;
	let inStr: string | undefined;
	while (i < src.length && depth > 0) {
		const c = src[i]!;
		if (inStr) {
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === inStr) inStr = undefined;
			i++;
			continue;
		}
		if (c === '"' || c === "'") {
			inStr = c;
			i++;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) break;
		}
		i++;
	}
	return { body: src.slice(openIndex + 1, i), end: i < src.length ? i + 1 : i };
}

function selectorListContains(selectorList: string, wanted: string): boolean {
	if (selectorList.startsWith("@")) return false;
	return splitSelectors(selectorList).some((sel) => sel === wanted);
}

function splitSelectors(list: string): string[] {
	const parts: string[] = [];
	let current = "";
	let depth = 0;
	for (const c of list) {
		if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
		else if (c === "," && depth === 0) {
			const trimmed = current.trim();
			if (trimmed) parts.push(trimmed);
			current = "";
			continue;
		}
		current += c;
	}
	const trimmed = current.trim();
	if (trimmed) parts.push(trimmed);
	return parts;
}

function customProperties(body: string): Array<{ name: string; value: string }> {
	const src = withoutNestedBlocks(body);
	const out: Array<{ name: string; value: string }> = [];
	const re = /(--[A-Za-z_0-9-]+)\s*:\s*([^;]*);/g;
	let match = re.exec(src);
	while (match) {
		out.push({ name: match[1]!, value: foldValue(match[2]!) });
		match = re.exec(src);
	}
	return out;
}

/**
 * A value wrapped across lines is still one value. Carried through with its raw
 * newline it snaps a markdown table row in half, and a CRLF source drags CR into
 * generated files. Fold the wrap; leave spacing inside a line alone.
 */
function foldValue(value: string): string {
	let out = "";
	let pendingSpace = false;
	for (const ch of value) {
		if (ch === "\r") continue;
		if (ch === "\n") {
			pendingSpace = out.length > 0;
			continue;
		}
		if (pendingSpace) {
			if (ch === " " || ch === "\t") continue;
			out += " ";
			pendingSpace = false;
		}
		out += ch;
	}
	return out.trim();
}

function withoutNestedBlocks(body: string): string {
	let out = "";
	let i = 0;
	let inStr: string | undefined;
	while (i < body.length) {
		const c = body[i]!;
		if (inStr) {
			out += c;
			if (c === "\\") {
				if (i + 1 < body.length) {
					out += body[i + 1]!;
					i += 2;
					continue;
				}
			}
			if (c === inStr) inStr = undefined;
			i++;
			continue;
		}
		if (c === '"' || c === "'") {
			inStr = c;
			out += c;
			i++;
			continue;
		}
		if (c === "{") {
			i = readBlock(body, i).end;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function stripComments(css: string): string {
	let out = "";
	let i = 0;
	let inStr: string | undefined;
	while (i < css.length) {
		const c = css[i]!;
		if (inStr) {
			out += c;
			if (c === "\\") {
				if (i + 1 < css.length) {
					out += css[i + 1]!;
					i += 2;
					continue;
				}
			}
			if (c === inStr) inStr = undefined;
			i++;
			continue;
		}
		if (c === '"' || c === "'") {
			inStr = c;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && css[i + 1] === "*") {
			const end = css.indexOf("*/", i + 2);
			if (end < 0) break;
			i = end + 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function renderMd(
	target: string,
	sourcePath: string,
	headLabel: string,
	iso: string,
	leading: string | undefined,
	light: Map<string, string>,
	dark: Map<string, string>,
	mediaLight: MediaTokens = new Map(),
	mediaDark: MediaTokens = new Map(),
): string {
	const lines = [`# ${target} design system`, "", `Source: ${sourcePath} @ ${headLabel}`, `Loaded: ${iso}`, ""];
	if (leading) {
		lines.push(leading, "");
	}
	lines.push("| token | light | dark |", "| --- | --- | --- |");
	const names: string[] = [...light.keys()];
	for (const name of dark.keys()) {
		if (!light.has(name)) names.push(name);
	}
	for (const name of names) {
		lines.push(`| ${name} | ${light.get(name) ?? "—"} | ${dark.get(name) ?? "—"} |`);
	}
	const mediaKeys = mergeMediaKeys(mediaLight, mediaDark);
	for (const media of mediaKeys) {
		const ml = mediaLight.get(media) ?? new Map<string, string>();
		const md = mediaDark.get(media) ?? new Map<string, string>();
		lines.push("", `### @media ${media}`, "", "| token | light | dark |", "| --- | --- | --- |");
		const mNames: string[] = [...ml.keys()];
		for (const n of md.keys()) {
			if (!ml.has(n)) mNames.push(n);
		}
		for (const n of mNames) {
			lines.push(`| ${n} | ${ml.get(n) ?? "—"} | ${md.get(n) ?? "—"} |`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function renderCss(
	sourcePath: string,
	headLabel: string,
	iso: string,
	light: Map<string, string>,
	dark: Map<string, string>,
	mediaLight: MediaTokens = new Map(),
	mediaDark: MediaTokens = new Map(),
): string {
	const lines = [
		`/* Generated by design_system_load from ${sourcePath} @ ${headLabel} at ${iso}. Do not hand-edit. */`,
		":root {",
	];
	for (const [name, value] of light) {
		lines.push(`\t${name}: ${value};`);
	}
	lines.push("}", ".dark {");
	for (const [name, value] of dark) {
		lines.push(`\t${name}: ${value};`);
	}
	lines.push("}");
	const mediaKeys = mergeMediaKeys(mediaLight, mediaDark);
	for (const media of mediaKeys) {
		const ml = mediaLight.get(media) ?? new Map<string, string>();
		const md = mediaDark.get(media) ?? new Map<string, string>();
		lines.push(`@media ${media} {`);
		if (ml.size > 0) {
			lines.push("\t:root {");
			for (const [name, value] of ml) lines.push(`\t\t${name}: ${value};`);
			lines.push("\t}");
		}
		if (md.size > 0) {
			lines.push("\t.dark {");
			for (const [name, value] of md) lines.push(`\t\t${name}: ${value};`);
			lines.push("\t}");
		}
		lines.push("}");
	}
	return `${lines.join("\n")}\n`;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

interface DeclSpan {
	valueStart: number;
	valueEnd: number;
	before: string;
}

export function patchSelectorBlock(
	css: string,
	selector: string,
	patches: Map<string, string>,
): { css: string; applied: Array<{ name: string; before: string; after: string }> } | string {
	const ruleStart = findSelectorRule(css, selector);
	if (ruleStart < 0) return `Cannot find ${selector} block in CSS.`;

	const braceIdx = css.indexOf("{", ruleStart);
	if (braceIdx < 0) return `Cannot find opening brace for ${selector}.`;

	const block = readBlock(css, braceIdx);
	const bodyStart = braceIdx + 1;
	const bodyEnd = block.end - 1;
	const body = css.slice(bodyStart, bodyEnd);

	const decls = scanDeclarations(body, new Set(patches.keys()));

	const missing: string[] = [];
	for (const name of patches.keys()) {
		if (!decls.has(name)) missing.push(name);
	}
	if (missing.length > 0) {
		return `Cannot locate declarations in ${selector}: ${missing.join(", ")}`;
	}

	const entries = [...decls.entries()].sort((a, b) => b[1].valueStart - a[1].valueStart);
	let newBody = body;
	const applied: Array<{ name: string; before: string; after: string }> = [];

	for (const [name, decl] of entries) {
		const newValue = patches.get(name)!;
		newBody = `${newBody.slice(0, decl.valueStart)} ${newValue}${newBody.slice(decl.valueEnd)}`;
		applied.push({ name, before: decl.before, after: newValue });
	}

	return {
		css: css.slice(0, bodyStart) + newBody + css.slice(bodyEnd),
		applied,
	};
}

function scanDeclarations(body: string, wanted: Set<string>): Map<string, DeclSpan> {
	const found = new Map<string, DeclSpan>();
	let i = 0;
	while (i < body.length) {
		if (body[i] === "/" && i + 1 < body.length && body[i + 1] === "*") {
			const close = body.indexOf("*/", i + 2);
			i = close < 0 ? body.length : close + 2;
			continue;
		}
		if (body[i] === "{") {
			const nested = readBlock(body, i);
			i = nested.end;
			continue;
		}
		if (body[i] === "-" && i + 1 < body.length && body[i + 1] === "-") {
			const nameStart = i;
			let j = i + 2;
			while (j < body.length && /[A-Za-z_0-9-]/.test(body[j]!)) j++;
			const name = body.slice(nameStart, j);
			if (wanted.has(name) && !found.has(name)) {
				let k = j;
				while (k < body.length && (body[k] === " " || body[k] === "\t")) k++;
				if (k < body.length && body[k] === ":") {
					const colonPos = k;
					k++;
					let depth = 0;
					let inStr: string | undefined;
					while (k < body.length) {
						const c = body[k]!;
						if (inStr) {
							if (c === "\\") {
								k += 2;
								continue;
							}
							if (c === inStr) inStr = undefined;
							k++;
							continue;
						}
						if (c === "/" && k + 1 < body.length && body[k + 1] === "*") {
							const close = body.indexOf("*/", k + 2);
							k = close < 0 ? body.length : close + 2;
							continue;
						}
						if (c === '"' || c === "'") {
							inStr = c;
							k++;
							continue;
						}
						if (c === "(" || c === "[") {
							depth++;
							k++;
							continue;
						}
						if (c === ")" || c === "]") {
							depth = Math.max(0, depth - 1);
							k++;
							continue;
						}
						if (c === ";" && depth === 0) break;
						k++;
					}
					if (k < body.length && body[k] === ";") {
						found.set(name, {
							valueStart: colonPos + 1,
							valueEnd: k,
							before: foldValue(body.slice(colonPos + 1, k)),
						});
					}
				}
			}
			i = Math.max(i + 1, j);
			continue;
		}
		i++;
	}
	return found;
}

/**
 * Extract tokens declared inside `@media (...) { selector { --x: y; } }` blocks.
 * Returns a map of media-condition-string → Map<tokenName, value>.
 */
export function tokensForMedia(css: string, wanted: string): MediaTokens {
	const result: MediaTokens = new Map();
	const stripped = stripComments(css);
	for (const rule of collectRules(stripped)) {
		if (!rule.selector.startsWith("@media")) continue;
		const condition = extractMediaCondition(rule.selector);
		if (!condition) continue;
		// Look inside the @media body for rules matching the wanted selector
		for (const inner of collectRules(rule.body)) {
			if (!selectorListContains(inner.selector, wanted)) continue;
			const props = customProperties(inner.body);
			if (props.length === 0) continue;
			if (!result.has(condition)) result.set(condition, new Map());
			const map = result.get(condition)!;
			for (const { name, value } of props) {
				map.set(name, value);
			}
		}
	}
	return result;
}

function extractMediaCondition(selector: string): string | undefined {
	const match = /^@media\s+(.+)$/s.exec(selector.trim());
	return match?.[1]?.trim() || undefined;
}

/**
 * Patch a selector block that lives inside a specific @media rule.
 */
export function patchMediaSelectorBlock(
	css: string,
	mediaCondition: string,
	selector: string,
	patches: Map<string, string>,
): { css: string; applied: Array<{ name: string; before: string; after: string }> } | string {
	// Find the @media block that has this condition
	let mediaStart = -1;
	let mediaBraceIdx = -1;

	// We need to find the @media block in the ORIGINAL css (not stripped), since we patch original.
	// But the original may have comments. Strategy: search for @media with matching condition.
	let searchFrom = 0;
	while (searchFrom < css.length) {
		const atIdx = css.indexOf("@media", searchFrom);
		if (atIdx < 0) break;

		// Find the opening brace
		let bi = atIdx + 6;
		while (bi < css.length && css[bi] !== "{") bi++;
		if (bi >= css.length) break;

		const rawPrelude = css.slice(atIdx + 6, bi).trim();
		// Compare with stripped comments
		const preludeClean = stripComments(rawPrelude).trim();
		if (preludeClean === mediaCondition) {
			mediaStart = atIdx;
			mediaBraceIdx = bi;
			break;
		}
		searchFrom = bi + 1;
	}

	if (mediaStart < 0 || mediaBraceIdx < 0) {
		return `Cannot find @media ${mediaCondition} block in CSS.`;
	}

	const mediaBlock = readBlock(css, mediaBraceIdx);
	const mediaBodyStart = mediaBraceIdx + 1;
	const mediaBodyEnd = mediaBlock.end - 1;
	const mediaBody = css.slice(mediaBodyStart, mediaBodyEnd);

	// Find the selector block within the media body
	const innerResult = patchSelectorBlock(mediaBody, selector, patches);
	if (typeof innerResult === "string") return innerResult;

	const newMediaBody = innerResult.css;
	return {
		css: css.slice(0, mediaBodyStart) + newMediaBody + css.slice(mediaBodyEnd),
		applied: innerResult.applied,
	};
}

export function mergeMediaKeys(a: MediaTokens, b: MediaTokens): string[] {
	const set = new Set<string>();
	for (const k of a.keys()) set.add(k);
	for (const k of b.keys()) set.add(k);
	return [...set].sort();
}

/**
 * Scan source files under a directory for `var(--name)` references to known tokens.
 * Returns a record of token name → reference count.
 * Only counts direct `var(--name)` usage in .ts, .tsx, .css, and .module.css files.
 */
async function scanTokenUsage(
	scanDir: string,
	light: Map<string, string>,
	dark: Map<string, string>,
): Promise<Record<string, number>> {
	const allTokens = new Set<string>();
	for (const name of light.keys()) allTokens.add(name);
	for (const name of dark.keys()) allTokens.add(name);

	const usage: Record<string, number> = {};
	for (const name of allTokens) usage[name] = 0;

	try {
		const srcDir = join(scanDir, "src");
		await scanDirForUsage(srcDir, allTokens, usage);
	} catch {
		// Directory may not exist (tests use fake roots)
	}
	return usage;
}

async function scanDirForUsage(dir: string, tokens: Set<string>, usage: Record<string, number>): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(full);
		} catch {
			continue;
		}
		if (info.isDirectory()) {
			if (entry === "node_modules" || entry === ".next") continue;
			await scanDirForUsage(full, tokens, usage);
		} else if (/\.(tsx?|css)$/.test(entry)) {
			try {
				const content = await readFile(full, "utf8");
				countVarReferences(content, tokens, usage);
			} catch {
				// skip unreadable files
			}
		}
	}
}

function countVarReferences(content: string, tokens: Set<string>, usage: Record<string, number>): void {
	// Match var(--name) patterns
	const re = /var\(\s*(--[A-Za-z_0-9-]+)/g;
	let match = re.exec(content);
	while (match) {
		const name = match[1]!;
		if (tokens.has(name)) {
			usage[name] = (usage[name] ?? 0) + 1;
		}
		match = re.exec(content);
	}
}

function diffMaps(
	oldMap: Map<string, string>,
	newMap: Map<string, string>,
	side: string,
	diffs: Array<{ name: string; side: string; type: string; old?: string; new?: string }>,
): void {
	for (const [name, oldVal] of oldMap) {
		const newVal = newMap.get(name);
		if (newVal === undefined) {
			diffs.push({ name, side, type: "removed", old: oldVal });
		} else if (newVal !== oldVal) {
			diffs.push({ name, side, type: "changed", old: oldVal, new: newVal });
		}
	}
	for (const [name, newVal] of newMap) {
		if (!oldMap.has(name)) {
			diffs.push({ name, side, type: "added", new: newVal });
		}
	}
}
