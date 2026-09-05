import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
	type CanvasDecision,
	pendingDecisions,
	proposeRule,
	recordResolvedDecision,
} from "../src/design-canvas/decisions.ts";
import type { CanvasEvent, Thread } from "../src/design-canvas/feed.ts";
import { appendEvent } from "../src/design-canvas/store.ts";
import { registerDesignCanvasTools } from "../src/design-canvas/tools.ts";

const AT = "2026-09-05T21:00:00.000Z";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "her-canvas-dec-"));
}

function fromFei(id: string, text: string, screenId: string | null = "product-list"): CanvasEvent {
	return { t: "note", id, at: AT, author: "fei", screenId, x: 10, y: 20, text };
}

function thread(partial: Partial<Thread> & Pick<Thread, "id" | "text">): Thread {
	return {
		at: AT,
		author: "fei",
		lastSpoke: "fei",
		screenId: "product-list",
		x: 10,
		y: 20,
		replies: [],
		resolved: true,
		...partial,
	};
}

function decision(id: string, his: string, screenId: string | null = "product-list"): CanvasDecision {
	return { id, at: AT, noteId: `n_${id}`, screenId, his, hers: "changed it" };
}

function canvasTools(root: string): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	let n = 0;
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerDesignCanvasTools(pi, {
		repoRoot: root,
		now: () => AT,
		makeId: (prefix) => `${prefix}_${++n}`,
	});
	return tools;
}

async function resolveNote(tools: Map<string, ToolDefinition>, noteId: string, note: string): Promise<void> {
	const tool = tools.get("design_lab_resolve");
	assert.ok(tool);
	await tool.execute("call-1", { noteId, note }, undefined, undefined, undefined as never);
}

function readJsonl(path: string): unknown[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown);
}

function plantSkillFiles(root: string): { skill: string; nested: string; body: string } {
	const body = "taste rule: never auto-write here\n";
	const skill = join(root, "SKILL.md");
	const nestedDir = join(root, ".claude", "skills", "taste");
	mkdirSync(nestedDir, { recursive: true });
	const nested = join(nestedDir, "SKILL.md");
	writeFileSync(skill, body, "utf8");
	writeFileSync(nested, body, "utf8");
	return { skill, nested, body };
}

test("resolve writes one decision with his words and what she did", async () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "this gap is too tight"), root);
		const tools = canvasTools(root);
		await resolveNote(tools, "n1", "widened to 24px");

		const rows = readJsonl(join(root, "design", "canvas", "decisions.jsonl"));
		assert.equal(rows.length, 1);
		const row = rows[0] as CanvasDecision;
		assert.equal(row.noteId, "n1");
		assert.equal(row.screenId, "product-list");
		assert.equal(row.his, "this gap is too tight");
		assert.equal(row.hers, "widened to 24px");
		assert.equal(typeof row.id, "string");
		assert.equal(row.at, AT);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("proposeRule returns null until there are 3 related opinions", () => {
	assert.equal(proposeRule([]), null);
	assert.equal(proposeRule([decision("d1", "too tight")]), null);
	assert.equal(proposeRule([decision("d1", "too tight"), decision("d2", "wrong green")]), null);

	const twoAndTwo = [
		decision("a1", "too tight", "product-list"),
		decision("b1", "too dark", "mosaic"),
		decision("a2", "wrong green", "product-list"),
		decision("b2", "too loud", "mosaic"),
	];
	assert.equal(proposeRule(twoAndTwo), null);
});

test("three related opinions collapse into one pending proposal", async () => {
	const proposed = proposeRule([
		decision("d1", "too tight"),
		decision("d2", "wrong green"),
		decision("d3", "fix the gap"),
	]);
	assert.ok(proposed);
	assert.deepEqual(proposed.from, ["d1", "d2", "d3"]);
	assert.match(proposed.rule, /too tight/);
	assert.match(proposed.rule, /wrong green/);
	assert.match(proposed.rule, /fix the gap/);

	const root = tempRoot();
	try {
		const planted = plantSkillFiles(root);
		appendEvent(fromFei("n1", "too tight"), root);
		appendEvent(fromFei("n2", "wrong green"), root);
		appendEvent(fromFei("n3", "fix the gap"), root);
		const tools = canvasTools(root);
		await resolveNote(tools, "n1", "24px");
		await resolveNote(tools, "n2", "hue shifted");
		assert.equal(existsSync(join(root, "design", "canvas", "rule-proposals.jsonl")), false);
		await resolveNote(tools, "n3", "closed the gap");

		const rows = readJsonl(join(root, "design", "canvas", "rule-proposals.jsonl"));
		assert.equal(rows.length, 1);
		const row = rows[0] as { rule: string; from: string[]; status: string };
		assert.equal(row.status, "pending");
		assert.equal(row.from.length, 3);
		assert.match(row.rule, /too tight/);

		assert.equal(readFileSync(planted.skill, "utf8"), planted.body);
		assert.equal(readFileSync(planted.nested, "utf8"), planted.body);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a proposal never lands in a skill file", () => {
	const root = tempRoot();
	try {
		const planted = plantSkillFiles(root);
		recordResolvedDecision(thread({ id: "n1", text: "too tight" }), "24px", { repoRoot: root, now: () => AT });
		recordResolvedDecision(thread({ id: "n2", text: "wrong green" }), "hue", { repoRoot: root, now: () => AT });
		recordResolvedDecision(thread({ id: "n3", text: "fix the gap" }), "closed", { repoRoot: root, now: () => AT });

		assert.equal(readFileSync(planted.skill, "utf8"), planted.body);
		assert.equal(readFileSync(planted.nested, "utf8"), planted.body);
		assert.equal(existsSync(join(root, "Agents.md")), false);
		assert.equal(existsSync(join(root, "packages")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("identical notes still count; the rule text names each unique ask once", () => {
	const same = [decision("d1", "too tight"), decision("d2", "too tight"), decision("d3", "too tight")];
	const proposed = proposeRule(same);
	assert.ok(proposed);
	assert.deepEqual(proposed.from, ["d1", "d2", "d3"]);
	assert.equal((proposed.rule.match(/too tight/g) ?? []).length, 1);
});

test("pendingDecisions drops entries already named by a proposal", () => {
	const root = tempRoot();
	try {
		recordResolvedDecision(thread({ id: "n1", text: "too tight" }), "a", { repoRoot: root, now: () => AT });
		recordResolvedDecision(thread({ id: "n2", text: "wrong green" }), "b", { repoRoot: root, now: () => AT });
		assert.equal(pendingDecisions(root).length, 2);
		recordResolvedDecision(thread({ id: "n3", text: "fix the gap" }), "c", { repoRoot: root, now: () => AT });
		assert.equal(pendingDecisions(root).length, 0, "the three were digested into a proposal");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
