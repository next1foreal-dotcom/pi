import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type ElementEditDeps,
	type LabSelection,
	type PickResult,
	registerElementEditTools,
} from "../src/preview/element-edit.ts";

const SCREEN = "packages/design-lab/src/screens/probe/screen.tsx";

/**
 * Two buttons carrying the same class, so "only that tag changes" is a claim the
 * fixture can actually falsify, plus one computed class list to be refused.
 * Written with tabs, so a column is a character and the numbers below are the
 * numbers the inspect plugin would report.
 */
const FIXTURE = [
	`import { cn } from "./cn";`,
	``,
	`export function Probe({ active }: { active: boolean }) {`,
	`\treturn (`,
	`\t\t<div className="wrap gap-2">`,
	`\t\t\t<button type="button" className="btn primary rounded">`,
	`\t\t\t\tBuy`,
	`\t\t\t</button>`,
	`\t\t\t<button type="button" className="btn ghost">`,
	`\t\t\t\tCancel`,
	`\t\t\t</button>`,
	`\t\t\t<span className={cn("chip", active && "on")}>tag</span>`,
	`\t\t\t<hr />`,
	`\t\t</div>`,
	`\t);`,
	`}`,
	``,
].join("\n");

/**
 * 1-based line/column of the `<` that opens `needle` — the same convention the
 * inspect plugin reports and packages/design-lab's own probe test asserts
 * (`text.split("\n")[line - 1].slice(column - 1).startsWith("<button")`).
 */
function locate(source: string, needle: string): { line: number; column: number } {
	const index = source.indexOf(needle);
	assert.ok(index >= 0, `the fixture has no ${needle}`);
	const before = source.slice(0, index);
	return { line: before.split("\n").length, column: index - before.lastIndexOf("\n") };
}

function harness(deps: ElementEditDeps): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerElementEditTools(pi, deps);
	return tools;
}

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ type: string; text?: string }>;
		details?: Record<string, unknown>;
	};
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return { text, details: result.details ?? {} };
}

/** A repo root holding just the fixture screen. */
async function repoWithFixture(t: test.TestContext): Promise<{ root: string; path: string }> {
	const root = await mkdtemp(join(tmpdir(), "her-element-edit-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, SCREEN);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, FIXTURE);
	return { root, path };
}

/** Every dep a source edit must never reach for: touching the browser here is a bug. */
function noBrowser(root: string): ElementEditDeps {
	return {
		repoRoot: root,
		probePort: async () => {
			throw new Error("editing source must not probe the lab port");
		},
		pick: async () => {
			throw new Error("editing source must not launch a browser");
		},
	};
}

const WRAPPER_DIV = `<div className="wrap gap-2">`;
const FIRST_BUTTON = `<button type="button" className="btn primary rounded">`;
const SECOND_BUTTON = `<button type="button" className="btn ghost">`;
const DYNAMIC_SPAN = `<span className={cn("chip", active && "on")}>`;

test("a class added at a verified location lands in the file, and only that tag changes", async (t) => {
	const { root, path } = await repoWithFixture(t);
	const tools = harness(noBrowser(root));
	const at = locate(FIXTURE, FIRST_BUTTON);

	const { text, details } = await run(tools.get("design_element_classes"), {
		file: SCREEN,
		line: at.line,
		column: at.column,
		tag: "button",
		add: "p-4",
	});

	assert.equal(details.ok, true);
	assert.equal(details.changed, true);
	assert.equal(details.after, "btn primary rounded p-4");
	assert.match(text, /design_lab_still/);

	// Byte-for-byte: the whole file, with exactly one attribute value different.
	const after = await readFile(path, "utf8");
	assert.equal(after, FIXTURE.replace(`"btn primary rounded"`, `"btn primary rounded p-4"`));
	// The other button carries the same "btn" class and must be untouched.
	assert.ok(after.includes(SECOND_BUTTON), "the second button's class list was rewritten too");
});

test("a class removed leaves the rest of the list and its order alone", async (t) => {
	const { root, path } = await repoWithFixture(t);
	const tools = harness(noBrowser(root));
	const at = locate(FIXTURE, FIRST_BUTTON);

	const { details } = await run(tools.get("design_element_classes"), {
		file: SCREEN,
		line: at.line,
		column: at.column,
		tag: "button",
		remove: "primary",
	});

	assert.equal(details.ok, true);
	assert.equal(details.after, "btn rounded");
	assert.equal(await readFile(path, "utf8"), FIXTURE.replace(`"btn primary rounded"`, `"btn rounded"`));
});

test("removing the first class keeps the survivors' spacing, and a class that is not there is reported", async (t) => {
	const { root, path } = await repoWithFixture(t);
	const tools = harness(noBrowser(root));
	const at = locate(FIXTURE, FIRST_BUTTON);

	const { text, details } = await run(tools.get("design_element_classes"), {
		file: SCREEN,
		line: at.line,
		column: at.column,
		tag: "button",
		remove: "btn nonexistent",
	});

	assert.equal(details.after, "primary rounded");
	assert.match(text, /Not on the tag, so not removed: nonexistent/);
	assert.equal(await readFile(path, "utf8"), FIXTURE.replace(`"btn primary rounded"`, `"primary rounded"`));
});

test("a location whose tag no longer matches is refused, and the file is untouched", async (t) => {
	const { root, path } = await repoWithFixture(t);
	const tools = harness(noBrowser(root));
	// The location she captured said <button>; the file now has <div> there. The
	// div's class list is a plain string, so nothing downstream would stop this —
	// the tag check is the only thing standing between her and the wrong element.
	const at = locate(FIXTURE, WRAPPER_DIV);

	const { text, details } = await run(tools.get("design_element_classes"), {
		file: SCREEN,
		line: at.line,
		column: at.column,
		tag: "button",
		add: "p-4",
	});

	assert.equal(details.ok, false);
	assert.equal(details.problem, "tag-mismatch");
	assert.match(text, /is <div>, not <button>/);
	assert.match(text, /design_element_at/);
	assert.equal(await readFile(path, "utf8"), FIXTURE);
});

test("a stale location pointing at another tag with the same name is still refused", async (t) => {
	const { root, path } = await repoWithFixture(t);
	const tools = harness(noBrowser(root));
	// One line off: the caller means the first button, the location now names the
	// text node line under it. Same file, same component, wrong place.
	const at = locate(FIXTURE, FIRST_BUTTON);

	const { details } = await run(tools.get("design_element_classes"), {
		file: SCREEN,
		line: at.line + 1,
		column: at.column,
		tag: "button",
		add: "p-4",
	});

	assert.equal(details.ok, false);
	assert.equal(await readFile(path, "utf8"), FIXTURE);
});

test("a column that is not the start of a tag is refused as stale, and the file is untouched", async (t) => {
	const { root, path } = await repoWithFixture(t);
	const tools = harness(noBrowser(root));
	const at = locate(FIXTURE, FIRST_BUTTON);

	const { text, details } = await run(tools.get("design_element_classes"), {
		file: SCREEN,
		line: at.line,
		column: at.column + 1,
		tag: "button",
		add: "p-4",
	});

	assert.equal(details.ok, false);
	assert.equal(details.problem, "tag-mismatch");
	assert.match(text, /not the "<" of a tag/);
	assert.equal(await readFile(path, "utf8"), FIXTURE);
});

test("a dynamic className is refused by name, and the file is untouched", async (t) => {
	const { root, path } = await repoWithFixture(t);
	const tools = harness(noBrowser(root));
	const at = locate(FIXTURE, DYNAMIC_SPAN);

	const { text, details } = await run(tools.get("design_element_classes"), {
		file: SCREEN,
		line: at.line,
		column: at.column,
		tag: "span",
		add: "p-4",
	});

	assert.equal(details.ok, false);
	assert.equal(details.problem, "dynamic-class-list");
	assert.match(text, /a call to cn\(\.\.\.\)/);
	assert.equal(await readFile(path, "utf8"), FIXTURE);
});

test("replace rewrites the whole list but has to be asked for alone", async (t) => {
	const { root, path } = await repoWithFixture(t);
	const tools = harness(noBrowser(root));
	const at = locate(FIXTURE, FIRST_BUTTON);
	const params = { file: SCREEN, line: at.line, column: at.column, tag: "button" };

	const mixed = await run(tools.get("design_element_classes"), { ...params, replace: "only", add: "p-4" });
	assert.equal(mixed.details.ok, false);
	assert.match(mixed.text, /cannot be combined with add or remove/);
	assert.equal(await readFile(path, "utf8"), FIXTURE, "a refused call must not write");

	const replaced = await run(tools.get("design_element_classes"), { ...params, replace: "only p-4" });
	assert.equal(replaced.details.after, "only p-4");
	assert.equal(await readFile(path, "utf8"), FIXTURE.replace(`"btn primary rounded"`, `"only p-4"`));
});

test("a class name that would break the file out of its own attribute is refused", async (t) => {
	const { root, path } = await repoWithFixture(t);
	const tools = harness(noBrowser(root));
	const at = locate(FIXTURE, FIRST_BUTTON);

	const { details } = await run(tools.get("design_element_classes"), {
		file: SCREEN,
		line: at.line,
		column: at.column,
		tag: "button",
		add: `x"onClick={boom}`,
	});

	assert.equal(details.ok, false);
	assert.equal(details.problem, "unsafe-class-name");
	assert.equal(await readFile(path, "utf8"), FIXTURE);
});

test("a tag with no className gets one from add, and nothing else moves", async (t) => {
	const { root, path } = await repoWithFixture(t);
	const tools = harness(noBrowser(root));
	const at = locate(FIXTURE, "<hr />");

	const { details } = await run(tools.get("design_element_classes"), {
		file: SCREEN,
		line: at.line,
		column: at.column,
		tag: "hr",
		add: "my-4",
	});

	assert.equal(details.ok, true);
	assert.equal(await readFile(path, "utf8"), FIXTURE.replace(`<hr />`, `<hr className="my-4" />`));
});

test("it only opens .tsx and .jsx inside the repo", async (t) => {
	const { root } = await repoWithFixture(t);
	const tools = harness(noBrowser(root));
	const params = { line: 1, column: 1, tag: "button", add: "p-4" };

	const policy = await run(tools.get("design_element_classes"), {
		...params,
		file: "packages/her/pi-package/policies/her-trust.cedar",
	});
	assert.equal(policy.details.ok, false);
	assert.match(policy.text, /only opens \.tsx and \.jsx/);

	const outside = await run(tools.get("design_element_classes"), { ...params, file: "../outside/screen.tsx" });
	assert.equal(outside.details.ok, false);
	assert.match(outside.text, /outside the repo/);
});

test("a call that changes nothing says so instead of rewriting the file", async (t) => {
	const { root, path } = await repoWithFixture(t);
	const tools = harness(noBrowser(root));
	const at = locate(FIXTURE, FIRST_BUTTON);

	const { text, details } = await run(tools.get("design_element_classes"), {
		file: SCREEN,
		line: at.line,
		column: at.column,
		tag: "button",
		add: "btn",
	});

	assert.equal(details.changed, false);
	assert.match(text, /Already there: btn/);
	assert.equal(await readFile(path, "utf8"), FIXTURE);
});

// --- design_element_at ------------------------------------------------------

const SELECTION: LabSelection = {
	screenId: "probe",
	file: SCREEN,
	line: 6,
	column: 4,
	component: "Probe",
	tag: "button",
	className: "btn primary rounded",
	text: "Buy",
	attached: true,
	problem: null,
};

function pickResult(over: Partial<PickResult> = {}): PickResult {
	return {
		screenIds: ["probe"],
		found: true,
		selection: SELECTION,
		geometry: {
			screen: { width: 1200, height: 900, scrollWidth: 1200, scrollHeight: 1800 },
			point: { x: 120, y: 240 },
			client: { x: 300, y: 400 },
			scale: 0.75,
			scroll: { top: 0, left: 0 },
			viewport: { width: 1500, height: 1000 },
		},
		box: { x: 100, y: 230, width: 140, height: 40 },
		...over,
	};
}

test("design_element_at returns the selection for a point", async () => {
	const asked: unknown[] = [];
	const tools = harness({
		repoRoot: "/nowhere",
		probePort: async () => true,
		pick: async (request) => {
			asked.push(request);
			return pickResult();
		},
	});

	const { text, details } = await run(tools.get("design_element_at"), { screenId: "probe", x: 120, y: 240 });

	assert.deepEqual(asked, [{ screenId: "probe", x: 120, y: 240, port: 5180 }]);
	assert.equal(details.ok, true);
	assert.deepEqual(details.selection, SELECTION);
	assert.match(text, /<button> rendered by Probe/);
	assert.match(text, new RegExp(`${SCREEN.replaceAll(".", "\\.")}:6:4`));
	assert.match(text, /btn primary rounded/);
});

test("design_element_at skips, not fails, when the lab is down", async () => {
	const tools = harness({
		repoRoot: "/nowhere",
		probePort: async () => false,
		pick: async () => {
			throw new Error("must not launch a browser when the lab is down");
		},
	});

	const { text, details } = await run(tools.get("design_element_at"), { screenId: "probe", x: 10, y: 10 });

	assert.equal(details.skipped, true);
	assert.equal(details.ok, false);
	assert.match(text, /design_lab_open/);
});

test("an unknown screen id answers with the ids that are on the canvas", async () => {
	const tools = harness({
		repoRoot: "/nowhere",
		probePort: async () => true,
		pick: async () => ({ screenIds: ["probe", "landing"], found: false, selection: null }),
	});

	const { text, details } = await run(tools.get("design_element_at"), { screenId: "typo", x: 1, y: 1 });

	assert.equal(details.ok, false);
	assert.match(text, /probe, landing/);
});

test("a point that hits nothing says how big the screen is instead of guessing", async () => {
	const tools = harness({
		repoRoot: "/nowhere",
		probePort: async () => true,
		pick: async () => pickResult({ selection: null, box: undefined }),
	});

	const { text, details } = await run(tools.get("design_element_at"), { screenId: "probe", x: 5, y: 5 });

	assert.equal(details.ok, false);
	assert.equal(details.reason, "nothing-there");
	assert.match(text, /1200×900/);
	assert.match(text, /content runs to 1800/);
});

test("a point off the viewport is named as such, with the numbers to aim by", async () => {
	const tools = harness({
		repoRoot: "/nowhere",
		probePort: async () => true,
		pick: async () => pickResult({ selection: null, offscreen: true, box: undefined }),
	});

	const { text, details } = await run(tools.get("design_element_at"), { screenId: "probe", x: 9999, y: 9999 });

	assert.equal(details.reason, "point-offscreen");
	assert.match(text, /off the browser viewport/);
	assert.match(text, /0\.75x/);
});

test("a screenId with a quote in it never reaches the page", async () => {
	const tools = harness({
		repoRoot: "/nowhere",
		probePort: async () => {
			throw new Error("a rejected screenId must not probe the port");
		},
		pick: async () => {
			throw new Error("a rejected screenId must not reach the browser");
		},
	});

	const { details, text } = await run(tools.get("design_element_at"), { screenId: `x"] , [data-x="`, x: 1, y: 1 });

	assert.equal(details.ok, false);
	assert.match(text, /letters, digits, dot, dash and underscore only/);
});
