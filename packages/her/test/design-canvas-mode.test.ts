import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
	DEFAULT_DESIGN_MODE,
	designMode,
	PRODUCT_MUTATING_TOOLS,
	READONLY_DESIGN_TOOLS,
	setDesignMode,
} from "../src/design-canvas/mode.ts";
import { registerDesignCanvasTools } from "../src/design-canvas/tools.ts";

const HER_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const REQUIRED_MUTATING = [
	"edit",
	"write",
	"bash",
	"powershell",
	"design_lab_reply",
	"design_lab_resolve",
	"design_project_create",
	"design_project_set_stage",
	"design_version_name",
	"design_system_load",
] as const;

const BUILTIN_READS = ["read", "grep", "ls", "find"] as const;

type ToolCallHandler = (
	event: ToolCallEvent,
	ctx: never,
) => ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>;

function harness(): {
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
	registerDesignCanvasTools(pi);
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

const { gate, tools } = harness();

function registeredDesignToolNames(srcRoot: string): string[] {
	const names: string[] = [];
	const pattern = /name:\s*"(design_[a-z0-9_]+)"/g;
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			const text = readFileSync(full, "utf8");
			for (const match of text.matchAll(pattern)) {
				names.push(match[1]);
			}
		}
	};
	walk(srcRoot);
	return names;
}

async function runMode(params: Record<string, unknown>): Promise<{ text: string; details: Record<string, unknown> }> {
	const tool = tools.get("design_mode");
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
}

test.afterEach(() => {
	setDesignMode(DEFAULT_DESIGN_MODE);
});

test("default mode is build", () => {
	assert.equal(DEFAULT_DESIGN_MODE, "build");
	assert.equal(designMode(), "build");
});

test("discuss mode blocks every product-mutating tool", async () => {
	setDesignMode("discuss");
	assert.ok(PRODUCT_MUTATING_TOOLS.size > 0);
	for (const name of REQUIRED_MUTATING) {
		assert.ok(PRODUCT_MUTATING_TOOLS.has(name), `${name} must stay on the mutating list`);
	}
	for (const name of PRODUCT_MUTATING_TOOLS) {
		const result = await gate(name);
		assert.equal(result?.block, true, `${name} should be blocked`);
		assert.equal(typeof result?.reason, "string", `${name} should explain the block`);
	}
});

test("discuss mode allows reads and readonly design tools", async () => {
	setDesignMode("discuss");
	for (const name of BUILTIN_READS) {
		assert.equal(await gate(name), undefined, `${name} should be allowed`);
	}
	for (const name of READONLY_DESIGN_TOOLS) {
		assert.equal(await gate(name), undefined, `${name} should be allowed`);
	}
	assert.equal(await gate("not_a_real_tool"), undefined, "unknown names should be allowed");
});

test("build mode never blocks", async () => {
	assert.equal(designMode(), "build");
	const names = [
		...PRODUCT_MUTATING_TOOLS,
		...READONLY_DESIGN_TOOLS,
		...BUILTIN_READS,
		"design_mode",
		"not_a_real_tool",
	];
	for (const name of names) {
		assert.equal(await gate(name), undefined, `build mode must return undefined for ${name}`);
	}
});

test("design_mode stays callable in discuss and can switch back to build", async () => {
	setDesignMode("discuss");
	assert.equal(await gate("design_mode"), undefined);
	const switched = await runMode({ mode: "build" });
	assert.equal(designMode(), "build");
	assert.equal(switched.details.mode, "build");
	assert.equal(await gate("edit"), undefined);
});

test("block reason names design_mode as the way out", async () => {
	setDesignMode("discuss");
	const result = await gate("edit");
	assert.equal(result?.block, true);
	assert.ok(result?.reason?.includes("design_mode"), result?.reason);
	assert.match(result?.reason ?? "", /discuss/i);
	assert.match(result?.reason ?? "", /change the product/i);
});

test("every registered design_* tool is classified mutating or readonly", () => {
	const registered = registeredDesignToolNames(HER_SRC);
	assert.ok(registered.includes("design_mode"));
	const seen = new Set<string>();
	for (const name of registered) {
		if (seen.has(name)) continue;
		seen.add(name);
		const mutating = PRODUCT_MUTATING_TOOLS.has(name);
		const readable = READONLY_DESIGN_TOOLS.has(name);
		assert.equal(mutating && readable, false, `${name} is in both lists`);
		assert.ok(
			mutating || readable,
			`${name} is registered but missing from PRODUCT_MUTATING_TOOLS and READONLY_DESIGN_TOOLS`,
		);
	}
	for (const name of [...PRODUCT_MUTATING_TOOLS, ...READONLY_DESIGN_TOOLS]) {
		if (!name.startsWith("design_")) continue;
		assert.ok(seen.has(name), `${name} is classified but not registered as name: "design_*"`);
	}
});

test("design_mode reports current mode and switches on request", async () => {
	const reported = await runMode({});
	assert.equal(reported.details.mode, "build");
	assert.match(reported.text, /build/);
	const discuss = await runMode({ mode: "discuss" });
	assert.equal(designMode(), "discuss");
	assert.equal(discuss.details.mode, "discuss");
	assert.match(discuss.text, /discuss/);
});
