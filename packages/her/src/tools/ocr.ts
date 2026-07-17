import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CommandRunner, runSummary } from "./runner.ts";
import {
	errorMessage,
	extOf,
	resolveOutputPath,
	stemOf,
	type ToolDeps,
	type ToolResult,
	textResult,
} from "./shared.ts";

const OCR_TIMEOUT_MS = 180_000;
const PROOFREAD_NOTE =
	"提醒: Tesseract 识别质量及格但不完美,合同/证件/表格/手写等重要或复杂版面务必人工校对,勿当作已核准文本。";

function tessdataDir(): string {
	return join(process.env.LOCALAPPDATA ?? "", "tessdata");
}

function charCount(text: string): number {
	return [...text.trim()].length;
}

export function registerOcrTool(pi: ExtensionAPI, deps: ToolDeps): void {
	const { locator, runner } = deps;
	pi.registerTool({
		name: "her_ocr",
		label: "OCR",
		description:
			"Extract text (Chinese + English) from an image or scanned PDF with Tesseract. Images are read directly; " +
			"PDFs are first rasterized to 300dpi page images (ImageMagick) then OCR'd page by page and concatenated. " +
			"Always passes the machine's tessdata dir. Writes a .txt beside the input (never overwrites) and returns its " +
			"path, character count, and a manual-proofread caveat. lang defaults to chi_sim+eng (use eng for pure English).",
		parameters: Type.Object({
			input: Type.String(),
			lang: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal) {
			const input = params.input;
			const lang = params.lang ?? "chi_sim+eng";
			if (!existsSync(input)) return textResult(`输入文件不存在: ${input}`);
			const tesseract = locator.locate("tesseract");
			if (!tesseract.path) return textResult(`tesseract 未安装。安装: ${tesseract.winget}`);
			try {
				if (extOf(input) === "pdf") {
					return await ocrPdf(deps, tesseract.path, input, lang, signal);
				}
				return await ocrImage(runner, tesseract.path, input, lang, signal);
			} catch (error) {
				return textResult(`OCR 出错: ${errorMessage(error)}`);
			}
		},
	});
}

async function ocrImage(
	runner: CommandRunner,
	tesseract: string,
	input: string,
	lang: string,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const out = resolveOutputPath(dirname(input), stemOf(input), "txt");
	const prefix = out.replace(/\.txt$/i, "");
	const result = await runner.run(tesseract, [input, prefix, "-l", lang, "--tessdata-dir", tessdataDir()], {
		timeoutMs: OCR_TIMEOUT_MS,
		signal,
	});
	if (!result.ok || !existsSync(out)) return textResult(`OCR 失败: ${input}\n${runSummary(result)}`.trim());
	const text = await readFile(out, "utf8");
	return textResult(`已识别 ${input} → ${out} (${charCount(text)} 字)\n${PROOFREAD_NOTE}`, {
		output: out,
		chars: charCount(text),
	});
}

async function ocrPdf(
	deps: ToolDeps,
	tesseract: string,
	input: string,
	lang: string,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const magick = deps.locator.locate("magick");
	if (!magick.path) return textResult(`扫描版 PDF 需先转页图,但 magick 未安装。安装: ${magick.winget}`);
	const tmp = await mkdtemp(join(tmpdir(), "her-ocr-"));
	try {
		const raster = await deps.runner.run(magick.path, ["-density", "300", input, join(tmp, "page-%03d.png")], {
			timeoutMs: OCR_TIMEOUT_MS,
			signal,
		});
		const pages = (await readdir(tmp)).filter((name) => name.toLowerCase().endsWith(".png")).sort();
		if (pages.length === 0)
			return textResult(
				`PDF 转页图失败(magick 读取 PDF 依赖 Ghostscript,本机未装则会失败):\n${runSummary(raster)}`.trim(),
			);
		const parts: string[] = [];
		for (const page of pages) {
			const pagePath = join(tmp, page);
			const prefix = pagePath.replace(/\.png$/i, "");
			const result = await deps.runner.run(
				tesseract,
				[pagePath, prefix, "-l", lang, "--tessdata-dir", tessdataDir()],
				{ timeoutMs: OCR_TIMEOUT_MS, signal },
			);
			if (result.ok && existsSync(`${prefix}.txt`)) parts.push(await readFile(`${prefix}.txt`, "utf8"));
		}
		const text = parts.join("\n");
		const out = resolveOutputPath(dirname(input), stemOf(input), "txt");
		await writeFile(out, text, "utf8");
		return textResult(`已识别 ${pages.length} 页 ${input} → ${out} (${charCount(text)} 字)\n${PROOFREAD_NOTE}`, {
			output: out,
			pages: pages.length,
			chars: charCount(text),
		});
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}
