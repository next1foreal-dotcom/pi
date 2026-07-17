import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolLocator } from "./locate.ts";
import { type CommandRunner, runSummary } from "./runner.ts";
import {
	errorMessage,
	fileSize,
	formatBytes,
	resolveOutputPath,
	savingPercent,
	stemOf,
	type ToolDeps,
	type ToolResult,
	textResult,
} from "./shared.ts";

const PDF_TIMEOUT_MS = 120_000;
const GS_TIMEOUT_MS = 300_000;
const actions = ["merge", "extract", "split", "encrypt", "decrypt", "shrink"] as const;

interface PdfParams {
	action: (typeof actions)[number];
	input?: string;
	files?: string[];
	output?: string;
	pages?: string;
	userPassword?: string;
	ownerPassword?: string;
	password?: string;
	outDir?: string;
}

export function registerPdfTool(pi: ExtensionAPI, deps: ToolDeps): void {
	const { locator, runner } = deps;
	pi.registerTool({
		name: "her_pdf",
		label: "PDF Toolkit",
		description:
			'PDF operations via qpdf: merge (files[] in order), extract (pages like "2-5" from input), split (one file ' +
			"per page), encrypt (256-bit; userPassword to open, ownerPassword for permissions), decrypt (needs the " +
			"password). shrink relies on Ghostscript, which is NOT installed here — that action returns install guidance " +
			"instead of pretending to succeed; the other actions are unaffected. Outputs never overwrite existing files.",
		parameters: Type.Object({
			action: StringEnum(actions),
			input: Type.Optional(Type.String()),
			files: Type.Optional(Type.Array(Type.String())),
			output: Type.Optional(Type.String()),
			pages: Type.Optional(Type.String()),
			userPassword: Type.Optional(Type.String()),
			ownerPassword: Type.Optional(Type.String()),
			password: Type.Optional(Type.String()),
			outDir: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				if (params.action === "shrink") return await shrink(locator, runner, params, signal);
				const loc = locator.locate("qpdf");
				if (!loc.path) return textResult(`qpdf 未安装。安装: ${loc.winget}`);
				switch (params.action) {
					case "merge":
						return await merge(runner, loc.path, params, signal);
					case "extract":
						return await extract(runner, loc.path, params, signal);
					case "split":
						return await split(runner, loc.path, params, signal);
					case "encrypt":
						return await encrypt(runner, loc.path, params, signal);
					case "decrypt":
						return await decrypt(runner, loc.path, params, signal);
				}
			} catch (error) {
				return textResult(`PDF 操作出错: ${errorMessage(error)}`);
			}
		},
	});
}

function outPath(params: PdfParams, defaultDir: string, defaultStem: string): string {
	if (params.output) return resolveOutputPath(dirname(params.output), stemOf(params.output), "pdf");
	return resolveOutputPath(params.outDir ?? defaultDir, defaultStem, "pdf");
}

async function showNpages(
	runner: CommandRunner,
	qpdf: string,
	file: string,
	signal: AbortSignal | undefined,
): Promise<number | undefined> {
	try {
		const result = await runner.run(qpdf, ["--show-npages", file], { timeoutMs: PDF_TIMEOUT_MS, signal });
		const n = Number.parseInt(result.stdout.trim(), 10);
		return Number.isFinite(n) ? n : undefined;
	} catch {
		return undefined;
	}
}

async function merge(
	runner: CommandRunner,
	qpdf: string,
	params: PdfParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const files = params.files ?? [];
	if (files.length < 2) return textResult("merge 需要至少两个 PDF(files)。");
	const missing = files.filter((file) => !existsSync(file));
	if (missing.length > 0) return textResult(`以下 PDF 不存在: ${missing.join(", ")}`);
	const out = outPath(params, dirname(files[0]), "merged");
	const result = await runner.run(qpdf, ["--empty", "--pages", ...files, "--", out], {
		timeoutMs: PDF_TIMEOUT_MS,
		signal,
	});
	if (!result.ok || !existsSync(out)) return textResult(`合并失败:\n${runSummary(result)}`.trim());
	const pages = await showNpages(runner, qpdf, out, signal);
	return textResult(`已合并 ${files.length} 个 PDF → ${out}${pages ? ` (${pages} 页)` : ""}`, { output: out, pages });
}

async function extract(
	runner: CommandRunner,
	qpdf: string,
	params: PdfParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const input = params.input;
	if (!input || !existsSync(input)) return textResult(`输入 PDF 不存在: ${input ?? "(未提供)"}`);
	if (!params.pages) return textResult('extract 需要页码范围 pages,例如 "2-5" 或 "1,3,5"。');
	const out = outPath(params, dirname(input), `${stemOf(input)}-p${params.pages.replace(/[^0-9]+/g, "_")}`);
	const result = await runner.run(qpdf, [input, "--pages", ".", params.pages, "--", out], {
		timeoutMs: PDF_TIMEOUT_MS,
		signal,
	});
	if (!result.ok || !existsSync(out)) return textResult(`抽页失败(检查页码是否越界):\n${runSummary(result)}`.trim());
	const pages = await showNpages(runner, qpdf, out, signal);
	return textResult(`已抽取第 ${params.pages} 页 → ${out}${pages ? ` (${pages} 页)` : ""}`, { output: out, pages });
}

async function split(
	runner: CommandRunner,
	qpdf: string,
	params: PdfParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const input = params.input;
	if (!input || !existsSync(input)) return textResult(`输入 PDF 不存在: ${input ?? "(未提供)"}`);
	const dir = params.outDir ?? dirname(input);
	const stem = stemOf(input);
	const result = await runner.run(qpdf, [input, "--split-pages", "--", join(dir, `${stem}-%d.pdf`)], {
		timeoutMs: PDF_TIMEOUT_MS,
		signal,
	});
	if (!result.ok) return textResult(`拆分失败:\n${runSummary(result)}`.trim());
	const pattern = new RegExp(`^${escapeRegExp(stem)}-\\d+\\.pdf$`, "i");
	const produced = (await readdir(dir)).filter((name) => pattern.test(name));
	return textResult(`已按页拆分 ${input} → ${produced.length} 个文件(${join(dir, `${stem}-N.pdf`)})`, {
		output: dir,
		files: produced.length,
	});
}

async function encrypt(
	runner: CommandRunner,
	qpdf: string,
	params: PdfParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const input = params.input;
	if (!input || !existsSync(input)) return textResult(`输入 PDF 不存在: ${input ?? "(未提供)"}`);
	if (!params.userPassword) return textResult("encrypt 需要 userPassword(打开密码)。");
	const owner = params.ownerPassword ?? params.userPassword;
	const out = outPath(params, dirname(input), `${stemOf(input)}.enc`);
	const result = await runner.run(qpdf, ["--encrypt", params.userPassword, owner, "256", "--", input, out], {
		timeoutMs: PDF_TIMEOUT_MS,
		signal,
	});
	if (!result.ok || !existsSync(out)) return textResult(`加密失败:\n${runSummary(result)}`.trim());
	return textResult(`已加密(256 位)→ ${out}`, { output: out });
}

async function decrypt(
	runner: CommandRunner,
	qpdf: string,
	params: PdfParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const input = params.input;
	if (!input || !existsSync(input)) return textResult(`输入 PDF 不存在: ${input ?? "(未提供)"}`);
	if (!params.password) return textResult("decrypt 需要 password;不知道密码无法解密,本工具不做爆破。");
	const out = outPath(params, dirname(input), `${stemOf(input)}.dec`);
	const result = await runner.run(qpdf, [`--password=${params.password}`, "--decrypt", input, out], {
		timeoutMs: PDF_TIMEOUT_MS,
		signal,
	});
	if (!result.ok || !existsSync(out)) {
		const badPassword = /invalid password/i.test(`${result.stdout}${result.stderr}`);
		return textResult(badPassword ? "解密失败: 密码错误。" : `解密失败:\n${runSummary(result)}`.trim());
	}
	return textResult(`已解密 → ${out}`, { output: out });
}

async function shrink(
	locator: ToolLocator,
	runner: CommandRunner,
	params: PdfParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const input = params.input;
	if (!input || !existsSync(input)) return textResult(`输入 PDF 不存在: ${input ?? "(未提供)"}`);
	const gs = locator.locate("gswin64c");
	if (!gs.path)
		return textResult(
			`PDF 瘦身依赖 Ghostscript(gswin64c),本机尚未安装,无法压缩。\n${gs.winget}\n合并/抽页/拆分/加解密不受影响,可照常使用。`,
		);
	const out = outPath(params, dirname(input), `${stemOf(input)}.min`);
	const result = await runner.run(
		gs.path,
		["-sDEVICE=pdfwrite", "-dPDFSETTINGS=/ebook", "-dNOPAUSE", "-dBATCH", `-sOutputFile=${out}`, input],
		{ timeoutMs: GS_TIMEOUT_MS, signal },
	);
	if (!result.ok || !existsSync(out)) return textResult(`瘦身失败:\n${runSummary(result)}`.trim());
	const before = fileSize(input);
	const after = fileSize(out);
	return textResult(
		`已瘦身 ${formatBytes(before)} → ${formatBytes(after)} (省 ${savingPercent(before, after)}%) → ${out}`,
		{
			output: out,
			before,
			after,
		},
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
