/**
 * Two-sided live-fire for design_lab_still, against the real browser path.
 *
 * Why this exists: every screen currently on the canvas fits the lab's fixed 900px
 * host, so none of them scroll. Verifying only against those proves the "no tail"
 * branch and nothing else — and a one-sided check is how a correct implementation
 * gets "fixed" into a broken one. This script serves a page that really scrolls,
 * so the positive side has a sample without anyone having to invent one.
 *
 *   node --import tsx packages/her/scripts/lab-still-livefire.mjs [realScreenId]
 *
 * Exit 0 when the positive side produces two frames with different bytes and does
 * not claim the page is unscrollable. Pass a screen id to also shoot the live lab
 * on 5180 (skipped, not failed, when the lab is down). Nothing is written into the
 * repo: stills go to a temp directory that is printed at the end.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerLabStillTools } from "../src/preview/lab-still.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TALL_ID = "livefire-tall";
const BLOCK_H = 250;
const BLOCKS = 12;

const blocks = Array.from(
	{ length: BLOCKS },
	(_, i) =>
		`<div style="height:${BLOCK_H}px;display:flex;align-items:center;justify-content:center;` +
		`font:700 64px system-ui;background:hsl(${i * 30} 40% ${20 + i * 5}%);color:#fff">BLOCK ${i + 1}</div>`,
).join("");

const html =
	`<!doctype html><meta charset="utf-8"><title>${TALL_ID}</title>` +
	`<body style="margin:0;background:#111">` +
	`<div data-screen-id="${TALL_ID}" style="width:1400px;height:900px;overflow:hidden;margin:0 auto">` +
	`<div data-screen-scroll="${TALL_ID}" style="height:900px;overflow:auto">${blocks}</div></div></body>`;

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);

function shoot(tool, root, screenId, port) {
	return tool.execute("livefire", { screenId, port }).then((res) => {
		const text = (res.content ?? []).map((c) => c.text ?? "").join(" ");
		const details = res.details ?? res.structuredContent ?? {};
		const paths = details.paths ?? [];
		console.log(`=== ${screenId} (port ${port}) ===`);
		console.log("  scroll  :", JSON.stringify(details.scroll ?? null));
		console.log("  scrolls :", details.scrolls);
		for (const p of paths) console.log(`  frame   : sha16 ${sha(join(root, p))}  ${p}`);
		console.log("  says-no-scroll:", /does not scroll/.test(text));
		return { details, paths, text, root };
	});
}

const root = await mkdtemp(join(tmpdir(), "lab-still-livefire-"));
const tools = new Map();
registerLabStillTools({ registerTool: (t) => tools.set(t.name, t) }, { repoRoot: root });
const tool = tools.get("design_lab_still");

// Port 0 lets the OS pick: hard-coded ports collide with Windows' reserved ranges.
const server = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const tallPort = server.address().port;

let failures = 0;
try {
	const positive = await shoot(tool, root, TALL_ID, tallPort);
	const [top, bottom] = positive.paths;
	const check = (ok, what) => {
		console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
		if (!ok) failures += 1;
	};
	check(positive.details.scrolls === true, "a scrolling page reports scrolls: true");
	check(positive.paths.length === 2, "a scrolling page yields two frames");
	check(Boolean(top && bottom) && sha(join(root, top)) !== sha(join(root, bottom)), "the two frames differ");
	check(!/does not scroll/.test(positive.text), "it does not claim the page is unscrollable");

	const realScreen = process.argv[2];
	if (realScreen) {
		const negative = await shoot(tool, root, realScreen, 5180);
		if (negative.details.skipped) console.log("  SKIP  the lab is not running, so the negative side was not shot");
		else {
			check(negative.paths.length === 1, `${realScreen} fits one frame`);
			check(/does not scroll/.test(negative.text), `${realScreen} says why there is only one`);
		}
	} else {
		console.log("\n(no screen id given, so only the positive side ran — pass e.g. loora-landing for both)");
	}
} finally {
	server.close();
}

console.log(`\nstills: ${root}`);
console.log(failures === 0 ? "two-sided live-fire: OK" : `two-sided live-fire: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
void HERE;
