import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { governedTools } from "../src/lib/governed-tools.ts";

/**
 * Registering a tool is not the same as being allowed to call it. The Cedar gate
 * treats an unlisted tool as destructive, and no permit covers a destructive tool,
 * so a tool missing from `governedTools` is denied with "no permit matched" —
 * silently, at call time, long after its own tests went green. Nine design tools
 * sat like that at once, including the whole canvas conversation.
 *
 * Wiring is checked next door in design-tools-wired.test.ts. This checks the other
 * half: that a wired tool is also permitted to run.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const POLICY = join(HERE, "..", "pi-package", "policies", "her-trust.cedar");

function tsFilesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
		else if (entry.endsWith(".ts")) out.push(full);
	}
	return out;
}

function registeredDesignToolNames(): string[] {
	const names = new Set<string>();
	for (const file of tsFilesUnder(SRC)) {
		for (const m of readFileSync(file, "utf8").matchAll(/name:\s*"(design_\w+)"/g)) {
			names.add(m[1]);
		}
	}
	return [...names].sort();
}

/** Tools the default policy names in a permit of their own. */
function toolsWithOwnPermit(): Set<string> {
	const out = new Set<string>();
	for (const m of readFileSync(POLICY, "utf8").matchAll(/resource\s*==\s*Tool::"(\w+)"/g)) {
		out.add(m[1]);
	}
	return out;
}

test("every design_* tool is listed in governedTools, so the Cedar gate can permit it", () => {
	const names = registeredDesignToolNames();
	assert.ok(names.length >= 15, `expected the design tools to be found, got ${names.length}`);

	const unlisted = names.filter((name) => !(name in governedTools));
	assert.deepEqual(unlisted, [], "unlisted means destructive means denied at call time");
});

test("a destructive design tool is named in a permit, or it is dead on arrival", () => {
	const permitted = toolsWithOwnPermit();
	const stranded = registeredDesignToolNames().filter(
		(name) => governedTools[name]?.destructive === true && !permitted.has(name),
	);
	assert.deepEqual(
		stranded,
		[],
		"no permit covers a destructive tool, so one without its own permit is denied at every call",
	);
});
