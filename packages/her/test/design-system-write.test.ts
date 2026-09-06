import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type DesignSystemDeps, registerDesignSystemTools } from "../src/preview/design-system.ts";

const ISO = "2026-09-06T12:00:00.000Z";

const FIXTURE = `/* Gallery tokens. */
:root {
\t/* ink */
\t--background: #FFFFFF;
\t--accent: #2F6F4E;
}
.dark {
\t--background: #0B0B0B;
\t--glow: #C2A878;
}
`;

function harness(deps: DesignSystemDeps): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerDesignSystemTools(pi, deps);
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
	const dir = await mkdtemp(join(tmpdir(), "her-design-apply-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

interface WriteCapture {
	calls: Array<{ path: string; content: string }>;
}

function applyDeps(
	fixture: string,
	capture: WriteCapture,
	overrides: Partial<DesignSystemDeps> = {},
): DesignSystemDeps {
	return {
		repoRoot: "C:\\fake-repo",
		now: () => ISO,
		headOf: async () => "abc123",
		readSource: async () => fixture,
		writeSource: async (path: string, content: string) => {
			capture.calls.push({ path, content });
		},
		...overrides,
	};
}

// 1. Surgical replacement: changing one light token replaces only that value.
//    The rest of the file — comments, blank lines, indentation, the dark block — is byte-identical.
test("changing one light token replaces only that value, leaving every other byte intact", async (t) => {
	await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(applyDeps(FIXTURE, capture));

	const { details } = await run(tools.get("design_system_apply"), {
		changes: [{ name: "--accent", light: "#FF0000" }],
	});

	assert.equal(details.ok, true);
	assert.equal(capture.calls.length, 1);

	const written = capture.calls[0]!.content;
	const expected = FIXTURE.replace("--accent: #2F6F4E;", "--accent: #FF0000;");
	assert.equal(written, expected, "only the --accent value should change; every other byte must be identical");
});

// 2. A token that exists in both light and dark: changing only light must leave dark untouched.
test("changing light value of a token present in both modes leaves the dark block untouched", async (t) => {
	await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(applyDeps(FIXTURE, capture));

	const { details } = await run(tools.get("design_system_apply"), {
		changes: [{ name: "--background", light: "#F5F5F5" }],
	});

	assert.equal(details.ok, true);
	assert.equal(capture.calls.length, 1);

	const written = capture.calls[0]!.content;
	// The dark block must be byte-identical to the original.
	const darkBlock = ".dark {\n\t--background: #0B0B0B;\n\t--glow: #C2A878;\n}";
	assert.ok(written.includes(darkBlock), "dark block must be byte-identical to the original");
	// Light side changed.
	assert.ok(written.includes("--background: #F5F5F5;"), "light --background should be updated");
	assert.ok(!written.includes("--background: #FFFFFF;"), "old light value should be gone");
});

// 3. An unknown token name rejects the entire write. Not a single byte is written.
test("unknown token name rejects the entire write and writes nothing", async (t) => {
	await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(applyDeps(FIXTURE, capture));

	const { text, details } = await run(tools.get("design_system_apply"), {
		changes: [{ name: "--nonexistent", light: "#FF0000" }],
	});

	assert.equal(details.ok, false);
	assert.match(text, /--nonexistent/);
	assert.equal(capture.calls.length, 0, "no file should have been written");
});

// 4. A batch mixing known and unknown tokens: the entire batch is rejected.
//    Partial success is the worst outcome — either everything lands or nothing does.
test("a batch mixing one known and one unknown token rejects the entire batch", async (t) => {
	await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(applyDeps(FIXTURE, capture));

	const { text, details } = await run(tools.get("design_system_apply"), {
		changes: [
			{ name: "--background", light: "#F5F5F5" },
			{ name: "--does-not-exist", dark: "#000000" },
		],
	});

	assert.equal(details.ok, false);
	assert.match(text, /--does-not-exist/);
	assert.equal(capture.calls.length, 0, "partial success is forbidden — nothing should be written");
});

// 5. Write failure gives a human-readable error, not an uncaught throw.
test("write failure returns a human-readable error without throwing", async (t) => {
	await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(
		applyDeps(FIXTURE, capture, {
			writeSource: async () => {
				throw new Error("EACCES: permission denied");
			},
		}),
	);

	const { text, details } = await run(tools.get("design_system_apply"), {
		changes: [{ name: "--accent", light: "#FF0000" }],
	});

	assert.equal(details.ok, false);
	assert.match(text, /EACCES/);
	assert.match(text, /permission denied/);
});

// 6. Unknown target returns the same error shape as design_system_load.
test("unknown target returns the same error shape as design_system_load", async (t) => {
	await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(applyDeps(FIXTURE, capture));

	const { text, details } = await run(tools.get("design_system_apply"), {
		target: "nope",
		changes: [{ name: "--accent", light: "#FF0000" }],
	});

	assert.equal(details.ok, false);
	assert.match(text, /nope/);
	assert.match(text, /samantha-ui/);
	assert.equal(capture.calls.length, 0);
});

// 7. The returned before values match the original values that were in the file.
test("returned before values match the original values in the file", async (t) => {
	await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(applyDeps(FIXTURE, capture));

	const { details } = await run(tools.get("design_system_apply"), {
		changes: [
			{ name: "--background", light: "#F5F5F5", dark: "#111111" },
			{ name: "--accent", light: "#3A7D5C" },
		],
	});

	assert.equal(details.ok, true);
	const applied = details.applied as Array<{ name: string; side: string; before: string; after: string }>;
	assert.ok(Array.isArray(applied));

	const bgLight = applied.find((a) => a.name === "--background" && a.side === "light");
	const bgDark = applied.find((a) => a.name === "--background" && a.side === "dark");
	const accentLight = applied.find((a) => a.name === "--accent" && a.side === "light");

	assert.ok(bgLight);
	assert.equal(bgLight.before, "#FFFFFF");
	assert.equal(bgLight.after, "#F5F5F5");

	assert.ok(bgDark);
	assert.equal(bgDark.before, "#0B0B0B");
	assert.equal(bgDark.after, "#111111");

	assert.ok(accentLight);
	assert.equal(accentLight.before, "#2F6F4E");
	assert.equal(accentLight.after, "#3A7D5C");
});

// Two tokens in the same block, patched in one call, with replacement values of
// different lengths. The splice runs back-to-front so an earlier edit cannot move
// the offsets a later one recorded; front-to-back silently cuts at the wrong byte,
// and a design change almost always touches more than one token at a time.
test("two tokens in one block are both replaced, and neither cut lands on the wrong byte", async (t) => {
	await tempRoot(t);
	const capture: WriteCapture = { calls: [] };
	const tools = harness(applyDeps(FIXTURE, capture));

	const { details } = await run(tools.get("design_system_apply"), {
		changes: [
			{ name: "--background", light: "white" },
			{ name: "--accent", light: "rgb(47, 111, 78)" },
		],
	});

	assert.equal(details.ok, true);
	assert.equal(capture.calls.length, 1);

	const written = capture.calls[0]!.content;
	const expected = FIXTURE.replace("--background: #FFFFFF;", "--background: white;").replace(
		"--accent: #2F6F4E;",
		"--accent: rgb(47, 111, 78);",
	);
	assert.equal(written, expected, "both values replaced; every other byte identical");
});
