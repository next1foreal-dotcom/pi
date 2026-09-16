/**
 * Live-fire for design_lab_export against a running lab.
 * Writes into design/exports/ (gitignored). Not a unit test.
 *
 *   node --import tsx packages/her/scripts/lab-export-livefire.mjs
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerLabExportTools, EXPORT_DIR } from "../src/preview/lab-export.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const tools = new Map();
registerLabExportTools(
	{ registerTool(tool) { tools.set(tool.name, tool); } },
	{ repoRoot: REPO },
);

const tool = tools.get("design_lab_export");
if (!tool) {
	console.error("design_lab_export is not registered");
	process.exit(1);
}

const started = Date.now();
const result = await tool.execute("livefire", { screenIds: ["loora-landing"] }, undefined, undefined, undefined);
const text = result.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
const details = result.details ?? {};
console.log(JSON.stringify({ ms: Date.now() - started, text, details }, null, 2));

if (details.ok !== true) {
	process.exit(1);
}

const file = join(REPO, EXPORT_DIR, "loora-landing.png");
const bytes = await readFile(file);
const info = await stat(file);
if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
	console.error("not a PNG", bytes.subarray(0, 8));
	process.exit(1);
}
console.log(`png bytes=${info.size} magic=ok path=${file}`);
