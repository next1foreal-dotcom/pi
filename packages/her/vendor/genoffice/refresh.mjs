// Rebuild the vendored GenOffice bundles from the upstream clone.
//
// Usage:
//   node packages/her/vendor/genoffice/refresh.mjs [--upstream <dir>] [--no-pull] [--no-test]
//
// What it does, in order: pull the upstream clone (ff-only), rebuild the three
// bundles with the upstream's own esbuild, re-point extract.mjs at the local
// docx-engine bundle, verify no BOM landed, record the new pin in
// upstream-pin.json, then run Her's doc-tools test suite as the regression
// gate. Review `git status` and commit like any other change afterwards.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const pinPath = join(here, "upstream-pin.json");

const args = process.argv.slice(2);
function flag(name) {
	return args.includes(name);
}
function option(name, fallback) {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const upstream = resolve(option("--upstream", process.env.GENOFFICE_UPSTREAM ?? "D:/@Her/genoffice"));

function fail(message) {
	console.error(`refresh FAILED: ${message}`);
	process.exit(1);
}

function git(...gitArgs) {
	return execFileSync("git", ["-C", upstream, ...gitArgs], { encoding: "utf8" }).trim();
}

// --- preconditions ---
if (!existsSync(join(upstream, ".git"))) fail(`upstream clone not found at ${upstream} (set GENOFFICE_UPSTREAM or --upstream)`);
if (!existsSync(join(upstream, "node_modules", "esbuild"))) {
	fail(`esbuild missing in ${upstream}/node_modules - run "npm install" in the upstream clone first (slow disk: ~13 min)`);
}

const previousPin = existsSync(pinPath) ? JSON.parse(readFileSync(pinPath, "utf8")) : null;

// --- pull ---
if (!flag("--no-pull")) {
	try {
		console.log(git("pull", "--ff-only"));
	} catch (error) {
		fail(`git pull --ff-only failed (offline? diverged clone?): ${error.message}`);
	}
}

const commit = git("rev-parse", "HEAD");
const short = git("rev-parse", "--short", "HEAD");
const banner = `// Bundled from https://github.com/genspark-ai/genoffice @ ${short} (Apache-2.0). See NOTES.md; do not hand-edit.`;

// --- bundle entries (temporary files inside the upstream clone) ---
const entries = [
	{
		name: "docx-engine.mjs",
		tmp: ".tmp-her-vendor-docx.ts",
		source:
			"export * from './packages/docx-engine/src/index'\n" +
			"export { patchParagraphTexts } from './packages/docx-engine/src/text-patch'\n",
		external: [],
	},
	{
		name: "extract.mjs",
		tmp: ".tmp-her-vendor-extract.ts",
		source:
			"export { docxToText } from './packages/file-parse/src/docx'\n" +
			"export { pptxToText } from './packages/file-parse/src/pptx'\n" +
			"export { xlsxToText } from './packages/file-parse/src/xlsx'\n",
		external: ["@genoffice/docx-engine"],
	},
	{
		name: "fixtures.mjs",
		tmp: ".tmp-her-vendor-fixtures.ts",
		source:
			"export { buildDocxFixture, buildPptxFixture, buildXlsxFixture } from './packages/file-parse/tests/helpers/fixtures'\n",
		external: [],
	},
];

const require = createRequire(import.meta.url);
const esbuild = require(join(upstream, "node_modules", "esbuild"));

for (const entry of entries) {
	const entryPath = join(upstream, entry.tmp);
	writeFileSync(entryPath, entry.source);
	try {
		esbuild.buildSync({
			entryPoints: [entryPath],
			bundle: true,
			format: "esm",
			platform: "node",
			target: ["node20"],
			banner: { js: banner },
			external: entry.external,
			outfile: join(here, entry.name),
			logLevel: "warning",
			absWorkingDir: upstream,
		});
	} finally {
		rmSync(entryPath, { force: true });
	}
}

// extract.mjs keeps the workspace specifier as external; point it at the
// bundle sitting next to it so the two files share one engine copy.
const extractPath = join(here, "extract.mjs");
const extract = readFileSync(extractPath, "utf8");
writeFileSync(extractPath, extract.replaceAll('"@genoffice/docx-engine"', '"./docx-engine.mjs"'));

// --- byte hygiene + wiring checks ---
for (const entry of entries) {
	const bytes = readFileSync(join(here, entry.name));
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail(`${entry.name} has a BOM`);
	if (!bytes.subarray(0, 200).toString("utf8").includes(short)) fail(`${entry.name} banner does not carry pin ${short}`);
}
if (readFileSync(extractPath, "utf8").includes("@genoffice/docx-engine")) {
	fail("extract.mjs still imports @genoffice/docx-engine instead of ./docx-engine.mjs");
}

// Only rewrite the pin when the commit moved, so a no-op refresh leaves
// `git status` untouched (the byte-identity property is the verification).
if (previousPin?.commit !== commit) {
	writeFileSync(
		pinPath,
		`${JSON.stringify({ repo: "https://github.com/genspark-ai/genoffice", commit, short, builtAt: new Date().toISOString() }, null, "\t")}\n`,
	);
}

console.log(`pin: ${previousPin ? previousPin.short : "(none)"} -> ${short}`);
for (const entry of entries) {
	console.log(`  ${entry.name} ${statSync(join(here, entry.name)).size} bytes`);
}

// --- regression gate ---
if (!flag("--no-test")) {
	console.log("running doc-tools regression tests...");
	const test = spawnSync(
		process.execPath,
		["--import", "tsx", "--test", join("packages", "her", "test", "doc-tools.test.ts")],
		{ cwd: repoRoot, stdio: "inherit" },
	);
	if (test.status !== 0) fail("doc-tools tests failed - do not commit these bundles");
}

console.log("refresh OK - review `git status` in packages/her/vendor/genoffice and commit.");
