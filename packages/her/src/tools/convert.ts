import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CommandRunner, type RunResult, runSummary } from "./runner.ts";
import {
	errorMessage,
	extOf,
	fileSize,
	formatBytes,
	missingTool,
	resolveOutputPath,
	stemOf,
	type ToolDeps,
	type ToolResult,
	textResult,
} from "./shared.ts";

const CONVERT_TIMEOUT_MS = 300_000;

// Text documents pandoc handles; office formats soffice owns; a/v -> ffmpeg; raster -> magick.
const PANDOC_DOCS = new Set([
	"md",
	"markdown",
	"rst",
	"latex",
	"tex",
	"org",
	"html",
	"htm",
	"epub",
	"docx",
	"odt",
	"rtf",
	"textile",
	"mediawiki",
]);
const OFFICE = new Set(["doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "odp", "ods", "rtf"]);
const AV = new Set([
	"mp4",
	"mov",
	"avi",
	"mkv",
	"webm",
	"flv",
	"wmv",
	"m4v",
	"mpg",
	"mpeg",
	"ts",
	"mp3",
	"m4a",
	"aac",
	"wav",
	"flac",
	"ogg",
	"opus",
	"wma",
]);
const AUDIO = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma"]);
const IMG = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif", "avif", "ico"]);

export type ConvertRoute =
	| { kind: "pandoc" }
	| { kind: "soffice"; convertTo: string }
	| { kind: "ffmpeg"; variant: "video" | "audio" | "gif" }
	| { kind: "magick" }
	| { kind: "unsupported"; reason: string };

/** Pick the right tool for a source->target format pair (pure; see SKILL routing table). */
export function routeConvert(src: string, target: string): ConvertRoute {
	if (src === target) return { kind: "unsupported", reason: `源与目标都是 .${target}` };
	if (target === "pdf") {
		if (OFFICE.has(src) || src === "html" || src === "htm") return { kind: "soffice", convertTo: "pdf" };
		if (PANDOC_DOCS.has(src))
			return {
				kind: "unsupported",
				reason: `pandoc 直出 pdf 需 LaTeX 引擎(本机大概率未装)。请先 .${src}→docx 或 →html,再走 soffice →pdf。`,
			};
	}
	if (OFFICE.has(src) && OFFICE.has(target)) return { kind: "soffice", convertTo: target };
	if (PANDOC_DOCS.has(src) && PANDOC_DOCS.has(target)) return { kind: "pandoc" };
	if (AV.has(src)) {
		if (target === "gif") return { kind: "ffmpeg", variant: "gif" };
		if (AV.has(target)) return { kind: "ffmpeg", variant: AUDIO.has(target) ? "audio" : "video" };
	}
	if (IMG.has(src) && IMG.has(target)) return { kind: "magick" };
	if (src === "pdf" && (OFFICE.has(target) || PANDOC_DOCS.has(target)))
		return {
			kind: "unsupported",
			reason: `pdf→${target} 版面易错乱、保真度差,本工具不做此低质转换;需要时请用专门的 PDF→Office 工具并人工核对。`,
		};
	return { kind: "unsupported", reason: `没有从 .${src} 到 .${target} 的已知转换路径` };
}

export function registerConvertTool(pi: ExtensionAPI, deps: ToolDeps): void {
	const { locator, runner } = deps;
	pi.registerTool({
		name: "her_convert",
		label: "Convert",
		description:
			"Convert a file between formats, routing by extension: documents (md/html/epub/docx/rst/latex) via pandoc, " +
			"Office/HTML -> pdf and legacy Office -> modern via LibreOffice, audio/video via ffmpeg (video->gif uses the " +
			"two-pass palette recipe), images via ImageMagick. Writes next to the source (or outDir) with a fresh name " +
			"that never overwrites an existing file, and verifies the output is non-empty. Give target as a bare " +
			'extension like "docx", "pdf", "mp4".',
		parameters: Type.Object({
			input: Type.String(),
			target: Type.String(),
			outDir: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal) {
			const input = params.input;
			const target = params.target.replace(/^\./, "").toLowerCase();
			if (!existsSync(input)) return textResult(`输入文件不存在: ${input}`);
			const src = extOf(input);
			const route = routeConvert(src, target);
			if (route.kind === "unsupported") return textResult(`无法转换 .${src} → .${target}: ${route.reason}`);
			const outDir = params.outDir ?? dirname(input);
			try {
				await mkdir(outDir, { recursive: true });
				const out = resolveOutputPath(outDir, stemOf(input), target);
				switch (route.kind) {
					case "pandoc": {
						const loc = locator.locate("pandoc");
						if (!loc.path) return missingTool(loc);
						const result = await runner.run(loc.path, [input, "-o", out], {
							timeoutMs: CONVERT_TIMEOUT_MS,
							signal,
						});
						return verifyConvert(out, result, src, target);
					}
					case "soffice": {
						const loc = locator.locate("soffice");
						if (!loc.path) return missingTool(loc);
						const result = await runSoffice(runner, loc.path, input, route.convertTo, out, signal);
						return verifyConvert(out, result, src, target);
					}
					case "ffmpeg": {
						const loc = locator.locate("ffmpeg");
						if (!loc.path) return missingTool(loc);
						const result =
							route.variant === "gif"
								? await runFfmpegGif(runner, loc.path, input, out, signal)
								: await runner.run(loc.path, ffmpegArgs(route.variant, input, out), {
										timeoutMs: CONVERT_TIMEOUT_MS,
										signal,
									});
						return verifyConvert(out, result, src, target);
					}
					case "magick": {
						const loc = locator.locate("magick");
						if (!loc.path) return missingTool(loc);
						const result = await runner.run(loc.path, [input, out], { timeoutMs: CONVERT_TIMEOUT_MS, signal });
						return verifyConvert(out, result, src, target);
					}
				}
			} catch (error) {
				return textResult(`转换出错: ${errorMessage(error)}`);
			}
		},
	});
}

function verifyConvert(out: string, result: RunResult, src: string, target: string): ToolResult {
	if (!existsSync(out) || fileSize(out) === 0)
		return textResult(`转换失败(未产出有效文件) .${src}→.${target}:\n${runSummary(result)}`.trim());
	return textResult(`已转换 → ${out} (${formatBytes(fileSize(out))})`, { output: out, bytes: fileSize(out) });
}

function ffmpegArgs(variant: "video" | "audio", input: string, out: string): string[] {
	if (variant === "audio") return ["-y", "-i", input, "-vn", out];
	return ["-y", "-i", input, "-c:v", "libx264", "-c:a", "aac", out];
}

/**
 * LibreOffice cannot name its output file, so we convert into a throwaway dir
 * (with a private user profile so a running LibreOffice won't lock us out) and
 * copy the single product onto our non-colliding target path.
 */
async function runSoffice(
	runner: CommandRunner,
	soffice: string,
	input: string,
	convertTo: string,
	out: string,
	signal: AbortSignal | undefined,
): Promise<RunResult> {
	const profile = await mkdtemp(join(tmpdir(), "her-soffice-profile-"));
	const outTmp = await mkdtemp(join(tmpdir(), "her-soffice-out-"));
	try {
		const result = await runner.run(
			soffice,
			[
				`-env:UserInstallation=${pathToFileURL(profile).href}`,
				"--headless",
				"--convert-to",
				convertTo,
				"--outdir",
				outTmp,
				input,
			],
			{ timeoutMs: CONVERT_TIMEOUT_MS, signal },
		);
		const entries = await readdir(outTmp);
		const produced = entries.find((name) => extOf(name) === convertTo) ?? entries[0];
		if (produced) await copyFile(join(outTmp, produced), out);
		return result;
	} finally {
		await rm(profile, { recursive: true, force: true });
		await rm(outTmp, { recursive: true, force: true });
	}
}

/** video -> gif in two passes (palettegen then paletteuse) to keep colours clean. */
async function runFfmpegGif(
	runner: CommandRunner,
	ffmpeg: string,
	input: string,
	out: string,
	signal: AbortSignal | undefined,
): Promise<RunResult> {
	const tmp = await mkdtemp(join(tmpdir(), "her-gif-"));
	const palette = join(tmp, "palette.png");
	const filter = "fps=15,scale=480:-1:flags=lanczos";
	try {
		const pass1 = await runner.run(ffmpeg, ["-y", "-i", input, "-vf", `${filter},palettegen`, palette], {
			timeoutMs: CONVERT_TIMEOUT_MS,
			signal,
		});
		if (!pass1.ok) return pass1;
		return await runner.run(
			ffmpeg,
			["-y", "-i", input, "-i", palette, "-filter_complex", `${filter}[x];[x][1:v]paletteuse`, out],
			{ timeoutMs: CONVERT_TIMEOUT_MS, signal },
		);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}
