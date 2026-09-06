import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { governedTools } from "../src/lib/governed-tools.ts";
import { type LabStillDeps, lockIntoScreen, type PageLike, registerLabStillTools } from "../src/preview/lab-still.ts";

function harness(deps: LabStillDeps): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerLabStillTools(pi, deps);
	return tools;
}

type ResultPart = { type: string; text?: string; data?: string; mimeType?: string };

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: ResultPart[];
		details?: Record<string, unknown>;
	};
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const images = result.content.filter((part) => part.type === "image");
	return { text, images, details: result.details ?? {} };
}

/** Stands in for the resize worker; returns a frame whose payload names its source bytes. */
function fakePrepare(note?: string) {
	return async (bytes: Buffer) => ({
		data: `base64:${bytes.toString("utf8")}`,
		mimeType: "image/png",
		note,
	});
}

async function tempRoot(t: test.TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "her-lab-still-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * lockIntoScreen used to answer "did the screen have a box?" while claiming to
 * answer "is the screen live?". It mimed the human gesture -- click the middle,
 * press Enter -- and a sticky note sitting in the middle of a screen was enough
 * to eat the click. Enter then did nothing, this returned true, and everything
 * downstream hit-tested a canvas still at 20% behind an explore-mode shield and
 * truthfully reported that there was nothing there.
 *
 * A canvas is someone's workspace and their notes are wherever they put them,
 * so aiming at pixels cannot be the mechanism. Ask the lab, then read the DOM
 * back. Both directions are here: a lab that went is a true, a lab that did not
 * is a false, and the false is the one that used to be a lie.
 */
function fakePage(options: {
	count?: number;
	box?: { x: number; y: number; width: number; height: number } | null;
	lockInto?: boolean | undefined;
	landed: { mode: string | null; active: boolean };
}): { page: PageLike; log: string[] } {
	const log: string[] = [];
	const page: PageLike = {
		async goto() {
			return null;
		},
		async waitForTimeout() {},
		async evaluate(script: string) {
			if (script.includes("canvas.lockInto")) {
				log.push("asked");
				return options.lockInto;
			}
			if (script.includes("data-active")) {
				log.push("looked");
				return options.landed;
			}
			return null;
		},
		locator() {
			return {
				first: () => ({
					async count() {
						return options.count ?? 1;
					},
					async boundingBox() {
						return options.box === undefined ? { x: 0, y: 0, width: 100, height: 80 } : options.box;
					},
				}),
			};
		},
		mouse: {
			async click() {
				log.push("clicked");
			},
		},
		keyboard: {
			async press() {
				log.push("pressed");
			},
		},
		async screenshot() {
			return Buffer.from("x");
		},
	};
	return { page, log };
}

test("locking in asks the lab, and does not mime a click at all", async () => {
	const { page, log } = fakePage({ lockInto: true, landed: { mode: "focus", active: true } });
	assert.equal(await lockIntoScreen(page, "main-landing"), true);
	assert.deepEqual(log, ["asked", "looked"]);
});

test("a lab that says the screen did not become live is a false, not a true", async () => {
	// This is the shape of the bug: the gesture ran, nothing happened, and the
	// old code returned true because the screen had a bounding box.
	const { page, log } = fakePage({ lockInto: undefined, landed: { mode: "explore", active: false } });
	assert.equal(await lockIntoScreen(page, "main-landing"), false);
	assert.deepEqual(log, ["asked", "clicked", "pressed", "looked"]);
});

test("an id the lab refuses never reaches the mouse", async () => {
	const { page, log } = fakePage({ lockInto: false, landed: { mode: "focus", active: true } });
	assert.equal(await lockIntoScreen(page, "not-a-screen"), false);
	assert.deepEqual(log, ["asked"]);
});

test("an older lab still gets the gesture, and is still checked afterwards", async () => {
	const { page, log } = fakePage({ lockInto: undefined, landed: { mode: "focus", active: true } });
	assert.equal(await lockIntoScreen(page, "main-landing"), true);
	assert.deepEqual(log, ["asked", "clicked", "pressed", "looked"]);
});

test("a screen that is not on the canvas answers false before anything else", async () => {
	const { page, log } = fakePage({ count: 0, landed: { mode: "explore", active: false } });
	assert.equal(await lockIntoScreen(page, "ghost"), false);
	assert.deepEqual(log, []);
});

test("lab down is a skip with the way back, not a failure", async (t) => {
	const tools = harness({
		repoRoot: await tempRoot(t),
		probePort: async () => false,
		capture: async () => {
			throw new Error("must not launch a browser when the lab is down");
		},
	});
	const { text, details } = await run(tools.get("design_lab_still"), { screenId: "loora-landing" });

	assert.equal(details.skipped, true);
	assert.equal(details.ok, false);
	assert.match(text, /design_lab_open/);
});

test("an unknown screen id answers with the ids that are actually on the canvas", async (t) => {
	const tools = harness({
		repoRoot: await tempRoot(t),
		probePort: async () => true,
		capture: async () => ({ shots: [], screenIds: ["playground", "product-list", "loora-landing"] }),
	});
	const { text, details } = await run(tools.get("design_lab_still"), { screenId: "typo-landing" });

	assert.equal(details.ok, false);
	assert.match(text, /playground/);
	assert.match(text, /loora-landing/);
});

test("a hit writes the png and hands back the path", async (t) => {
	const root = await tempRoot(t);
	const png = Buffer.from("89504e470d0a1a0a", "hex");
	const tools = harness({
		repoRoot: root,
		prepareImage: fakePrepare(),
		probePort: async () => true,
		capture: async ({ screenId, parts }) => ({
			screenIds: [screenId],
			shots: parts.map((part) => ({ part, bytes: png })),
		}),
	});
	const { text, details } = await run(tools.get("design_lab_still"), { screenId: "loora-landing", part: "top" });

	assert.equal(details.ok, true);
	const paths = details.paths as string[];
	assert.equal(paths.length, 1);
	assert.match(paths[0], /loora-landing-top\.png$/);
	assert.deepEqual(await readFile(join(root, paths[0])), png);
	// The description exists to change what she does next, so the result says it too.
	assert.match(text, /look|Read/i);
});

test("both parts is the default and produces two stills", async (t) => {
	const root = await tempRoot(t);
	const png = Buffer.from("89504e470d0a1a0a", "hex");
	const tools = harness({
		repoRoot: root,
		prepareImage: fakePrepare(),
		probePort: async () => true,
		capture: async ({ screenId, parts }) => ({
			screenIds: [screenId],
			shots: parts.map((part) => ({ part, bytes: png })),
		}),
	});
	const { details } = await run(tools.get("design_lab_still"), { screenId: "loora-landing" });

	assert.deepEqual(details.paths, ["design/stills/loora-landing-top.png", "design/stills/loora-landing-bottom.png"]);
});

test("design_lab_still is registered as a governed non-destructive tool", () => {
	assert.equal(governedTools.design_lab_still?.destructive, false);
});

test("the frames come back attached, so looking is not a second thing she has to remember", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({
		repoRoot: root,
		prepareImage: fakePrepare(),
		probePort: async () => true,
		capture: async ({ screenId }) => ({
			screenIds: [screenId],
			shots: [
				{ part: "top" as const, bytes: Buffer.from("top-bytes") },
				{ part: "bottom" as const, bytes: Buffer.from("bottom-bytes") },
			],
			scroll: { before: 0, after: 1200, scrollHeight: 2100, clientHeight: 900 },
		}),
	});
	const { images, details } = await run(tools.get("design_lab_still"), { screenId: "product-list" });

	assert.equal(details.attached, 2);
	assert.deepEqual(
		images.map((image) => image.data),
		["base64:top-bytes", "base64:bottom-bytes"],
	);
	assert.deepEqual(new Set(images.map((image) => image.mimeType)), new Set(["image/png"]));
});

test("a frame that had to be shrunk says so, because she measures off these", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({
		repoRoot: root,
		prepareImage: fakePrepare("[Image: original 3000x2000, displayed at 2000x1333. Multiply coordinates by 1.50.]"),
		probePort: async () => true,
		capture: async ({ screenId }) => ({
			screenIds: [screenId],
			shots: [{ part: "top" as const, bytes: Buffer.from("wide") }],
			scroll: { before: 0, after: 0, scrollHeight: 900, clientHeight: 900 },
		}),
	});
	const { text } = await run(tools.get("design_lab_still"), { screenId: "loora-landing" });

	assert.match(text, /Multiply coordinates by 1\.50/);
});

test("a frame that cannot be attached still lands on disk and says to open it", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({
		repoRoot: root,
		prepareImage: async () => {
			throw new Error("resize worker died");
		},
		probePort: async () => true,
		capture: async ({ screenId }) => ({
			screenIds: [screenId],
			shots: [{ part: "top" as const, bytes: Buffer.from("89504e470d0a1a0a", "hex") }],
		}),
	});
	const { text, images, details } = await run(tools.get("design_lab_still"), { screenId: "loora-landing" });

	assert.equal(details.ok, true);
	assert.equal(details.attached, 0);
	assert.equal(images.length, 0);
	assert.deepEqual(details.paths, ["design/stills/loora-landing-top.png"]);
	assert.match(text, /could not attach/i);
	assert.match(text, /open and look/i);
});

test("a screen with no tail yields one frame and says why", async (t) => {
	const root = await tempRoot(t);
	const png = Buffer.from("89504e470d0a1a0a", "hex");
	const tools = harness({
		repoRoot: root,
		prepareImage: fakePrepare(),
		probePort: async () => true,
		// The lab host is a fixed 900px box: scrollTop cannot move, so the tail shot is the same frame.
		capture: async ({ screenId }) => ({
			screenIds: [screenId],
			shots: [{ part: "top" as const, bytes: png }],
			scroll: { before: 0, after: 0, scrollHeight: 900, clientHeight: 900 },
		}),
	});
	const { text, details } = await run(tools.get("design_lab_still"), { screenId: "loora-landing" });

	assert.equal(details.ok, true);
	assert.equal(details.scrolls, false);
	assert.deepEqual(details.paths, ["design/stills/loora-landing-top.png"]);
	// The whole point: the evidence itself says which of the two reasons it is.
	assert.match(text, /does not scroll/);
});

test("a screen that really scrolls yields two different frames and claims no such thing", async (t) => {
	const root = await tempRoot(t);
	const top = Buffer.from("89504e470d0a1a0a", "hex");
	const bottom = Buffer.from("89504e470d0a1a0b", "hex");
	const tools = harness({
		repoRoot: root,
		prepareImage: fakePrepare(),
		probePort: async () => true,
		capture: async ({ screenId }) => ({
			screenIds: [screenId],
			shots: [
				{ part: "top" as const, bytes: top },
				{ part: "bottom" as const, bytes: bottom },
			],
			scroll: { before: 0, after: 1200, scrollHeight: 2100, clientHeight: 900 },
		}),
	});
	const { text, details } = await run(tools.get("design_lab_still"), { screenId: "product-list" });

	assert.equal(details.scrolls, true);
	assert.equal((details.paths as string[]).length, 2);
	assert.doesNotMatch(text, /does not scroll/);
	// Two frames must be two frames, not the same bytes twice.
	assert.notDeepEqual(
		await readFile(join(root, "design/stills/product-list-top.png")),
		await readFile(join(root, "design/stills/product-list-bottom.png")),
	);
});
