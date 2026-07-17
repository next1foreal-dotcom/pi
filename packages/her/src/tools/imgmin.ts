import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolName } from "./locate.ts";
import { runSummary } from "./runner.ts";
import {
	errorMessage,
	extOf,
	fileSize,
	formatBytes,
	resolveOutputPath,
	savingPercent,
	stemOf,
	type ToolDeps,
	textResult,
} from "./shared.ts";

const IMGMIN_TIMEOUT_MS = 120_000;
const modes = ["lossless", "visual"] as const;

export type ImgminPlan = { ok: true; tool: ToolName; args: string[] } | { ok: false; reason: string };

/** Choose the compressor and its argv for a format + mode (pure). Never overwrites (out is a .min path). */
export function buildImgminPlan(ext: string, mode: "lossless" | "visual", input: string, out: string): ImgminPlan {
	const png = ext === "png";
	const jpg = ext === "jpg" || ext === "jpeg";
	const webp = ext === "webp";
	if (!png && !jpg && !webp)
		return { ok: false, reason: `imgmin 只支持 png/jpg/webp,不支持 .${ext};格式转换请用 her_convert。` };
	if (mode === "lossless") {
		if (png) return { ok: true, tool: "oxipng", args: ["-o", "4", "--strip", "safe", "--out", out, input] };
		if (jpg)
			return {
				ok: true,
				tool: "jpegtran",
				args: ["-copy", "none", "-optimize", "-progressive", "-outfile", out, input],
			};
		return { ok: true, tool: "cwebp", args: ["-lossless", input, "-o", out] };
	}
	// visual: lossy, only when the caller explicitly asks for it.
	if (webp) return { ok: true, tool: "cwebp", args: ["-q", "82", input, "-o", out] };
	return { ok: true, tool: "magick", args: [input, "-quality", "85", out] };
}

export function registerImgminTool(pi: ExtensionAPI, deps: ToolDeps): void {
	const { locator, runner } = deps;
	pi.registerTool({
		name: "her_imgmin",
		label: "Image Minify",
		description:
			"Shrink an image. Default mode 'lossless' is truly lossless — pixels are unchanged (oxipng for PNG, jpegtran " +
			"for JPG, cwebp -lossless for WebP). mode 'visual' is lossy and must be requested explicitly. Never " +
			"overwrites the original: writes a .min copy beside it and reports before -> after bytes with percent saved.",
		parameters: Type.Object({
			input: Type.String(),
			mode: Type.Optional(StringEnum(modes)),
		}),
		async execute(_toolCallId, params, signal) {
			const input = params.input;
			const mode = params.mode ?? "lossless";
			if (!existsSync(input)) return textResult(`输入文件不存在: ${input}`);
			const ext = extOf(input);
			const out = resolveOutputPath(dirname(input), `${stemOf(input)}.min`, ext);
			const plan = buildImgminPlan(ext, mode, input, out);
			if (!plan.ok) return textResult(plan.reason);
			const loc = locator.locate(plan.tool);
			if (!loc.path) return textResult(`${plan.tool} 未安装。安装: ${loc.winget}`);
			try {
				const before = fileSize(input);
				const result = await runner.run(loc.path, plan.args, { timeoutMs: IMGMIN_TIMEOUT_MS, signal });
				if (!result.ok || !existsSync(out) || fileSize(out) === 0)
					return textResult(`压缩失败:\n${runSummary(result)}`.trim());
				const after = fileSize(out);
				const pct = savingPercent(before, after);
				const verdict = pct >= 0 ? `省 ${pct}%` : `反增 ${-pct}%(原图已很紧凑)`;
				const note = mode === "lossless" ? " [真无损,像素不变]" : " [肉眼无损/有损,像素已变]";
				return textResult(`${input}: ${formatBytes(before)} → ${formatBytes(after)} (${verdict}) → ${out}${note}`, {
					output: out,
					before,
					after,
					percent: pct,
				});
			} catch (error) {
				return textResult(`压缩出错: ${errorMessage(error)}`);
			}
		},
	});
}
