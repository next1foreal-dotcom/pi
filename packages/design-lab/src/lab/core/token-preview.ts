import { labFs } from "./fs-client";
import { scopeTokenCss } from "./scope-token-css";

const SCOPE = ".layer";

/**
 * Hang a scoped token stylesheet on the canvas layer.
 * `null` removes it. Preview only — nothing is written to disk.
 *
 * On install, fetches any persisted scratch-set CSS from the dev server
 * and applies it immediately — so a fresh Playwright page already has
 * the overrides without anyone calling `preview()` first.
 */
export function installTokenPreview(
	getLayer: () => HTMLElement | null,
	fetchScratch: () => Promise<{ ok: boolean; text?: string }> = () => labFs.scratchCss(),
): { preview(css: string | null): void; destroy(): void } {
	let el: HTMLStyleElement | null = null;
	const preview = (css: string | null) => {
		if (css == null) {
			el?.remove();
			el = null;
			return;
		}
		const layer = getLayer();
		if (!el || !el.isConnected) {
			el = document.createElement("style");
			el.dataset.tokenPreview = "";
			(layer ?? document.head).appendChild(el);
		} else if (layer && el.parentElement !== layer) {
			layer.appendChild(el);
		}
		el.textContent = scopeTokenCss(css, SCOPE);
	};

	// Boot-time: fetch the persisted scratch set and apply it.
	// A failed fetch is silent — the lab must still mount when there is no dev server.
	fetchScratch().then((result) => {
		if (result.ok && result.text) {
			preview(result.text);
		}
	}).catch(() => {
		// Silently ignore — no dev server, no scratch set, no problem.
	});

	return {
		preview,
		destroy() {
			el?.remove();
			el = null;
		},
	};
}
