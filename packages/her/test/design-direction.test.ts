import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { currentDirection, setDirection } from "../src/design-canvas/direction.ts";
import {
	FRAME_PRODUCING_TOOLS,
	interceptFirstFrameToolCall,
	PRODUCT_MUTATING_TOOLS,
	READONLY_DESIGN_TOOLS,
} from "../src/design-canvas/mode.ts";
import { registerDesignCanvasTools } from "../src/design-canvas/tools.ts";

const ISO = "2026-09-06T12:00:00.000Z";

const REQUIRED_FRAME = ["edit", "write", "bash", "powershell", "design_system_apply"] as const;

const READ_TOOLS = [
	"read",
	"grep",
	"ls",
	"find",
	"design_lab_notes",
	"design_lab_open",
	"design_lab_still",
	"design_system_review",
	"design_system_load",
	"design_asset_shot",
	"design_lab_reply",
	"design_project_get",
	"design_version_list",
] as const;

type ToolCallHandler = (
	event: ToolCallEvent,
	ctx: never,
) => ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>;

function tempRoot(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "her-direction-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function plantSystem(root: string, target = "demo"): void {
	const dir = join(root, "design", "system", target);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "receipt.json"), "{}\n", "utf8");
	writeFileSync(join(dir, "tokens.css"), ":root {}\n", "utf8");
}

function plantChosen(root: string, name = "brutalist concrete"): void {
	mkdirSync(join(root, "design"), { recursive: true });
	writeFileSync(
		join(root, "design", "direction.json"),
		`${JSON.stringify(
			{
				chosen: {
					name,
					character: "Heavy type, wet concrete, no bounce.",
					chosenBy: "fei",
					chosenAt: ISO,
				},
			},
			null,
			"\t",
		)}\n`,
		"utf8",
	);
}

function harness(repoRoot: string): {
	gate: (toolName: string) => Promise<ToolCallEventResult | undefined>;
	tools: Map<string, ToolDefinition>;
} {
	const tools = new Map<string, ToolDefinition>();
	let toolCall: ToolCallHandler | undefined;
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: ToolCallHandler) {
			if (event === "tool_call") toolCall = handler;
		},
	} as unknown as ExtensionAPI;
	registerDesignCanvasTools(pi, { repoRoot, now: () => ISO });
	assert.ok(toolCall, "registerDesignCanvasTools must subscribe to tool_call");
	const handler = toolCall;
	return {
		tools,
		async gate(toolName: string) {
			const event = { type: "tool_call", toolCallId: "t1", toolName, input: {} } as ToolCallEvent;
			return await handler(event, undefined as never);
		},
	};
}

async function runDirection(
	tools: Map<string, ToolDefinition>,
	params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const tool = tools.get("design_direction");
	assert.ok(tool, "design_direction must be registered");
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
}

test("frame-producing list is not the product-mutating list", () => {
	for (const name of REQUIRED_FRAME) {
		assert.ok(FRAME_PRODUCING_TOOLS.has(name), `${name} must stay on the frame-producing list`);
	}
	assert.equal(FRAME_PRODUCING_TOOLS.has("design_lab_reply"), false);
	assert.equal(FRAME_PRODUCING_TOOLS.has("design_lab_resolve"), false);
	assert.equal(FRAME_PRODUCING_TOOLS.has("design_project_create"), false);
	assert.equal(FRAME_PRODUCING_TOOLS.has("design_system_load"), false);
	assert.equal(FRAME_PRODUCING_TOOLS.has("design_asset_shot"), false);
	assert.equal(FRAME_PRODUCING_TOOLS.has("design_version_name"), false);
	assert.ok(PRODUCT_MUTATING_TOOLS.has("design_lab_reply"));
	assert.ok(PRODUCT_MUTATING_TOOLS.has("design_system_load"));
	assert.ok(READONLY_DESIGN_TOOLS.has("design_direction"));
});

test("no design system and no direction blocks frame-producing tools, and the reason names design_direction", async (t) => {
	const root = tempRoot(t);
	const { gate } = harness(root);
	assert.ok(FRAME_PRODUCING_TOOLS.size > 0);
	for (const name of FRAME_PRODUCING_TOOLS) {
		const result = await gate(name);
		assert.equal(result?.block, true, `${name} should be blocked`);
		assert.equal(typeof result?.reason, "string", `${name} should explain the block`);
		assert.ok(result?.reason?.includes("design_direction"), result?.reason);
	}
	const direct = interceptFirstFrameToolCall("write", root);
	assert.equal(direct?.block, true);
	assert.match(direct?.reason ?? "", /design_direction/);
});

test("a usable design system does not block, even with no direction", async (t) => {
	const root = tempRoot(t);
	plantSystem(root);
	const { gate } = harness(root);
	for (const name of FRAME_PRODUCING_TOOLS) {
		assert.equal(await gate(name), undefined, `${name} should be allowed when a design system exists`);
	}
});

test("a Fei-chosen direction does not block, even with no design system", async (t) => {
	const root = tempRoot(t);
	plantChosen(root);
	const { gate } = harness(root);
	for (const name of FRAME_PRODUCING_TOOLS) {
		assert.equal(await gate(name), undefined, `${name} should be allowed once a direction is chosen`);
	}
});

test("hard-stop still allows reads, looks, and screenshots", async (t) => {
	const root = tempRoot(t);
	const { gate } = harness(root);
	for (const name of READ_TOOLS) {
		assert.equal(await gate(name), undefined, `${name} should be allowed during hard-stop`);
	}
	assert.equal(await gate("not_a_real_tool"), undefined);
});

test("design_direction stays callable during hard-stop, and choose lifts it", async (t) => {
	const root = tempRoot(t);
	const { gate, tools } = harness(root);
	assert.equal(await gate("design_direction"), undefined);
	assert.equal((await gate("write"))?.block, true);

	const reported = await runDirection(tools, {});
	assert.match(reported.text, /no design direction/i);

	const proposed = await runDirection(tools, {
		propose: [
			{
				name: "brutalist concrete",
				character: "Heavy type, wet grey, no bounce.",
			},
		],
	});
	assert.equal(proposed.details.committed, false);
	assert.equal((await gate("write"))?.block, true, "propose must not lift the gate");

	const chosen = await runDirection(tools, { choose: "brutalist concrete" });
	assert.equal(chosen.details.ok, true);
	assert.equal(await gate("write"), undefined, "choose must lift the gate");
	assert.equal(currentDirection(root)?.chosenBy, "fei");
	assert.equal(currentDirection(root)?.name, "brutalist concrete");
});

test("propose does not lift the hard-stop", async (t) => {
	const root = tempRoot(t);
	const { gate, tools } = harness(root);
	await runDirection(tools, {
		propose: [{ name: "90s web-zine / sticker-bomb", character: "Clashing type, sticker colour, jumpy motion." }],
	});
	assert.equal(currentDirection(root), undefined);
	assert.equal((await gate("write"))?.block, true);
	assert.equal((await gate("design_system_apply"))?.block, true);
});

test("a chosen direction is on disk so a new process can read it back", async (t) => {
	const root = tempRoot(t);
	const written = setDirection(
		{ name: "brutalist concrete", character: "Heavy type, wet grey, no bounce.", chosenBy: "fei" },
		root,
	);
	assert.equal(written.chosenBy, "fei");
	const raw = readFileSync(join(root, "design", "direction.json"), "utf8");
	assert.match(raw, /brutalist concrete/);
	assert.match(raw, /"chosenBy": "fei"/);
	assert.equal(currentDirection(root)?.name, "brutalist concrete");
	assert.equal(currentDirection(root)?.character, "Heavy type, wet grey, no bounce.");
	assert.equal(currentDirection(root)?.chosenBy, "fei");
});

test("a missing or corrupt direction.json is treated as no direction and does not throw", async (t) => {
	const root = tempRoot(t);
	assert.equal(currentDirection(root), undefined);
	assert.doesNotThrow(() => currentDirection(root));

	mkdirSync(join(root, "design"), { recursive: true });
	writeFileSync(join(root, "design", "direction.json"), "{not json", "utf8");
	assert.doesNotThrow(() => currentDirection(root));
	assert.equal(currentDirection(root), undefined);
	assert.equal(interceptFirstFrameToolCall("write", root)?.block, true);

	writeFileSync(
		join(root, "design", "direction.json"),
		`${JSON.stringify({ name: "sneaky", character: "she picked this", chosenBy: "samantha", chosenAt: ISO })}\n`,
		"utf8",
	);
	assert.equal(currentDirection(root), undefined);
	assert.equal(interceptFirstFrameToolCall("write", root)?.block, true);
});
