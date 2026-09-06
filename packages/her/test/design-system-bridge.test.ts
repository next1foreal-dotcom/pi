import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type DesignSystemDeps, registerDesignSystemTools } from "../src/preview/design-system.ts";

const ISO = "2026-09-06T14:00:00.000Z";

// ---------- helpers ----------

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

interface WriteCapture {
	calls: Array<{ path: string; content: string }>;
}

async function tempRoot(t: test.TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "her-design-bridge-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

// ---------- fixtures ----------

const BASE_CSS = `/* tokens */
:root {
\t--background: #FFFFFF;
\t--accent: #2F6F4E;
}
.dark {
\t--background: #0B0B0B;
\t--glow: #C2A878;
}
`;

const MEDIA_CSS = `/* tokens */
:root {
\t--background: #FFFFFF;
\t--accent: #2F6F4E;
\t--heading-size: 3.5rem;
}
.dark {
\t--background: #0B0B0B;
\t--glow: #C2A878;
}
@media (min-width: 768px) {
\t:root {
\t\t--heading-size: 8rem;
\t}
}
@media (min-width: 768px) {
\t.dark {
\t\t--glow: #FFD700;
\t}
}
`;

function loadDeps(root: string, fixture: string, usageRoot?: string): DesignSystemDeps {
	return {
		repoRoot: root,
		now: () => ISO,
		headOf: async () => "abc123",
		readSource: async () => fixture,
		usageScanRoot: usageRoot ?? join(root, "no-usage-scan"),
	};
}

function applyDeps(fixture: string, capture: WriteCapture): DesignSystemDeps {
	return {
		repoRoot: "C:\\fake-repo",
		now: () => ISO,
		headOf: async () => "abc123",
		readSource: async () => fixture,
		writeSource: async (path: string, content: string) => {
			capture.calls.push({ path, content });
		},
		usageScanRoot: "C:\\nonexistent",
	};
}

// ================================================================
// BREAKPOINT TESTS
// ================================================================

test("@media tokens are extracted and grouped by condition", async (t) => {
	const root = await tempRoot(t);
	const tools = harness(loadDeps(root, MEDIA_CSS));
	const { details } = await run(tools.get("design_system_load"), {});
	assert.equal(details.ok, true);
	const receiptPath = join(root, "design", "system", "samantha-ui", "receipt.json");
	const parsed = JSON.parse(readFileSync(receiptPath, "utf8"));
	assert.deepEqual(parsed.mediaBreakpoints, ["(min-width: 768px)"]);
});

test("tokens without media variants look the same as before", async (t) => {
	const root = await tempRoot(t);
	const tools = harness(loadDeps(root, BASE_CSS));
	const { details } = await run(tools.get("design_system_load"), {});
	assert.equal(details.ok, true);
	const receiptPath = join(root, "design", "system", "samantha-ui", "receipt.json");
	const parsed = JSON.parse(readFileSync(receiptPath, "utf8"));
	assert.deepEqual(parsed.mediaBreakpoints, []);
	const cssPath = join(root, "design", "system", "samantha-ui", "tokens.css");
	const css = readFileSync(cssPath, "utf8");
	assert.ok(!css.includes("@media"), "no @media section in output");
});

test("@media tokens appear in tokens.css output", async (t) => {
	const root = await tempRoot(t);
	const tools = harness(loadDeps(root, MEDIA_CSS));
	await run(tools.get("design_system_load"), {});
	const css = readFileSync(join(root, "design", "system", "samantha-ui", "tokens.css"), "utf8");
	assert.ok(css.includes("@media (min-width: 768px)"));
	assert.ok(css.includes("--heading-size: 8rem"));
	assert.ok(css.includes("--glow: #FFD700"));
});

test("@media tokens appear in tokens.md output", async (t) => {
	const root = await tempRoot(t);
	const tools = harness(loadDeps(root, MEDIA_CSS));
	await run(tools.get("design_system_load"), {});
	const md = readFileSync(join(root, "design", "system", "samantha-ui", "tokens.md"), "utf8");
	assert.ok(md.includes("### @media (min-width: 768px)"));
	assert.ok(md.includes("--heading-size"));
});

test("apply can change a value under a specific @media condition", async () => {
	const capture: WriteCapture = { calls: [] };
	const tools = harness(applyDeps(MEDIA_CSS, capture));
	const { details } = await run(tools.get("design_system_apply"), {
		changes: [{ name: "--heading-size", light: "10rem", media: "(min-width: 768px)" }],
	});
	assert.equal(details.ok, true);
	assert.equal(capture.calls.length, 1);
	const written = capture.calls[0]!.content;
	// The original base --heading-size (3.5rem) must still be there
	assert.ok(written.includes("--heading-size: 3.5rem;"));
	// The media one changed
	assert.ok(written.includes("--heading-size: 10rem;"));
	// The dark @media block must be unchanged
	assert.ok(written.includes("--glow: #FFD700;"));
});

test("apply to a nonexistent @media breakpoint rejects the entire write", async () => {
	const capture: WriteCapture = { calls: [] };
	const tools = harness(applyDeps(MEDIA_CSS, capture));
	const { text, details } = await run(tools.get("design_system_apply"), {
		changes: [{ name: "--heading-size", light: "10rem", media: "(min-width: 1024px)" }],
	});
	assert.equal(details.ok, false);
	assert.ok(text.includes("--heading-size"));
	assert.equal(capture.calls.length, 0, "no file should have been written");
});

test("apply to base block leaves @media blocks byte-identical", async () => {
	const capture: WriteCapture = { calls: [] };
	const tools = harness(applyDeps(MEDIA_CSS, capture));
	const { details } = await run(tools.get("design_system_apply"), {
		changes: [{ name: "--accent", light: "#FF0000" }],
	});
	assert.equal(details.ok, true);
	const written = capture.calls[0]!.content;
	// Check the media blocks are untouched
	const mediaLightBlock = "@media (min-width: 768px) {\n\t:root {\n\t\t--heading-size: 8rem;\n\t}\n}";
	assert.ok(written.includes(mediaLightBlock), "light @media block must be untouched");
	const mediaDarkBlock = "@media (min-width: 768px) {\n\t.dark {\n\t\t--glow: #FFD700;\n\t}\n}";
	assert.ok(written.includes(mediaDarkBlock), "dark @media block must be untouched");
});

// ================================================================
// USAGE TESTS
// ================================================================

test("usage scan counts var(--name) references in fixture files", async (t) => {
	const root = await tempRoot(t);
	// Create fixture source files
	const srcDir = join(root, "usage-scan", "src");
	mkdirSync(srcDir, { recursive: true });
	writeFileSync(
		join(srcDir, "page.tsx"),
		`export default function Page() {
  return <div className="bg-[var(--background)]" style={{ color: "var(--accent)" }}>
    <span style={{ color: "var(--accent)" }}>hi</span>
    <span style={{ color: "var(--background)" }}>bye</span>
  </div>;
}`,
		"utf8",
	);
	writeFileSync(
		join(srcDir, "global.css"),
		`:root { color: var(--accent); }\n.hero { background: var(--glow); }`,
		"utf8",
	);

	const usageRoot = join(root, "usage-scan");
	const tools = harness(loadDeps(root, BASE_CSS, usageRoot));
	await run(tools.get("design_system_load"), {});

	const receipt = JSON.parse(readFileSync(join(root, "design", "system", "samantha-ui", "receipt.json"), "utf8"));
	assert.equal(receipt.usage["--background"], 2);
	assert.equal(receipt.usage["--accent"], 3);
	assert.equal(receipt.usage["--glow"], 1);
});

test("unreferenced tokens show usage 0, not undefined", async (t) => {
	const root = await tempRoot(t);
	const srcDir = join(root, "usage-scan", "src");
	mkdirSync(srcDir, { recursive: true });
	writeFileSync(join(srcDir, "empty.tsx"), "export default function Empty() { return null; }", "utf8");

	const usageRoot = join(root, "usage-scan");
	const tools = harness(loadDeps(root, BASE_CSS, usageRoot));
	await run(tools.get("design_system_load"), {});

	const receipt = JSON.parse(readFileSync(join(root, "design", "system", "samantha-ui", "receipt.json"), "utf8"));
	assert.equal(receipt.usage["--background"], 0);
	assert.equal(receipt.usage["--accent"], 0);
	assert.equal(receipt.usage["--glow"], 0);
});

// ================================================================
// REVIEW TESTS
// ================================================================

test("review reports changed tokens when CSS differs from snapshot", async (t) => {
	const root = await tempRoot(t);
	const snapshot = BASE_CSS;
	const current = BASE_CSS.replace("#FFFFFF", "#F5F5F5").replace("#C2A878", "#GOLDEN");

	const tools = harness({
		repoRoot: root,
		now: () => ISO,
		headOf: async () => "abc123",
		readSource: async (path: string) => {
			if (path.includes("snapshot.css")) return snapshot;
			return current;
		},
		usageScanRoot: join(root, "no-scan"),
	});
	const { text, details } = await run(tools.get("design_system_review"), {});
	assert.equal(details.ok, true);
	const changes = details.changes as Array<{ name: string; side: string; type: string }>;
	assert.ok(changes.length > 0);
	assert.ok(changes.some((c) => c.name === "--background" && c.side === "light" && c.type === "changed"));
	assert.ok(changes.some((c) => c.name === "--glow" && c.side === "dark" && c.type === "changed"));
	assert.ok(text.includes("--background"));
});

test("review reports no changes when CSS matches snapshot", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({
		repoRoot: root,
		now: () => ISO,
		headOf: async () => "abc123",
		readSource: async () => BASE_CSS,
		usageScanRoot: join(root, "no-scan"),
	});
	const { text, details } = await run(tools.get("design_system_review"), {});
	assert.equal(details.ok, true);
	const changes = details.changes as Array<unknown>;
	assert.equal(changes.length, 0);
	assert.ok(text.includes("No token changes"));
});

test("review tells her to load first when no snapshot exists", async (t) => {
	const root = await tempRoot(t);
	const tools = harness({
		repoRoot: root,
		now: () => ISO,
		headOf: async () => "abc123",
		readSource: async (path: string) => {
			if (path.includes("snapshot.css")) throw new Error("ENOENT");
			return BASE_CSS;
		},
		usageScanRoot: join(root, "no-scan"),
	});
	const { text, details } = await run(tools.get("design_system_review"), {});
	assert.equal(details.ok, false);
	assert.equal(details.reason, "no-snapshot");
	assert.ok(text.includes("design_system_load"));
});

test("review detects added and removed tokens", async (t) => {
	const root = await tempRoot(t);
	const snapshot = BASE_CSS;
	const current = `/* tokens */
:root {
\t--background: #FFFFFF;
\t--new-token: #123456;
}
.dark {
\t--background: #0B0B0B;
\t--glow: #C2A878;
}
`;
	const tools = harness({
		repoRoot: root,
		now: () => ISO,
		headOf: async () => "abc123",
		readSource: async (path: string) => {
			if (path.includes("snapshot.css")) return snapshot;
			return current;
		},
		usageScanRoot: join(root, "no-scan"),
	});
	const { details } = await run(tools.get("design_system_review"), {});
	assert.equal(details.ok, true);
	const changes = details.changes as Array<{ name: string; type: string }>;
	assert.ok(changes.some((c) => c.name === "--accent" && c.type === "removed"));
	assert.ok(changes.some((c) => c.name === "--new-token" && c.type === "added"));
});

test("load saves a snapshot.css of the original source", async (t) => {
	const root = await tempRoot(t);
	const tools = harness(loadDeps(root, BASE_CSS));
	await run(tools.get("design_system_load"), {});
	const snapshotPath = join(root, "design", "system", "samantha-ui", "snapshot.css");
	const snapshot = readFileSync(snapshotPath, "utf8");
	assert.equal(snapshot, BASE_CSS, "snapshot must be the raw source CSS, not generated");
});
