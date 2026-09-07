import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Her design knowledge is only knowledge she can reach. SKILL.md's task table is
 * the whole index — nothing else routes a reference file — so a file the table
 * does not name is a file she never loads, however good it is.
 *
 * Both directions, because each catches a different mistake and neither catches
 * the other's:
 *
 *   a named file that does not exist  -> a rename or a typo, and she reads nothing
 *   a file no row names               -> knowledge parked where nobody looks
 *
 * The second is the one that bit: a rule about matching an existing product was
 * written into `process/tokens-first`, which the "Any new design" row does not
 * load, so it would have sat there being true and never being read. Recording a
 * decision is not the same as wiring it, which this skill's own intake ledger
 * has already had to learn twice.
 */

const SKILL_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "pi-package", "skills", "her-design");
const REFS = join(SKILL_DIR, "references");

/** Every `a/b` path named in a table row, wildcards excluded. */
function namedInTable(): Set<string> {
	const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
	const named = new Set<string>();
	for (const line of skill.split("\n")) {
		if (!line.startsWith("|")) continue;
		for (const m of line.matchAll(/\b[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)+\b/g)) {
			named.add(m[0]);
		}
	}
	return named;
}

function referenceFiles(dir = REFS): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...referenceFiles(full));
		else if (entry.endsWith(".md")) {
			out.push(relative(REFS, full).split(sep).join("/").replace(/\.md$/, ""));
		}
	}
	return out;
}

/**
 * The chart files are routed by prose — "the matching charts/* file(s)" — because
 * which one depends on the chart. That is a real route, so they are not orphans;
 * every other directory has to name its files one by one.
 */
const WILDCARD_PREFIXES = ["charts/"];

test("every file the task table names is really there", () => {
	const onDisk = new Set(referenceFiles());
	const missing = [...namedInTable()].filter((p) => !onDisk.has(p)).sort();
	assert.deepEqual(missing, [], `SKILL.md points at files that do not exist: ${missing.join(", ")}`);
});

test("every reference file is reachable from some row", () => {
	const named = namedInTable();
	const orphans = referenceFiles()
		.filter((p) => !named.has(p))
		.filter((p) => !WILDCARD_PREFIXES.some((prefix) => p.startsWith(prefix)))
		.sort();
	assert.deepEqual(
		orphans,
		[],
		`these carry knowledge no task row loads, so she never reads them: ${orphans.join(", ")}`,
	);
});

test("the wildcard exemption is narrow enough to still be an exemption", () => {
	// If this ever covered most of the tree the gate above would be decorative.
	const all = referenceFiles();
	const exempt = all.filter((p) => WILDCARD_PREFIXES.some((prefix) => p.startsWith(prefix)));
	assert.ok(
		exempt.length > 0 && exempt.length < all.length / 3,
		`${exempt.length} of ${all.length} files are exempt — that is not an exemption any more`,
	);
});
