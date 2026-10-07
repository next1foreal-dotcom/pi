import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import her from "../src/extension.ts";
import { initStore } from "../src/her-core/index.ts";

test("registered her_recall forwards retention and reports final sources and receipts", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-recall-tool-"));
	await initStore(root);
	await writeFile(
		join(root, "semantic", "prior.md"),
		"---\nprivacy: shared\n---\nOriginal decision: approval is pending.",
	);
	await writeFile(
		join(root, "semantic", "fresh.md"),
		"---\nprivacy: shared\n---\nquasarzz: the next step is a review.",
	);
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		on() {},
		registerProvider() {},
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		registerMessageRenderer() {},
		appendEntry() {},
		getActiveTools() {
			return [];
		},
		getAllTools() {
			return [];
		},
		setActiveTools() {},
		events: { on() {}, off() {}, emit() {} },
	} as unknown as ExtensionAPI;
	const saved = process.env.HER_MEMORY_DIR;
	process.env.HER_MEMORY_DIR = root;
	try {
		her(pi);
		const recall = tools.get("her_recall");
		assert.ok(recall);
		assert.ok("properties" in recall.parameters);
		const properties = recall.parameters.properties;
		assert.ok(properties && typeof properties === "object" && "retainSourceIds" in properties);
		const ctx = { sessionManager: { getSessionId: () => "synthetic-retention" } } as unknown as ExtensionContext;
		const result = await recall.execute(
			"followup",
			{
				query: "quasarzz",
				k: 2,
				retainSourceIds: ["semantic/prior"],
			},
			undefined,
			undefined,
			ctx,
		);
		const details = result.details as { notes: Array<{ id: string }>; receipts: Array<{ slug: string }> };
		assert.deepEqual(
			details.notes.map((n) => n.id),
			["semantic/prior", "semantic/fresh"],
		);
		assert.deepEqual(
			details.receipts.map((r) => r.slug),
			["prior", "fresh"],
		);
		const rendered = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		assert.match(rendered, /approval is pending/);
		assert.match(rendered, /next step is a review/);
		assert.match(rendered, /retainSourceIds/);
		assert.match(rendered, /pending item is not a confirmed outcome/);
		assert.match(rendered, /say what could not be verified/);
		assert.match(rendered, /untrusted data/);
	} finally {
		if (saved === undefined) delete process.env.HER_MEMORY_DIR;
		else process.env.HER_MEMORY_DIR = saved;
	}
});
