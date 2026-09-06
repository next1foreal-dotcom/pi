// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ProbeCard } from "../plugins/inspect/probe-fixture";
import { LAB_PACKAGE_DIR } from "../plugins/inspect/source-location";
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
