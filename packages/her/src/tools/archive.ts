import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runSummary } from "./runner.ts";
import {
	errorMessage,
	extOf,
	resolveOutputDir,
	resolveOutputPath,
	stemOf,
	type ToolDeps,
	textResult,
} from "./shared.ts";

const ARCHIVE_TIMEOUT_MS = 300_000;
const actions = ["pack", "unpack", "list"] as const;

export interface ArchiveParams {
	action: (typeof actions)[number];
	target: string;
	files?: string[];
	password?: string;
	outDir?: string;
}

/** Build the 7-Zip argv (pure). target/outDir must already be resolved by the caller. */
export function buildArchiveArgs(params: ArchiveParams): string[] {
	const { action, target, files = [], password, outDir } = params;
	if (action === "list") return ["l", target];
	if (action === "unpack") {
		const args = ["x", target, `-o${outDir ?? "."}`, "-y"];
		if (password) args.push(`-p${password}`);
		return args;
	}
	const args = ["a", target, ...files];
	if (extOf(target) === "zip") args.push("-mcu=on"); // UTF-8 names so 中文 doesn't garble in zip
	if (password) {
		args.push(`-p${password}`);
		if (extOf(target) === "7z") args.push("-mhe=on"); // encrypt the file list too — 7z only
	}
	return args;
}

export function registerArchiveTool(pi: ExtensionAPI, deps: ToolDeps): void {
	const { locator, runner } = deps;
	pi.registerTool({
		name: "her_archive",
		label: "Archive",
		description:
			"Pack, unpack, or list archives (zip/7z/rar/tar.gz) via 7-Zip. pack builds a fresh archive from files[] " +
			"(zip gets -mcu=on so Chinese names stay intact; a password on a .7z also encrypts the file list via " +
			"-mhe=on). unpack extracts into a fresh, non-colliding folder — never overwrites. list shows the contents " +
			"without extracting. rar can be unpacked but not created.",
		parameters: Type.Object({
			action: StringEnum(actions),
			target: Type.String(),
			files: Type.Optional(Type.Array(Type.String())),
			password: Type.Optional(Type.String()),
			outDir: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal) {
			const loc = locator.locate("7z");
			if (!loc.path) return textResult(`7z 未安装。安装: ${loc.winget}`);
			try {
				if (params.action === "pack") {
					const files = params.files ?? [];
					if (files.length === 0) return textResult("pack 需要至少一个待打包文件(files 不能为空)。");
					const missing = files.filter((file) => !existsSync(file));
					if (missing.length > 0) return textResult(`以下待打包文件不存在: ${missing.join(", ")}`);
					const target = resolveOutputPath(dirname(params.target), stemOf(params.target), extOf(params.target));
					const result = await runner.run(loc.path, buildArchiveArgs({ ...params, target }), {
						timeoutMs: ARCHIVE_TIMEOUT_MS,
						signal,
					});
					if (!result.ok || !existsSync(target)) return textResult(`打包失败:\n${runSummary(result)}`.trim());
					return textResult(`已打包 ${files.length} 项 → ${target}`, { output: target });
				}

				if (!existsSync(params.target)) return textResult(`归档文件不存在: ${params.target}`);

				if (params.action === "list") {
					const result = await runner.run(loc.path, buildArchiveArgs(params), {
						timeoutMs: ARCHIVE_TIMEOUT_MS,
						signal,
					});
					return textResult(
						result.ok
							? `内容清单 ${params.target}:\n${runSummary(result)}`
							: `列表失败:\n${runSummary(result)}`.trim(),
					);
				}

				// unpack
				const outDir = params.outDir ?? resolveOutputDir(dirname(params.target), stemOf(params.target));
				await mkdir(outDir, { recursive: true });
				const result = await runner.run(loc.path, buildArchiveArgs({ ...params, outDir }), {
					timeoutMs: ARCHIVE_TIMEOUT_MS,
					signal,
				});
				if (!result.ok) {
					const wrongPassword = /Wrong password|Data Error in encrypted/i.test(`${result.stdout}${result.stderr}`);
					return textResult(
						wrongPassword
							? "解压失败: 密码错误。请提供正确密码,不重复猜测。"
							: `解压失败:\n${runSummary(result)}`.trim(),
					);
				}
				return textResult(`已解压 ${params.target} → ${outDir}`, { output: outDir });
			} catch (error) {
				return textResult(`归档操作出错: ${errorMessage(error)}`);
			}
		},
	});
}
