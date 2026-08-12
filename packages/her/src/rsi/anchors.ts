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
];

// Source: Her-repo/docs/specs/her-rsi-contracts/selfmod.ts.
export const SELFMOD_ALLOWED_PATHS_V1: readonly string[] = ["packages/her/pi-package/skills/"];

const RUNTIME_ANCHOR_PATHS = [...ANCHOR_PATHS, "packages/her/src/rsi/anchors.ts"];

function matchesPathPrefix(path: string, prefixes: readonly string[]): boolean {
	const normalizedPath = path.replaceAll("\\", "/").toLowerCase();
	const packageRelativePath = normalizedPath.startsWith("packages/her/")
		? normalizedPath.slice("packages/her/".length)
		: normalizedPath;
	return prefixes.some((prefix) => {
		const normalizedPrefix = prefix.toLowerCase();
		return normalizedPath.startsWith(normalizedPrefix) || packageRelativePath.startsWith(normalizedPrefix);
	});
}

export function isAnchorPath(path: string): boolean {
	return matchesPathPrefix(path, RUNTIME_ANCHOR_PATHS);
}

export function isAllowedSelfModPath(path: string): boolean {
	return matchesPathPrefix(path, SELFMOD_ALLOWED_PATHS_V1);
}
