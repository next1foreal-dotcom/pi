/**
 * G-467 — her_mark_chapter: Samantha marks where the session's story turns.
 * The chapter rides inside the tool call's own arguments, so the live event
 * stream and the session file both carry it — Studio reads them back for the
 * transcript divider and the left-rail tick.
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/chapter-tool.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerChapterTools } from "../src/chapters/tools.ts";
import { resolveGovernedTool } from "../src/lib/governed-tools.ts";

function registeredTool(): ToolDefinition {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(def: ToolDefinition) {
			tools.set(def.name, def);
		},
	} as unknown as ExtensionAPI;
	registerChapterTools(pi);
	const tool = tools.get("her_mark_chapter");
	assert.ok(tool, "her_mark_chapter should be registered");
	return tool;
}

// The tool only shapes transcript data — it never touches ctx.
const noCtx = undefined as unknown as ExtensionContext;

async function run(tool: ToolDefinition, params: Record<string, unknown>) {
	const result = await tool.execute("call-1", params, undefined, undefined, noCtx);
	return result as {
		content: { type: string; text?: string }[];
		details: Record<string, unknown>;
	};
}

test("registerChapterTools registers her_mark_chapter", () => {
	const tool = registeredTool();
	assert.equal(tool.name, "her_mark_chapter");
	assert.equal(typeof tool.execute, "function");
});

test("her_mark_chapter rejects an empty title", async () => {
	const tool = registeredTool();
	for (const title of ["", "   "]) {
		const result = await run(tool, { title });
		assert.equal(result.details.ok, false, `should reject title ${JSON.stringify(title)}`);
		assert.match(result.content[0]?.text ?? "", /empty|title/i);
	}
});

test("her_mark_chapter rejects a title over 40 code points", async () => {
	const tool = registeredTool();
	for (const title of ["a".repeat(41), "界".repeat(41), "🐙".repeat(41)]) {
		const result = await run(tool, { title });
		assert.equal(result.details.ok, false, "should reject 41 code points");
		assert.match(result.content[0]?.text ?? "", /40|shorten/i);
	}
});

test("her_mark_chapter accepts exactly 40 code points, CJK and emoji included", async () => {
	const tool = registeredTool();
	// "🐙".length is 2 UTF-16 units — counting units would wrongly reject this.
	for (const title of ["汉".repeat(40), "🐙".repeat(40)]) {
		const result = await run(tool, { title });
		assert.equal(result.details.ok, true, "should accept 40 code points");
	}
});

test("her_mark_chapter trims title and summary and returns them in details", async () => {
	const tool = registeredTool();
	const result = await run(tool, { title: "  Wiring  ", summary: "  connected the dots  " });
	assert.equal(result.details.ok, true);
	assert.equal(result.details.title, "Wiring");
	assert.equal(result.details.summary, "connected the dots");
	assert.match(result.content[0]?.text ?? "", /Wiring/);
});

test("her_mark_chapter is governed non-destructive so the Cedar gate permits it", () => {
	// Unlisted resolves destructive — and no permit covers destructive. The
	// registry line is what lets the tool actually run; extension.test.ts's
	// completeness check enforces the same pairing.
	assert.deepEqual(resolveGovernedTool("her_mark_chapter"), {
		destructive: false,
		registered: true,
	});
});
