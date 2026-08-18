import { ANCHOR_PATHS, SELFMOD_ALLOWED_PATHS_V1 } from "./selfmod-types.ts";

export function normalizeSelfmodPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export function hitsPathPrefix(path: string, prefixes: readonly string[]): boolean {
	const normalized = normalizeSelfmodPath(path);
	return prefixes.some((prefix) => {
		const needle = prefix.toLowerCase();
		return normalized === needle || normalized.startsWith(needle);
	});
}

export function isSelfmodAnchorPath(path: string): boolean {
	return hitsPathPrefix(path, ANCHOR_PATHS);
}

export function isSelfmodAllowedPath(path: string): boolean {
	return hitsPathPrefix(path, SELFMOD_ALLOWED_PATHS_V1);
}

export function disallowedTargetPaths(paths: string[]): string[] {
	return paths.filter((path) => !isSelfmodAllowedPath(path));
}

export function classifyDiffPaths(paths: string[]): { allowlistViolations: string[]; anchorHits: string[] } {
	const allowlistViolations: string[] = [];
	const anchorHits: string[] = [];
	for (const path of paths) {
		if (isSelfmodAnchorPath(path)) anchorHits.push(path);
		if (!isSelfmodAllowedPath(path)) allowlistViolations.push(path);
	}
	return { allowlistViolations, anchorHits };
}
