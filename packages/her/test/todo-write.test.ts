import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { governedTools } from "../src/extension.ts";
import { registerTodoWriteTools } from "../src/todo-write/tools.ts";

function harness() {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerTodoWriteTools(pi);
	return tools;
}

test("todo_write is registered and non-destructive", () => {
	const tools = harness();
	assert.equal(tools.has("todo_write"), true);
	assert.equal(governedTools.todo_write?.destructive, false);
});

test("todo_write echoes the full list and rejects empty content", async () => {
	const tool = harness().get("todo_write");
	assert.ok(tool);
	const ok = (await tool.execute(
		"c1",
		{
			todos: [
				{ content: "Inspect the flow", status: "in_progress" },
				{ content: "Ship", status: "pending" },
			],
		},
		undefined,
		undefined,
		undefined as never,
	)) as { content: Array<{ text: string }>; details: { ok: boolean; todos: unknown[] } };
	assert.match(ok.content[0]?.text ?? "", /0\/2/);
	assert.equal(ok.details.ok, true);
	assert.equal(ok.details.todos.length, 2);

	const bad = (await tool.execute(
		"c2",
		{ todos: [{ content: "   ", status: "pending" }] },
		undefined,
		undefined,
		undefined as never,
	)) as { details: { ok: boolean } };
	assert.equal(bad.details.ok, false);
});
