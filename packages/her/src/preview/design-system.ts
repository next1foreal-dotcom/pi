import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";

const DEFAULT_TARGET = "samantha-ui";
const DISCIPLINE =
	"These are the values the product actually ships. Design with them — do not invent a colour, radius or easing. If you need a role that does not exist yet, say why it must exist before you add it.";
const GIT_HEAD_TIMEOUT_MS = 8_000;
const PRODUCT_CSS_REL = "packages/design-lab/src/tokens/product.css";

const TARGETS = {
	"samantha-ui": {
		cssPath: ["..", "samantha-ui", "src", "app", "globals.css"],
		repoDir: ["..", "samantha-ui"],
		light: ":root",
		dark: ".dark",
	},
} as const;

type TargetName = keyof typeof TARGETS;

export interface DesignSystemDeps {
	repoRoot?: string;
	now?: () => string;
	readSource?: (absPath: string) => Promise<string>;
	headOf?: (repoDir: string) => Promise<string | undefined>;
}

export function registerDesignSystemTools(pi: ExtensionAPI, deps: DesignSystemDeps = {}): void {
	const repoRoot = deps.repoRoot ?? SAMANTHA_REPO_ROOT;
	const now = deps.now ?? (() => new Date().toISOString());
	const readSource = deps.readSource ?? defaultReadSource;
	const headOf = deps.headOf ?? defaultHeadOf;

	pi.registerTool({
		name: "design_system_load",
		label: "Design System Load",
		description:
			"Load the product's real design tokens before you draw. " +
			"These are the values the product actually ships — not a palette you invent for the screen. " +
			"Writes tokens.md, tokens.css, a receipt, and a copy into the design lab.",
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

			const iso = now();
			const sourceHead = await headOf(join(repoRoot, ...spec.repoDir));
			const headLabel = sourceHead ?? "no-git-head";
			const mdRel = `design/system/${target}/tokens.md`;
			const cssRel = `design/system/${target}/tokens.css`;
			const receiptRel = `design/system/${target}/receipt.json`;
			const mdText = renderMd(target, sourcePath, headLabel, iso, docCommentBefore(css, spec.light), light, dark);
			const cssText = renderCss(sourcePath, headLabel, iso, light, dark);
			const receiptText = `${JSON.stringify(
				{
					target,
					sourcePath,
					sourceHead: sourceHead ?? null,
					loadedAt: iso,
					tokenCount: { light: light.size, dark: dark.size },
				},
				null,
				"\t",
			)}\n`;

			await writeRel(repoRoot, mdRel, mdText);
			await writeRel(repoRoot, cssRel, cssText);
			await writeRel(repoRoot, receiptRel, receiptText);
			await writeRel(repoRoot, PRODUCT_CSS_REL, cssText);

			return textResult(
				`Loaded ${light.size} light and ${dark.size} dark tokens.\n` +
					`Wrote ${mdRel}, ${cssRel}, ${receiptRel}, and ${PRODUCT_CSS_REL}.\n` +
					DISCIPLINE,
				{ ok: true, paths: [mdRel, cssRel, receiptRel, PRODUCT_CSS_REL] },
			);
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
	return before.slice(open);
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

interface CssRule {
	selector: string;
	body: string;
}

function tokensFor(css: string, wanted: string): Map<string, string> {
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
		out.push({ name: match[1]!, value: match[2]!.trim() });
		match = re.exec(src);
	}
	return out;
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
	return `${lines.join("\n")}\n`;
}

function renderCss(
	sourcePath: string,
	headLabel: string,
	iso: string,
	light: Map<string, string>,
	dark: Map<string, string>,
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
	return `${lines.join("\n")}\n`;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}
