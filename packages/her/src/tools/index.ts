import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerArchiveTool } from "./archive.ts";
import { registerConvertTool } from "./convert.ts";
import { registerImgminTool } from "./imgmin.ts";
import { SystemToolLocator, type ToolLocator } from "./locate.ts";
import { registerOcrTool } from "./ocr.ts";
import { registerPdfTool } from "./pdf.ts";
import { type CommandRunner, SpawnRunner } from "./runner.ts";

export interface ToolkitDeps {
	locator?: ToolLocator;
	runner?: CommandRunner;
}

/**
 * Register the five file-craft organs (her_convert / her_ocr / her_archive /
 * her_imgmin / her_pdf). Frozen from the convert/ocr/archive/imgmin/pdfkit
 * skills (G-53) so they run as native tools instead of prose recipes. Deps are
 * injectable for tests; production wires the real binary locator and spawner.
 */
export function registerFileToolkit(pi: ExtensionAPI, deps: ToolkitDeps = {}): void {
	const wired = {
		locator: deps.locator ?? new SystemToolLocator(),
		runner: deps.runner ?? new SpawnRunner(),
	};
	registerConvertTool(pi, wired);
	registerOcrTool(pi, wired);
	registerArchiveTool(pi, wired);
	registerImgminTool(pi, wired);
	registerPdfTool(pi, wired);
}
