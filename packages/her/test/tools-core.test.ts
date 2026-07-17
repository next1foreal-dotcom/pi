import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { governedTools } from "../src/extension.ts";
import { buildArchiveArgs } from "../src/tools/archive.ts";
import { routeConvert } from "../src/tools/convert.ts";
import { buildImgminPlan } from "../src/tools/imgmin.ts";
import { expandEnv, globFirst } from "../src/tools/locate.ts";
import { extOf, formatBytes, resolveOutputDir, resolveOutputPath, savingPercent, stemOf } from "../src/tools/shared.ts";

test("resolveOutputPath never overwrites: suffixes -1, -2 when names are taken", () => {
	const taken = new Set(["/d/report.pdf", "/d/report-1.pdf"]);
	const exists = (p: string) => taken.has(p.replace(/\\/g, "/"));
	assert.equal(resolveOutputPath("/d", "report", "pdf", () => false).replace(/\\/g, "/"), "/d/report.pdf");
	assert.equal(resolveOutputPath("/d", "report", "pdf", exists).replace(/\\/g, "/"), "/d/report-2.pdf");
});

test("resolveOutputDir picks a fresh, non-colliding directory name", () => {
	const taken = new Set(["/d/pkg"]);
	const exists = (p: string) => taken.has(p.replace(/\\/g, "/"));
	assert.equal(resolveOutputDir("/d", "pkg", exists).replace(/\\/g, "/"), "/d/pkg-1");
});

test("formatBytes and savingPercent read out human sizes and shrink ratio", () => {
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(2048), "2.0 KB");
	assert.equal(savingPercent(1000, 250), 75);
	assert.equal(savingPercent(1000, 1200), -20); // honest about growth
	assert.equal(savingPercent(0, 0), 0);
});

test("extOf and stemOf are case-insensitive and dot-free", () => {
	assert.equal(extOf("C:/x/Photo.PNG"), "png");
	assert.equal(stemOf("C:/x/report.final.docx"), "report.final");
});

test("expandEnv substitutes %VAR% and leaves unknown vars untouched", () => {
	process.env.HER_TOOLS_TEST = "C:/base";
	try {
		assert.equal(expandEnv("%HER_TOOLS_TEST%/bin"), "C:/base/bin");
		assert.equal(expandEnv("%NOPE_NOT_SET%/bin"), "%NOPE_NOT_SET%/bin");
	} finally {
		delete process.env.HER_TOOLS_TEST;
	}
});

test("globFirst resolves a * versioned directory segment (space in name)", async () => {
	const root = mkdtempSync(join(tmpdir(), "her-glob-"));
	await mkdir(join(root, "qpdf 12.3.2", "bin"), { recursive: true });
	writeFileSync(join(root, "qpdf 12.3.2", "bin", "qpdf.exe"), "");
	assert.equal(globFirst(join(root, "qpdf*", "bin", "qpdf.exe")), join(root, "qpdf 12.3.2", "bin", "qpdf.exe"));
	assert.equal(globFirst(join(root, "missing*", "x.exe")), null);
});

test("routeConvert maps the SKILL routing table branches", () => {
	assert.deepEqual(routeConvert("md", "docx"), { kind: "pandoc" });
	assert.deepEqual(routeConvert("docx", "pdf"), { kind: "soffice", convertTo: "pdf" });
	assert.deepEqual(routeConvert("html", "pdf"), { kind: "soffice", convertTo: "pdf" });
	assert.deepEqual(routeConvert("doc", "docx"), { kind: "soffice", convertTo: "docx" });
	assert.deepEqual(routeConvert("mov", "mp4"), { kind: "ffmpeg", variant: "video" });
	assert.deepEqual(routeConvert("mp4", "m4a"), { kind: "ffmpeg", variant: "audio" });
	assert.deepEqual(routeConvert("mp4", "gif"), { kind: "ffmpeg", variant: "gif" });
	assert.deepEqual(routeConvert("png", "webp"), { kind: "magick" });
});

test("routeConvert refuses the SKILL's honest-limitation cases with guidance", () => {
	assert.equal(routeConvert("md", "pdf").kind, "unsupported");
	assert.match((routeConvert("md", "pdf") as { reason: string }).reason, /LaTeX/);
	assert.equal(routeConvert("pdf", "docx").kind, "unsupported");
	assert.match((routeConvert("pdf", "docx") as { reason: string }).reason, /错乱|人工核对/);
	assert.equal(routeConvert("png", "png").kind, "unsupported");
});

test("buildArchiveArgs: zip gets -mcu=on, 7z password adds -mhe=on, zip password does not", () => {
	assert.deepEqual(buildArchiveArgs({ action: "pack", target: "out.zip", files: ["a.txt"] }), [
		"a",
		"out.zip",
		"a.txt",
		"-mcu=on",
	]);
	assert.deepEqual(buildArchiveArgs({ action: "pack", target: "out.7z", files: ["a.txt"], password: "p" }), [
		"a",
		"out.7z",
		"a.txt",
		"-pp",
		"-mhe=on",
	]);
	const zipWithPw = buildArchiveArgs({ action: "pack", target: "out.zip", files: ["a.txt"], password: "p" });
	assert.ok(zipWithPw.includes("-pp"));
	assert.ok(!zipWithPw.includes("-mhe=on"));
});

test("buildArchiveArgs: unpack uses -o<dir> with no space and -y, list is read-only", () => {
	assert.deepEqual(buildArchiveArgs({ action: "unpack", target: "a.7z", outDir: "C:/out", password: "s" }), [
		"x",
		"a.7z",
		"-oC:/out",
		"-y",
		"-ps",
	]);
	assert.deepEqual(buildArchiveArgs({ action: "list", target: "a.7z" }), ["l", "a.7z"]);
});

test("buildImgminPlan: lossless routing per format, visual is separate, others rejected", () => {
	assert.deepEqual(buildImgminPlan("png", "lossless", "i.png", "o.min.png"), {
		ok: true,
		tool: "oxipng",
		args: ["-o", "4", "--strip", "safe", "--out", "o.min.png", "i.png"],
	});
	assert.equal((buildImgminPlan("jpg", "lossless", "i.jpg", "o") as { tool: string }).tool, "jpegtran");
	assert.deepEqual(buildImgminPlan("webp", "lossless", "i.webp", "o.min.webp"), {
		ok: true,
		tool: "cwebp",
		args: ["-lossless", "i.webp", "-o", "o.min.webp"],
	});
	assert.equal((buildImgminPlan("png", "visual", "i.png", "o") as { tool: string }).tool, "magick");
	assert.equal((buildImgminPlan("gif", "lossless", "i.gif", "o") as { ok: boolean }).ok, false);
});

test("all five organs are registered as non-destructive governed tools", () => {
	for (const name of ["her_convert", "her_ocr", "her_archive", "her_imgmin", "her_pdf"] as const) {
		assert.deepEqual(governedTools[name], { destructive: false }, `${name} must be governed non-destructive`);
	}
});
