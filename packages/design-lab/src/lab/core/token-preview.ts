import { scopeTokenCss } from "./scope-token-css";

const SCOPE = ".layer";

/**
 * Hang a scoped token stylesheet on the canvas layer.
 * `null` removes it. Preview only — nothing is written to disk.
 */
export function installTokenPreview(
	getLayer: () => HTMLElement | null,
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
	return {
		preview,
		destroy() {
			el?.remove();
			el = null;
		},
	};
}
