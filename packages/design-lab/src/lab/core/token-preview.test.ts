// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { publishPluginApis } from "../plugin-api";

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
