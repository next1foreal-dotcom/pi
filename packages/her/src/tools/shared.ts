import { existsSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ToolLocation, ToolLocator } from "./locate.ts";
import type { CommandRunner } from "./runner.ts";

/** Injected dependencies shared by every file-craft tool. */
export interface ToolDeps {
	locator: ToolLocator;
	runner: CommandRunner;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

export function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

/** Uniform "<tool> not installed + winget line" message for a missing binary. */
export function missingTool(loc: ToolLocation): ToolResult {
	return textResult(`${loc.command} 未安装。安装: ${loc.winget}`);
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as Error & { cause?: unknown }).cause;
		const causeText = cause instanceof Error ? `: ${cause.message}` : "";
		return `${error.message}${causeText}`;
	}
	return String(error);
}

/** Lowercase extension without the leading dot ("Photo.PNG" -> "png"). */
export function extOf(path: string): string {
	return extname(path).replace(/^\./, "").toLowerCase();
}

/** Base name without its extension ("dir/report.docx" -> "report"). */
export function stemOf(path: string): string {
	return basename(path, extname(path));
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Percent shrunk going before -> after; negative when the file grew. */
export function savingPercent(before: number, after: number): number {
	if (before <= 0) return 0;
	return Math.round(((before - after) / before) * 100);
}

export type ExistsFn = (path: string) => boolean;

/**
 * Pick an output file path that never collides with an existing file. Appends
 * -1, -2, ... before the extension until a free name is found, so we never
 * overwrite the caller's source or a prior output.
 */
export function resolveOutputPath(dir: string, stem: string, ext: string, exists: ExistsFn = existsSync): string {
	const suffix = ext ? `.${ext}` : "";
	let candidate = join(dir, `${stem}${suffix}`);
	let n = 1;
	while (exists(candidate)) {
		candidate = join(dir, `${stem}-${n}${suffix}`);
		n++;
	}
	return candidate;
}

/** Same idea for a directory (archive unpack extracts into a fresh, non-colliding dir). */
export function resolveOutputDir(parent: string, name: string, exists: ExistsFn = existsSync): string {
	let candidate = join(parent, name);
	let n = 1;
	while (exists(candidate)) {
		candidate = join(parent, `${name}-${n}`);
		n++;
	}
	return candidate;
}

export function fileSize(path: string): number {
	return statSync(path).size;
}
