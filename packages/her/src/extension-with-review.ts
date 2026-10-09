import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import her from "./extension.ts";
import { resolveGovernedTool } from "./lib/governed-tools.ts";
import { registerRuntimeReview } from "./runtime-review/extension.ts";

/** Keep Cedar and the existing Her tools; add receipt-based runtime supervision. */
export default function herWithReview(pi: ExtensionAPI): void {
	her(pi);
	registerRuntimeReview(pi, (tool) => resolveGovernedTool(tool).destructive);
}
