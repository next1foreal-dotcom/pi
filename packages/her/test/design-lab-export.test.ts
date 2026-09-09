import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	chooseScreens,
	cssAttrValue,
	EXPORT_DIR,
	type ExportRequest,
	type ExportResult,
	type LabExportDeps,
	pdfHtml,
	registerLabExportTools,
} from "../src/preview/lab-export.ts";

function harness(deps: LabExportDeps): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerLabExportTools(pi, deps);
	return tools;
}

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ type: string; text?: string }>;
		details?: Record<string, unknown>;
	};
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return { text, details: (result.details ?? {}) as Record<string, unknown> };
}

async function tempRoot(t: test.TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "her-lab-export-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

const CANVAS = ["playground", "product-list", "loora-landing"];

/** A browser that always succeeds, so the test is about the tool and not about chromium. */
function fakeCapture(found: readonly string[] = CANVAS, seen: ExportRequest[] = []): LabExportDeps["capture"] {
	return async (request) => {
		seen.push(request);
		const { take } = chooseScreens(found, request.screenIds);
		const shots = take.map((screenId) => ({ screenId, bytes: Buffer.from(`png:${screenId}`) }));
		const result: ExportResult = { screenIds: [...found], shots };
		if (request.format === "pdf" && shots.length > 0) result.pdf = Buffer.from("%PDF-fake");
		return result;
	};
}

// ── which screens ────────────────────────────────────────────────────────

test("naming no screen means the whole canvas, in canvas order", () => {
	assert.deepEqual(chooseScreens(CANVAS, []), { take: CANVAS, missing: [] });
});

test("a name that is not on the canvas is reported, not dropped", () => {
	// Both sides: what exists is taken in the order he asked for, what does not
	// exist comes back by name. A pdf quietly missing a page still looks complete.
	assert.deepEqual(chooseScreens(CANVAS, ["loora-landing", "ghost", "playground"]), {
		take: ["loora-landing", "playground"],
		missing: ["ghost"],
	});
	assert.deepEqual(chooseScreens(CANVAS, ["ghost"]), { take: [], missing: ["ghost"] });
});

// ── the printed page ─────────────────────────────────────────────────────

test("the pdf is one screen per page and nothing else", () => {
	const html = pdfHtml([
		{ screenId: "a", bytes: Buffer.from("AAA") },
		{ screenId: "b", bytes: Buffer.from("BBB") },
	]);
	assert.equal(html.match(/<figure>/g)?.length, 2);
	assert.match(html, /data:image\/png;base64,QUFB/);
	assert.match(html, /data:image\/png;base64,QkJC/);
	// Every page breaks except the last, or the file ends on a blank sheet.
	assert.match(html, /figure \{[^}]*break-after: page/);
	assert.match(html, /figure:last-of-type \{[^}]*break-after: auto/);
	// Nothing stamped over his design.
	assert.doesNotMatch(html, /<figcaption|page \d/);
});

test("a screen id cannot smuggle markup into the printed page", () => {
	const html = pdfHtml([{ screenId: '"><script>alert(1)</script>', bytes: Buffer.from("A") }]);
	assert.doesNotMatch(html, /<script>/);
	assert.match(html, /&lt;script&gt;/);
});

// ── the tool ─────────────────────────────────────────────────────────────

test("png writes one file per screen and hands back where they are", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({ repoRoot: root, capture: fakeCapture() });

	const { text, details } = await run(tools.get("design_lab_export"), {});

	assert.equal(details.ok, true);
	assert.equal(details.format, "png");
	assert.deepEqual(details.files, ["playground.png", "product-list.png", "loora-landing.png"]);
	assert.match(text, /design[\\/]exports/);

	const written = (await readdir(join(root, EXPORT_DIR))).sort();
	assert.deepEqual(written, ["loora-landing.png", "playground.png", "product-list.png"]);
	assert.equal(await readFile(join(root, EXPORT_DIR, "playground.png"), "utf8"), "png:playground");
});

test("pdf writes one file, and says what order the pages are in", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({
		repoRoot: root,
		capture: fakeCapture(),
		now: () => new Date("2026-09-09T00:00:00.000Z"),
	});

	const { text, details } = await run(tools.get("design_lab_export"), { format: "pdf" });

	assert.equal(details.ok, true);
	assert.deepEqual(details.files, ["canvas-2026-09-09.pdf"]);
	assert.match(text, /Pages, in order: playground, product-list, loora-landing\./);
	assert.deepEqual(await readdir(join(root, EXPORT_DIR)), ["canvas-2026-09-09.pdf"]);

	// The date is only the default: a name he gives wins.
	const named = harness({ repoRoot: root, capture: fakeCapture() });
	await run(named.get("design_lab_export"), { format: "pdf", name: "loora-deck" });
	assert.ok((await readdir(join(root, EXPORT_DIR))).includes("loora-deck.pdf"));
});

test("a screen that is not there is named back, and the rest still export", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({ repoRoot: root, capture: fakeCapture() });

	const { text, details } = await run(tools.get("design_lab_export"), {
		screenIds: ["loora-landing", "ghost"],
	});

	assert.equal(details.ok, true);
	assert.deepEqual(details.files, ["loora-landing.png"]);
	assert.deepEqual(details.missing, ["ghost"]);
	assert.match(text, /not exported: ghost/);
});

test("an empty canvas writes nothing and says so", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({ repoRoot: root, capture: fakeCapture([]) });

	const { text, details } = await run(tools.get("design_lab_export"), {});

	assert.equal(details.ok, false);
	assert.match(text, /no screens/);
	await assert.rejects(() => readdir(join(root, EXPORT_DIR)));
});

test("a browser that will not start is reported, not swallowed", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({
		repoRoot: root,
		capture: async () => {
			throw new Error("net::ERR_CONNECTION_REFUSED at http://localhost:5280");
		},
	});

	const { text, details } = await run(tools.get("design_lab_export"), {});

	assert.equal(details.ok, false);
	assert.match(text, /Could not export/);
	assert.match(text, /ERR_CONNECTION_REFUSED/);
});

test("the lab's own port is the default, and a given port wins", async (t) => {
	const root = await tempRoot(t);
	const seen: ExportRequest[] = [];
	const tools = harness({ repoRoot: root, capture: fakeCapture(CANVAS, seen) });

	await run(tools.get("design_lab_export"), {});
	await run(tools.get("design_lab_export"), { port: 5390 });

	const { DESIGN_LAB_PORT } = await import("../src/preview/design-lab-open.ts");
	assert.equal(seen[0]?.port, DESIGN_LAB_PORT);
	assert.equal(seen[1]?.port, 5390);
});

test("a screen id cannot break out of the attribute selector it is put in", () => {
	assert.equal(cssAttrValue("loora-landing"), "loora-landing");
	assert.equal(cssAttrValue('a"b'), 'a\\"b');
	assert.equal(cssAttrValue("a\\b"), "a\\\\b");
	// The other side: nothing that is already safe gets touched.
	assert.equal(cssAttrValue("a-b_c.1"), "a-b_c.1");
});
