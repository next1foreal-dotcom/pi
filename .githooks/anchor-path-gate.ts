import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isAnchorPath } from "../packages/her/src/rsi/anchors.ts";

export function findStagedAnchorPaths(paths: readonly string[]): string[] {
	return paths.filter((path) => isAnchorPath(path));
}

function main(): void {
	const stagedPaths = readFileSync(0).toString("utf8").split("\0").filter(Boolean);
	const anchorPaths = findStagedAnchorPaths(stagedPaths);
	if (anchorPaths.length === 0) return;
	if (process.env.FEI_ANCHOR_OVERRIDE === "1") {
		console.warn("anchor-path-gate override: FEI_ANCHOR_OVERRIDE=1");
		return;
	}
	console.error("anchor-path-gate blocked staged anchor paths:");
	for (const path of anchorPaths) console.error(path);
	process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
