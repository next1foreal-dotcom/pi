import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerTokenScratchTools, type TokenScratchDeps } from "../src/preview/token-scratch.ts";

const ISO = "2026-09-06T12:00:00.000Z";

/**
 * A minimal globals.css with known tokens for both light and dark modes,
 * plus one media-scoped block. This mirrors what the real samantha-ui ships.
 */
const FIXTURE = `/* Gallery tokens. */
:root {
\t/* ink */
\t--background: #FFFFFF;
\t--accent: #2F6F4E;
\t--radius: 0.75rem;
}
.dark {
\t--background: #0B0B0B;
\t--accent: #8AC4A0;
}
@media (min-width: 768px) {
\t:root {
\t\t--radius: 1rem;
\t}
}
`;

function harness(deps: TokenScratchDeps): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerTokenScratchTools(pi, deps);
	return tools;
}

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
	assert.ok(tool, "tool must be registered");
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content.map((part) => part.text).join("\n"), details: result.details ?? {} };
}

async function tempRoot(t: test.TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "her-token-scratch-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

interface WriteCapture {
	calls: Array<{ path: string; content: string }>;
}

function makeDeps(repoRoot: string, fixture: string, capture: WriteCapture): TokenScratchDeps {
	return {
		repoRoot,
		now: () => ISO,
		readSource: async () => fixture,
		writeSource: async (path: string, content: string) => {
			capture.calls.push({ path, content });
		},
	};
}

// ── Test 1: Unknown token name rejects the whole call ─────────────────
test("design_tokens_try rejects unknown token names without writing anything", async (t) => {
	const root = await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(makeDeps(root, FIXTURE, capture));

	const { text, details } = await run(tools.get("design_tokens_try"), {
		changes: [
			{ name: "--background", light: "red" },
			{ name: "--does-not-exist", light: "blue" },
		],
	});

	assert.equal(details.ok, false);
	assert.ok(text.includes("Refused"));
	assert.ok(text.includes("--does-not-exist"));

	// Verify nothing was written to the scratch file
	const scratchPath = join(root, "design", "token-overrides.json");
	await assert.rejects(() => readFile(scratchPath, "utf8"), "scratch file must not exist");
});

// ── Test 2: design_tokens_try writes the scratch set ──────────────────
test("design_tokens_try writes a valid scratch set and merges subsequent calls", async (t) => {
	const root = await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(makeDeps(root, FIXTURE, capture));

	// First call
	const { details: d1 } = await run(tools.get("design_tokens_try"), {
		changes: [{ name: "--background", light: "oklch(0.98 0.01 85)" }],
	});
	assert.equal(d1.ok, true);

	// Read the scratch file
	const scratchPath = join(root, "design", "token-overrides.json");
	const set1 = JSON.parse(await readFile(scratchPath, "utf8"));
	assert.equal(set1.changes.length, 1);
	assert.equal(set1.changes[0].name, "--background");

	// Second call — should merge
	const { details: d2 } = await run(tools.get("design_tokens_try"), {
		changes: [{ name: "--accent", light: "#FF0000" }],
	});
	assert.equal(d2.ok, true);
	const set2 = JSON.parse(await readFile(scratchPath, "utf8"));
	assert.equal(set2.changes.length, 2);
});

// ── Test 3: design_tokens_scratch shows the diff ──────────────────────
test("design_tokens_scratch shows current → scratch values", async (t) => {
	const root = await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(makeDeps(root, FIXTURE, capture));

	// Populate a scratch set first
	await run(tools.get("design_tokens_try"), {
		changes: [{ name: "--background", light: "oklch(0.98 0.01 85)" }],
	});

	const { text, details } = await run(tools.get("design_tokens_scratch"), {});
	assert.equal(details.ok, true);
	assert.ok(text.includes("#FFFFFF"));
	assert.ok(text.includes("oklch(0.98 0.01 85)"));
});

// ── Test 4: design_tokens_discard removes without touching the product ─
test("design_tokens_discard removes the scratch set and writes nothing to the product", async (t) => {
	const root = await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(makeDeps(root, FIXTURE, capture));

	await run(tools.get("design_tokens_try"), {
		changes: [{ name: "--background", light: "red" }],
	});
	const { details } = await run(tools.get("design_tokens_discard"), {});
	assert.equal(details.ok, true);

	// Verify nothing was written to the product
	assert.equal(capture.calls.length, 0);

	// Verify scratch is gone
	const scratchPath = join(root, "design", "token-overrides.json");
	await assert.rejects(() => readFile(scratchPath, "utf8"), "scratch file must be gone");
});

// ── Test 5: design_tokens_commit writes to the product and clears scratch ─
test("design_tokens_commit writes the product file and leaves scratch empty", async (t) => {
	const root = await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(makeDeps(root, FIXTURE, capture));

	await run(tools.get("design_tokens_try"), {
		changes: [{ name: "--background", light: "oklch(0.98 0.01 85)" }],
	});

	const { text, details } = await run(tools.get("design_tokens_commit"), {});
	assert.equal(details.ok, true);
	assert.ok(text.includes("Committed"));
	assert.ok(text.includes("modified the product source code"));

	// The product CSS was written
	assert.ok(capture.calls.length > 0, "product CSS must have been written");
	const written = capture.calls[0].content;
	assert.ok(written.includes("oklch(0.98 0.01 85)"), "new value must appear in the product CSS");

	// The scratch set is gone
	const scratchPath = join(root, "design", "token-overrides.json");
	await assert.rejects(() => readFile(scratchPath, "utf8"), "scratch file must be gone after commit");
});

// ── Test 6: design_tokens_discard by name keeps other overrides ───────
test("design_tokens_discard by name keeps unmentioned overrides", async (t) => {
	const root = await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(makeDeps(root, FIXTURE, capture));

	await run(tools.get("design_tokens_try"), {
		changes: [
			{ name: "--background", light: "red" },
			{ name: "--accent", light: "blue" },
		],
	});

	await run(tools.get("design_tokens_discard"), { names: ["--background"] });

	const scratchPath = join(root, "design", "token-overrides.json");
	const remaining = JSON.parse(await readFile(scratchPath, "utf8"));
	assert.equal(remaining.changes.length, 1);
	assert.equal(remaining.changes[0].name, "--accent");
});

// ── Test 7: All four tools are registered ─────────────────────────────
test("registerTokenScratchTools registers all four design_tokens_* tools", async () => {
	const tools = harness({
		repoRoot: "C:\\fake",
		now: () => ISO,
		readSource: async () => FIXTURE,
		writeSource: async () => {},
	});

	const expected = ["design_tokens_try", "design_tokens_scratch", "design_tokens_discard", "design_tokens_commit"];

	for (const name of expected) {
		assert.ok(tools.has(name), `${name} must be registered`);
	}
});
