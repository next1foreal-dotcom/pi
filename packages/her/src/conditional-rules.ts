import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TurnNarrativeSection } from "./lib/injection-ledger.ts";

const MAX_RULE_BYTES = 32 * 1024;
const sessionRules = new Map<string, { root: string; rules: Map<string, string> }>();

function referencedPaths(prompt: string): string[] {
	return prompt.match(/(?:[A-Za-z]:)?(?:[\\/][^"'`\s:;,]+)+|(?:[\w.@()_-]+[\\/])+[\w.@()_-]+/g) ?? [];
}

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function existingDirectory(candidate: string): Promise<string | undefined> {
	let current = candidate;
	for (;;) {
		try {
			const info = await stat(current);
			return info.isDirectory() ? current : dirname(current);
		} catch {
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}
}

export async function loadConditionalRules(input: {
	cwd: string;
	prompt: string;
	sessionId: string;
}): Promise<TurnNarrativeSection[]> {
	const root = await realpath(input.cwd);
	const previous = sessionRules.get(input.sessionId);
	const cached = previous?.root === root ? previous.rules : new Map<string, string>();
	for (const reference of referencedPaths(input.prompt)) {
		const raw = reference.replace(/^[("'`]+|[)"'`,.;:]+$/g, "");
		const candidate = await existingDirectory(resolve(root, raw));
		if (!candidate) continue;
		const directory = await realpath(candidate);
		if (!isWithin(root, directory)) continue;
		for (let current = directory; current !== root && isWithin(root, current); current = dirname(current)) {
			const rulePath = resolve(current, "AGENTS.md");
			if (cached.has(rulePath)) continue;
			try {
				const info = await stat(rulePath);
				if (!info.isFile() || info.size > MAX_RULE_BYTES) continue;
				cached.set(rulePath, (await readFile(rulePath, "utf8")).trim());
			} catch {
				// No nested rule at this level.
			}
		}
	}
	sessionRules.set(input.sessionId, { root, rules: cached });
	return [...cached.entries()]
		.sort(([left], [right]) => left.split(/[\\/]/).length - right.split(/[\\/]/).length || left.localeCompare(right))
		.map(([source, content]) => ({
			source,
			content: `## Conditional rules: ${relative(root, source).replaceAll("\\", "/")}\n\n${content}`,
		}));
}

export function clearConditionalRules(sessionId?: string): void {
	if (sessionId) sessionRules.delete(sessionId);
	else sessionRules.clear();
}
