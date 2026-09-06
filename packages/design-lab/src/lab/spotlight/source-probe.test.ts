// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { transformWithOxc } from "vite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProbeCard } from "../plugins/inspect/probe-fixture";
import {
	LAB_PACKAGE_DIR,
	primeSourceLocations,
} from "../plugins/inspect/source-location";
import { resetSourceMaps } from "../sourcemap/cache";
import { sourceOf } from "./source-probe";

/**
 * These tests render React for real. The previous ones did not: they hung a
 * hand-written stack string on a hand-built fiber, which proves the parser and
 * proves nothing about the mechanism. That is how this file shipped a resolver
 * that had never resolved a real element.
 *
 * The fixture lives with the inspect plugin because a fixture has to be a .tsx
 * and vitest only collects `src/**\/*.test.ts`. One fixture, borrowed here.
 */
function findRepoRoot(): string {
	let dir = process.cwd();
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, LAB_PACKAGE_DIR, "package.json"))) return dir;
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	throw new Error(`repo root not found from ${process.cwd()}`);
}
const REPO_ROOT = findRepoRoot();

async function renderProbe(): Promise<Element> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(createElement(ProbeCard));
	});
	const el = host.querySelector(".probe-button");
	if (!el) throw new Error("probe did not render");
	return el;
}

describe("sourceOf", () => {
	it("names the line of a really-rendered element, and the file really says so there", async () => {
		const ref = sourceOf(await renderProbe());
		expect(ref).not.toBeNull();
		const { file, line, col, component } = ref as NonNullable<typeof ref>;

		// Repo-relative, not relative to this package: she has to be able to open it.
		expect(file.startsWith(`${LAB_PACKAGE_DIR}/`)).toBe(true);
		expect(component).toBe("ProbeCard");

		// A plausible-looking location is not good enough. Go and look.
		const text = readFileSync(join(REPO_ROOT, file), "utf8");
		const target = text.split("\n")[line - 1] ?? "";
		expect(target.slice(col - 1)).toMatch(/^<button/);
	});

	it("returns null for a node React did not make", () => {
		expect(sourceOf(document.createElement("div"))).toBeNull();
	});

	it("returns null, and does not throw, when the build carries no debug stack", () => {
		const el = document.createElement("div");
		Object.assign(el, { __reactFiber$test: { _debugStack: undefined, return: null } });
		expect(sourceOf(el)).toBeNull();
	});
});

/**
 * The chip and the pinned note in the running lab.
 *
 * Under vitest a stack is already mapped home, so the case that matters here
 * cannot happen by rendering: a browser hands over coordinates in the module
 * vite built. `pick.ts` writes whatever comes back onto a note she will open
 * later, so a wrong line here is a wrong line in a file she edits — the reason
 * this returns null rather than the unmapped numbers.
 */
describe("sourceOf, in the browser's coordinates", () => {
	const FIXTURE_REL = "src/lab/plugins/inspect/probe-fixture.tsx";
	const FIXTURE = `${LAB_PACKAGE_DIR}/${FIXTURE_REL}`;
	const MODULE_URL = `http://localhost:5180/${FIXTURE_REL}?t=64`;

	let servedModule = "";
	let servedButton = { line: 0, column: 0 };

	beforeAll(async () => {
		const out = await transformWithOxc(
			readFileSync(join(REPO_ROOT, FIXTURE), "utf8"),
			"probe-fixture.tsx",
			{ lang: "tsx", jsx: { runtime: "automatic", development: true }, sourcemap: true },
		);
		if (!out.map) throw new Error("the transform produced no source map");
		const base64 = Buffer.from(JSON.stringify(out.map), "utf8").toString("base64");
		servedModule = `${out.code}\n//# sourceMappingURL=data:application/json;base64,${base64}\n`;
		out.code.split("\n").forEach((text, i) => {
			const at = text.indexOf('_jsxDEV("button"');
			if (at >= 0 && servedButton.line === 0) servedButton = { line: i + 1, column: at + 1 };
		});
		if (servedButton.line === 0) throw new Error("no button call in the module");
	});

	function servedNode(): Element {
		const el = document.createElement("button");
		Object.assign(el, {
			__reactFiber$served: {
				_debugStack: {
					stack: [
						"Error: react-stack-top-frame",
						`    at ProbeCard (${MODULE_URL}:${servedButton.line}:${servedButton.column})`,
					].join("\n"),
				},
				return: null,
			},
		});
		document.body.appendChild(el);
		return el;
	}

	function serveModule() {
		const stub = (input: unknown): Promise<{ ok: boolean; text: () => Promise<string> }> =>
			Promise.resolve(
				String(input) === MODULE_URL
					? { ok: true, text: () => Promise.resolve(servedModule) }
					: { ok: false, text: () => Promise.resolve("") },
			);
		return vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(stub as unknown as typeof fetch);
	}

	beforeEach(() => {
		resetSourceMaps();
		document.body.innerHTML = "";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSourceMaps();
		document.body.innerHTML = "";
	});

	it("names the source line, not the line in the module vite served", async () => {
		expect(servedButton.line).not.toBe(9);
		serveModule();
		const el = servedNode();
		await primeSourceLocations(document);

		const ref = sourceOf(el);
		expect(ref).toEqual({ file: FIXTURE, line: 9, col: 7, component: "ProbeCard" });
	});

	it("answers null, not the served numbers, before the map has been read", () => {
		serveModule();
		expect(sourceOf(servedNode())).toBeNull();
	});

	it("answers null when the map cannot be read at all", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
		const el = servedNode();
		await primeSourceLocations(document);
		expect(sourceOf(el)).toBeNull();
	});
});
