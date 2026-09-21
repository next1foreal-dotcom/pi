import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildCapabilityCatalog, registerToolDisclosure } from "../src/tool-disclosure.ts";

function fakePi() {
	const tools = new Map<string, ToolDefinition>();
	let active = ["read", "bash", "browser_navigate", "her_recall", "design_canvas_open"];
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		getAllTools() {
			return [...tools.values()];
		},
		getActiveTools() {
			return [...active];
		},
		setActiveTools(names: string[]) {
			active = [...names];
		},
	} as unknown as ExtensionAPI;
	return { pi, tools, active: () => active };
}

test("capability catalog groups names without carrying schemas", () => {
	const catalog = buildCapabilityCatalog([
		{ name: "her_recall" },
		{ name: "her_task_spawn" },
		{ name: "browser_navigate" },
		{ name: "design_canvas_open" },
	]);
	assert.deepEqual(
		catalog.map((item) => [item.name, item.tools]),
		[
			["background", ["her_task_spawn"]],
			["browser", ["browser_navigate"]],
			["design", ["design_canvas_open"]],
			["memory", ["her_recall"]],
		],
	);
});

test("enforce starts narrow and loads requested schemas on demand", async () => {
	const fake = fakePi();
	const disclosure = registerToolDisclosure(fake.pi);
	for (const name of ["read", "bash", "browser_navigate", "her_recall", "design_canvas_open"]) {
		fake.tools.set(name, { name, label: name, description: name, parameters: {} } as ToolDefinition);
	}

	const state = disclosure.apply("enforce");
	assert.deepEqual(fake.active().sort(), ["bash", "her_capabilities", "her_tools_load", "read"]);
	assert.equal(state.hidden, 3);

	const loader = fake.tools.get("her_tools_load");
	assert.ok(loader);
	await loader.execute("call", { capability: "browser" }, undefined, undefined, {} as never);
	assert.ok(fake.active().includes("browser_navigate"));
	assert.equal(fake.active().includes("design_canvas_open"), false);
});

test("shadow inventories capabilities without changing active tools", () => {
	const fake = fakePi();
	const disclosure = registerToolDisclosure(fake.pi);
	for (const name of ["read", "browser_navigate"]) {
		fake.tools.set(name, { name, label: name, description: name, parameters: {} } as ToolDefinition);
	}
	const before = fake.active();
	const state = disclosure.apply("shadow");
	assert.deepEqual(fake.active(), before);
	assert.equal(state.hidden, 0);
});
