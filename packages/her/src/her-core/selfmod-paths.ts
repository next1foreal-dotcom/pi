import {
	isAllowedSelfModPath,
	isAnchorPath,
	matchesSelfmodPathPrefix,
	normalizeSelfmodBoundaryPath,
} from "../rsi/anchors.ts";
import { SELFMOD_OWNED_SKILLS } from "./selfmod-types.ts";

export function normalizeSelfmodPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export function isUnsafeSelfmodTarget(path: string): boolean {
	return normalizeSelfmodBoundaryPath(path) === undefined;
}

export function hitsPathPrefix(path: string, prefixes: readonly string[]): boolean {
	return matchesSelfmodPathPrefix(path, prefixes);
}

export function isSelfmodAnchorPath(path: string): boolean {
	return isAnchorPath(path);
}

export function isSelfmodAllowedPath(path: string): boolean {
	return isAllowedSelfModPath(path);
}

export function skillDirOf(path: string): string | undefined {
	const normalized = normalizeSelfmodBoundaryPath(path);
	if (normalized === undefined) return undefined;
	const marker = "pi-package/skills/";
	const index = normalized.indexOf(marker);
	if (index < 0) return undefined;
	return normalized.slice(index + marker.length).split("/")[0] || undefined;
}

export function isOwnedSkillPath(path: string): boolean {
	const dir = skillDirOf(path);
	return dir !== undefined && SELFMOD_OWNED_SKILLS.some((name) => name.toLowerCase() === dir);
}

export function disallowedTargetPaths(paths: string[]): string[] {
	return paths.filter((path) => isUnsafeSelfmodTarget(path) || !isSelfmodAllowedPath(path) || !isOwnedSkillPath(path));
}

export function classifyDiffPaths(paths: string[]): { allowlistViolations: string[]; anchorHits: string[] } {
	return {
		allowlistViolations: disallowedTargetPaths(paths),
		anchorHits: paths.filter(isSelfmodAnchorPath),
	};
}
