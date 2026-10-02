// Source: Her-repo/docs/specs/her-rsi-contracts/selfmod.ts.
export const ANCHOR_PATHS: readonly string[] = [
	"her-memory/narrative/SOUL.md",
	"her-memory/narrative/FACTS.md",
	"her-memory/narrative/CONTEXT.md",
	"her-memory/evals/",
	"packages/her/src/evals.ts",
	"pi-package/policies/",
	".githooks/",
	"her-memory/.env",
	"her-memory/audit/event-history.jsonl",
	"her-memory/audit/event-history.state.json",
];

// Source: Her-repo/docs/specs/her-rsi-contracts/selfmod.ts.
export const SELFMOD_ALLOWED_PATHS_V1: readonly string[] = ["packages/her/pi-package/skills/"];

const RUNTIME_ANCHOR_PATHS = [...ANCHOR_PATHS, "packages/her/src/rsi/anchors.ts"];

/**
 * Canonical repository-relative names only. This is a lexical check, not a
 * filesystem sandbox: the apply layer must separately reject symlink escapes.
 * Preserve the existing case-insensitive policy on all hosts.
 */
export function normalizeSelfmodBoundaryPath(path: string): string | undefined {
	const value = path.replaceAll("\\", "/");
	if (!value || value.startsWith("/") || /[\u0000-\u001f\u007f:]/.test(value)) return undefined;
	const parts = value.split("/").filter((part) => part !== "" && part !== ".");
	if (parts.length === 0) return undefined;
	for (const part of parts) {
		if (part === ".." || /[. ]$/.test(part) || /[<>"|?*]/.test(part)) return undefined;
		// Reject Windows device aliases even when tests run on another platform.
		if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) return undefined;
	}
	return parts.join("/").toLowerCase();
}

export function matchesSelfmodPathPrefix(path: string, prefixes: readonly string[]): boolean {
	const normalized = normalizeSelfmodBoundaryPath(path);
	if (normalized === undefined) return false;
	return prefixes.some((prefix) => {
		const needle = normalizeSelfmodBoundaryPath(prefix);
		if (needle === undefined) return false;
		return prefix.replaceAll("\\", "/").endsWith("/")
			? normalized.startsWith(`${needle}/`)
			: normalized === needle || normalized.startsWith(`${needle}/`);
	});
}

export function isAnchorPath(path: string): boolean {
	const normalized = normalizeSelfmodBoundaryPath(path);
	if (normalized === undefined) return false;
	const packageRelative = normalized.startsWith("packages/her/")
		? normalized.slice("packages/her/".length)
		: normalized;
	return (
		matchesSelfmodPathPrefix(normalized, RUNTIME_ANCHOR_PATHS) ||
		matchesSelfmodPathPrefix(packageRelative, RUNTIME_ANCHOR_PATHS)
	);
}

export function isAllowedSelfModPath(path: string): boolean {
	return matchesSelfmodPathPrefix(path, SELFMOD_ALLOWED_PATHS_V1);
}
