import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { governedTools } from "../src/lib/governed-tools.ts";
import { type ExtractDesignDeps, extractDesignMd, registerExtractDesignTools } from "../src/preview/extract-design.ts";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "design-extract");

type FetchCall = { url: string; init: RequestInit };
type FakeFetch = typeof fetch & { calls: FetchCall[] };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FakeFetch {
	const calls: FetchCall[] = [];
	const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init: init ?? {} });
		return await handler(url, init ?? {});
	}) as FakeFetch;
	impl.calls = calls;
	return impl;
}

function htmlResponse(body: string, contentType = "text/html"): Response {
	return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

function extractHarness(deps: ExtractDesignDeps = {}) {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerExtractDesignTools(pi, deps);
	return tools;
}

async function runTool(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
}

function oversizedHtml(): string {
	const vars = Array.from(
		{ length: 80 },
		(_, i) => `--v${i}:ident-${"x".repeat(300)}-${i.toString(16).padStart(3, "0")}`,
	).join(";");
	const colors = Array.from({ length: 40 }, (_, i) => `.c${i}{color:#b${i.toString(16).padStart(5, "0")}}`).join("");
	const fonts = Array.from({ length: 16 }, (_, i) => `.f${i}{font-family:Face${i},sans-serif}`).join("");
	const px = Array.from({ length: 20 }, (_, i) => `.px${i}{font-size:${8 + i}px}`).join("");
	const rem = Array.from({ length: 20 }, (_, i) => `.rm${i}{font-size:${(0.5 + i * 0.25).toFixed(2)}rem}`).join("");
	const radii = Array.from({ length: 14 }, (_, i) => `.rd${i}{border-radius:${2 + i * 2}px}`).join("");
	const shadows = Array.from(
		{ length: 10 },
		(_, i) => `.sh${i}{box-shadow:0 ${i + 1}px ${2 * (i + 1)}px rgba(0,0,0,0.${i + 1})}`,
	).join("");
	const durations = Array.from({ length: 24 }, (_, i) => `.d${i}{transition-duration:${100 + i * 20}ms}`).join("");
	const easings = Array.from(
		{ length: 16 },
		(_, i) => `.e${i}{transition-timing-function:cubic-bezier(0.${i}, 0, 0.${(i + 1) % 10}, 1)}`,
	).join("");
	return `<!doctype html><html><head><style>:root{${vars}}${colors}${fonts}${px}${rem}${radii}${shadows}${durations}${easings}</style></head><body></body></html>`;
}

async function withRepoRoot<T>(fn: (repoRoot: string) => Promise<T>): Promise<T> {
	const repoRoot = await mkdtemp(join(tmpdir(), "her-extract-design-"));
	try {
		return await fn(repoRoot);
	} finally {
		await rm(repoRoot, { force: true, recursive: true });
	}
}

test("governedTools lists extract_design_md as non-destructive", () => {
	assert.equal(governedTools.extract_design_md?.destructive, false);
});

test("Motion section records durations, timing functions, cubic-bezier verbatim, and keyframe names", async () => {
	const html = await readFile(join(fixtureRoot, "motion-prm.html"), "utf8");
	await withRepoRoot(async (repoRoot) => {
		const result = await extractDesignMd(
			{ url: "https://motion.test/page" },
			{ fetchImpl: fakeFetch(() => htmlResponse(html)), repoRoot },
		);
		const md = result.markdown;
		assert.match(md, /## Motion/);
		assert.match(md, /300ms/);
		assert.match(md, /200ms/);
		assert.match(md, /500ms/);
		assert.match(md, /cubic-bezier\(0\.4, 0, 0\.2, 1\)/);
		assert.doesNotMatch(md, /cubic-bezier\(0\.40/);
		assert.match(md, /fade-in/);
		assert.match(md, /slide-up/);
		assert.match(md, /ease-in-out/);
		assert.match(md, /scroll-behavior/);
		assert.match(md, /smooth/);
		assert.match(md, /--duration-fast/);
		assert.match(md, /--ease-standard/);
		assert.match(md, /\(observed/);
	});
});

test("prefers-reduced-motion is reported as 存在 when the query is in CSS", async () => {
	const html = await readFile(join(fixtureRoot, "motion-prm.html"), "utf8");
	await withRepoRoot(async (repoRoot) => {
		const result = await extractDesignMd(
			{ url: "https://motion.test/prm" },
			{ fetchImpl: fakeFetch(() => htmlResponse(html)), repoRoot },
		);
		assert.match(result.markdown, /prefers-reduced-motion/);
		assert.match(result.markdown, /存在/);
		assert.doesNotMatch(result.markdown, /未见/);
	});
});

test("prefers-reduced-motion is reported as 未见 when the query is absent", async () => {
	const html = await readFile(join(fixtureRoot, "motion-no-prm.html"), "utf8");
	await withRepoRoot(async (repoRoot) => {
		const result = await extractDesignMd(
			{ url: "https://motion.test/no-prm" },
			{ fetchImpl: fakeFetch(() => htmlResponse(html)), repoRoot },
		);
		assert.match(result.markdown, /prefers-reduced-motion/);
		assert.match(result.markdown, /未见/);
		assert.doesNotMatch(result.markdown, /存在/);
	});
});

test("12KB budget truncates output and records the cut", async () => {
	await withRepoRoot(async (repoRoot) => {
		const result = await extractDesignMd(
			{ url: "https://huge.test/" },
			{ fetchImpl: fakeFetch(() => htmlResponse(oversizedHtml())), repoRoot },
		);
		assert.ok(result.markdown.length <= 12_000, `markdown length ${result.markdown.length} exceeds 12KB`);
		assert.match(result.markdown, /…and \d+ more/);
		assert.match(result.markdown, /Output budget applied|truncated/);
	});
});

test("non-http(s) URLs are rejected before fetch", async () => {
	const fetchImpl = fakeFetch(() => {
		throw new Error("network must not be used");
	});
	await withRepoRoot(async (repoRoot) => {
		await assert.rejects(() => extractDesignMd({ url: "file:///C:/secret.html" }, { fetchImpl, repoRoot }), /http/i);
		await assert.rejects(() => extractDesignMd({ url: "javascript:alert(1)" }, { fetchImpl, repoRoot }), /http/i);
		await assert.rejects(() => extractDesignMd({ url: "ftp://motion.test/x" }, { fetchImpl, repoRoot }), /http/i);
		await assert.rejects(() => extractDesignMd({ url: "data:text/html,hi" }, { fetchImpl, repoRoot }), /http/i);
		assert.equal(fetchImpl.calls.length, 0);
	});
});

test("transition shorthand contributes duration and cubic-bezier to both stats", async () => {
	const html = await readFile(join(fixtureRoot, "motion-no-prm.html"), "utf8");
	await withRepoRoot(async (repoRoot) => {
		const result = await extractDesignMd(
			{ url: "https://motion.test/shorthand" },
			{ fetchImpl: fakeFetch(() => htmlResponse(html)), repoRoot },
		);
		const motion = result.markdown.split("## Motion")[1]?.split("\n## ")[0] ?? "";
		assert.match(motion, /300ms/);
		assert.match(motion, /cubic-bezier\(0\.4, 0, 0\.2, 1\)/);
		const durationBlock = motion.split(/Timing functions/i)[0] ?? motion;
		assert.match(durationBlock, /300ms/);
		assert.match(motion, /Timing functions[\s\S]*cubic-bezier\(0\.4, 0, 0\.2, 1\)/i);
	});
});

test("extract_design_md writes DESIGN.md under design/extracts/<host>.md and returns path plus text", async () => {
	const html = await readFile(join(fixtureRoot, "motion-prm.html"), "utf8");
	await withRepoRoot(async (repoRoot) => {
		const tools = extractHarness({
			fetchImpl: fakeFetch(() => htmlResponse(html)),
			repoRoot,
		});
		const tool = tools.get("extract_design_md");
		assert.ok(tool, "extract_design_md must be registered");
		const { text, details } = await runTool(tool, { url: "https://motion.test/shop" });
		assert.match(String(details.path ?? ""), /design[\\/]extracts[\\/]motion\.test\.md/);
		assert.match(text, /design[\\/]extracts[\\/]motion\.test\.md/);
		assert.match(text, /## Motion/);
		const onDisk = await readFile(join(repoRoot, "design", "extracts", "motion.test.md"), "utf8");
		assert.match(onDisk, /## Motion/);
		assert.match(onDisk, /cubic-bezier\(0\.4, 0, 0\.2, 1\)/);
	});
});

test("extract_design_md tool rejects non-http(s) without fetching", async () => {
	const fetchImpl = fakeFetch(() => {
		throw new Error("network must not be used");
	});
	await withRepoRoot(async (repoRoot) => {
		const tools = extractHarness({ fetchImpl, repoRoot });
		const { text, details } = await runTool(tools.get("extract_design_md"), { url: "file:///C:/x.html" });
		assert.match(text, /http/i);
		assert.equal(details.ok, false);
		assert.equal(fetchImpl.calls.length, 0);
	});
});
