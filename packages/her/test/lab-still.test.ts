import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { governedTools } from "../src/lib/governed-tools.ts";
import { type LabStillDeps, registerLabStillTools } from "../src/preview/lab-still.ts";

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

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content.map((part) => part.text).join("\n"), details: result.details ?? {} };
}

async function tempRoot(t: test.TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "her-lab-still-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

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
