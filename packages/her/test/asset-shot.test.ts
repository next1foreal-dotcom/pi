import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { governedTools } from "../src/lib/governed-tools.ts";
import { type AssetShotDeps, registerAssetShotTools } from "../src/preview/asset-shot.ts";

function harness(deps: AssetShotDeps): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerAssetShotTools(pi, deps);
	return tools;
}

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content.map((part) => part.text).join("\n"), details: result.details ?? {} };
}

async function tempRoot(t: test.TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "her-asset-shot-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

test("a shot lands the png and a provenance file beside it", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({
		repoRoot: root,
		now: () => "2026-09-01T12:00:00.000Z",
		// The lab is not required to be running for this unit test to mean something.
		probePort: async () => true,
		capture: async () => PNG,
	});
	const { text, details } = await run(tools.get("design_asset_shot"), {
		url: "http://localhost:5180",
		name: "loora-canvas",
	});

	assert.equal(details.ok, true);
	assert.equal(details.path, "design/assets/loora-canvas.png");
	assert.deepEqual(await readFile(join(root, "design/assets/loora-canvas.png")), PNG);

	// An asset with no recorded source is a mystery image; the sidecar is the receipt.
	const sidecar = JSON.parse(await readFile(join(root, "design/assets/loora-canvas.json"), "utf8"));
	// URL normalisation adds the trailing slash; the receipt records what was actually fetched.
	assert.equal(sidecar.url, "http://localhost:5180/");
	assert.equal(sidecar.capturedAt, "2026-09-01T12:00:00.000Z");
	assert.equal(sidecar.width, 1440);
	assert.match(text, /design\/assets\/loora-canvas\.png/);
});

test("only local http(s) targets — no remote fetching under a design tool", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({
		repoRoot: root,
		now: () => "2026-09-01T12:00:00.000Z",
		capture: async () => {
			throw new Error("must not capture a rejected url");
		},
	});

	for (const url of ["https://example.com/", "file:///C:/secret.txt", "not-a-url"]) {
		const { details } = await run(tools.get("design_asset_shot"), { url, name: "x" });
		assert.equal(details.ok, false, `expected ${url} to be refused`);
	}
});

test("the target being down is a skip that names the target, not a failure", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({
		repoRoot: root,
		now: () => "2026-09-01T12:00:00.000Z",
		probePort: async () => false,
		capture: async () => {
			throw new Error("must not launch a browser when the target is down");
		},
	});
	const { text, details } = await run(tools.get("design_asset_shot"), {
		url: "http://localhost:9999",
		name: "loora-canvas",
	});

	assert.equal(details.skipped, true);
	assert.equal(details.ok, false);
	assert.match(text, /9999/);
});

test("viewport is carried into both the capture and the receipt", async (t) => {
	const root = await tempRoot(t);
	let seen: { width: number; height: number } | undefined;
	const tools = harness({
		repoRoot: root,
		now: () => "2026-09-01T12:00:00.000Z",
		// The lab is not required to be running for this unit test to mean something.
		probePort: async () => true,
		capture: async (request) => {
			seen = { width: request.width, height: request.height };
			return PNG;
		},
	});
	await run(tools.get("design_asset_shot"), {
		url: "http://localhost:5180",
		name: "narrow",
		width: 390,
		height: 844,
	});

	assert.deepEqual(seen, { width: 390, height: 844 });
	const sidecar = JSON.parse(await readFile(join(root, "design/assets/narrow.json"), "utf8"));
	assert.equal(sidecar.width, 390);
});

test("design_asset_shot is registered as a governed non-destructive tool", () => {
	assert.equal(governedTools.design_asset_shot?.destructive, false);
});
