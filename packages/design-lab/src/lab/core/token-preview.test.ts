// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { publishPluginApis } from "../plugin-api";
import { installTokenPreview } from "./token-preview";

describe("window.lab.tokens.preview", () => {
	afterEach(() => {
		window.lab = undefined;
		document.body.innerHTML = "";
		for (const el of document.querySelectorAll("style[data-token-preview]"))
			el.remove();
		document.getElementById("token-preview-hud-base")?.remove();
	});

	function mountLabDom() {
		const layer = document.createElement("div");
		layer.className = "layer";
		layer.dataset.labLayer = "";
		const inside = document.createElement("div");
		inside.dataset.screen = "";
		layer.appendChild(inside);
		const hud = document.createElement("div");
		hud.className = "hud";
		hud.dataset.labChrome = "";
		hud.textContent = "hud";
		document.body.append(layer, hud);
		const base = document.createElement("style");
		base.id = "token-preview-hud-base";
		base.textContent = ".hud { color: rgb(18, 18, 18); }";
		document.head.appendChild(base);
		publishPluginApis([], () => {});
		return { layer, hud };
	}

	it("preview(null) removes the style element", () => {
		const { layer } = mountLabDom();
		window.lab?.tokens.preview(":root { --bg: white; }");
		expect(layer.querySelector("style[data-token-preview]")).not.toBeNull();
		window.lab?.tokens.preview(null);
		expect(document.querySelector("style[data-token-preview]")).toBeNull();
	});

	it("does not change a HUD element's computed color", () => {
		const { hud } = mountLabDom();
		const before = getComputedStyle(hud).color;
		window.lab?.tokens.preview(
			":root, .hud { color: rgb(255, 0, 0) !important; }",
		);
		expect(getComputedStyle(hud).color).toBe(before);
		expect(getComputedStyle(hud).color).not.toBe("rgb(255, 0, 0)");
	});
});

describe("boot invariant: scratch set applied on install", () => {
	afterEach(() => {
		document.body.innerHTML = "";
		for (const el of document.querySelectorAll("style[data-token-preview]"))
			el.remove();
	});

	it("fetches and applies persisted scratch CSS on install without manual preview()", async () => {
		const layer = document.createElement("div");
		layer.className = "layer";
		document.body.appendChild(layer);

		const scratchCss = ":root { --bg: oklch(0.98 0.01 85); }";
		const fetchScratch = vi.fn().mockResolvedValue({ ok: true, text: scratchCss });

		installTokenPreview(() => layer, fetchScratch);

		// Wait for the async boot fetch to complete
		await vi.waitFor(() => {
			const style = layer.querySelector("style[data-token-preview]");
			expect(style).not.toBeNull();
			expect(style!.textContent).toContain("--bg: oklch(0.98 0.01 85)");
		});

		expect(fetchScratch).toHaveBeenCalledOnce();
	});

	it("mounts silently when the fetch fails (no dev server)", async () => {
		const layer = document.createElement("div");
		layer.className = "layer";
		document.body.appendChild(layer);

		const fetchScratch = vi.fn().mockResolvedValue({ ok: false, error: "dev-server-only" });

		const handle = installTokenPreview(() => layer, fetchScratch);

		// Give the async fetch time to settle
		await new Promise((r) => setTimeout(r, 50));

		// No style injected — lab still works
		expect(layer.querySelector("style[data-token-preview]")).toBeNull();
		expect(fetchScratch).toHaveBeenCalledOnce();

		// preview() still works manually after a failed boot fetch
		handle.preview(":root { --x: 1; }");
		expect(layer.querySelector("style[data-token-preview]")).not.toBeNull();
	});

	it("does not inject a style when the scratch set is empty", async () => {
		const layer = document.createElement("div");
		layer.className = "layer";
		document.body.appendChild(layer);

		const fetchScratch = vi.fn().mockResolvedValue({ ok: true, text: "" });

		installTokenPreview(() => layer, fetchScratch);

		await new Promise((r) => setTimeout(r, 50));

		expect(layer.querySelector("style[data-token-preview]")).toBeNull();
	});
});
