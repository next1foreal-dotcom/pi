import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A tool module that nobody calls is invisible to her, and nothing else notices:
 * its own tests pass, typecheck passes, the file looks finished. design-versions
 * sat like that -- four registered tools, zero production callers -- until someone
 * went looking. Registration is mechanical, so the check is too.
 *
 * The list is derived from source rather than written down, so a module added
 * later is covered the day it registers its first design_* tool.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const EXTENSION = join(SRC, "extension.ts");

function tsFilesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...tsFilesUnder(full));
		} else if (entry.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

/** Modules that both export a `register*Tools` and register at least one `design_*` tool. */
function designToolModules(): { file: string; register: string }[] {
	const out: { file: string; register: string }[] = [];
	for (const file of tsFilesUnder(SRC)) {
		if (file === EXTENSION) continue;
		const source = readFileSync(file, "utf8");
		if (!/name:\s*"design_/.test(source)) continue;
		const match = source.match(/export function (register\w*Tools)\s*\(/);
		if (!match) continue;
		out.push({ file: relative(SRC, file).replace(/\\/g, "/"), register: match[1] });
	}
	return out;
}

/** Calls only: the import line names the same symbol and must not count as wiring. */
function calledInExtension(name: string): boolean {
	const source = readFileSync(EXTENSION, "utf8")
		.split("\n")
		.filter((line) => !line.startsWith("import "))
		.join("\n");
	return new RegExp(`\\b${name}\\s*\\(`).test(source);
}

test("every module that registers a design_* tool is called from the extension", () => {
	const modules = designToolModules();
	assert.ok(modules.length >= 6, `expected the design tool modules to be found, got ${modules.length}`);

	const orphans = modules.filter((m) => !calledInExtension(m.register));
	assert.deepEqual(
		orphans.map((m) => `${m.file} exports ${m.register}, which extension.ts never calls`),
		[],
	);
});
