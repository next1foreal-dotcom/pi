import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { FakeLocator, FakeRunner, runTool, toolHarness } from "./tools-harness.ts";

function tempInput(name: string, content = "hello"): { dir: string; input: string } {
	const dir = mkdtempSync(join(tmpdir(), "her-convert-"));
	const input = join(dir, name);
	writeFileSync(input, content);
	return { dir, input };
}

test("her_convert md->docx invokes pandoc with [input, -o, out]", async () => {
	const { dir, input } = tempInput("note.md");
	const runner = new FakeRunner();
	const tools = toolHarness({ locator: new FakeLocator({ pandoc: "pandoc.exe" }), runner });

	await runTool(tools.get("her_convert"), { input, target: "docx" });

	assert.equal(runner.calls.length, 1);
	assert.equal(runner.calls[0].file, "pandoc.exe");
	assert.deepEqual(runner.calls[0].args, [input, "-o", join(dir, "note.docx")]);
});

test("her_convert reports success with the output path and size once the file exists", async () => {
	const { dir, input } = tempInput("note.md");
	const runner = new FakeRunner((call) => ({
		writeFiles: [{ path: call.args[call.args.indexOf("-o") + 1], bytes: 40 }],
	}));
	const tools = toolHarness({ locator: new FakeLocator({ pandoc: "pandoc.exe" }), runner });

	const text = await runTool(tools.get("her_convert"), { input, target: "docx" });

	assert.match(text, /已转换/);
	assert.match(text, /note\.docx/);
	assert.ok(runner.calls[0].args.includes(join(dir, "note.docx")));
});

test("her_convert never overwrites: a pre-existing target forces a -1 suffix", async () => {
	const { dir, input } = tempInput("note.md");
	writeFileSync(join(dir, "note.docx"), "already here");
	const runner = new FakeRunner((call) => ({
		writeFiles: [{ path: call.args[call.args.indexOf("-o") + 1], bytes: 20 }],
	}));
	const tools = toolHarness({ locator: new FakeLocator({ pandoc: "pandoc.exe" }), runner });

	await runTool(tools.get("her_convert"), { input, target: "docx" });

	assert.equal(runner.calls[0].args[2], join(dir, "note-1.docx"));
});

test("her_convert reports a missing tool with its winget line, no run", async () => {
	const { input } = tempInput("note.md");
	const runner = new FakeRunner();
	const tools = toolHarness({ locator: new FakeLocator({}), runner });

	const text = await runTool(tools.get("her_convert"), { input, target: "docx" });

	assert.match(text, /pandoc 未安装/);
	assert.match(text, /winget install/);
	assert.equal(runner.calls.length, 0);
});

test("her_convert refuses md->pdf with the LaTeX guidance and does not spawn", async () => {
	const { input } = tempInput("note.md");
	const runner = new FakeRunner();
	const tools = toolHarness({ locator: new FakeLocator({ pandoc: "pandoc.exe", soffice: "soffice.exe" }), runner });

	const text = await runTool(tools.get("her_convert"), { input, target: "pdf" });

	assert.match(text, /LaTeX|先.*docx/);
	assert.equal(runner.calls.length, 0);
});

test("her_convert docx->pdf routes through soffice --headless --convert-to pdf", async () => {
	const { input } = tempInput("report.docx");
	const runner = new FakeRunner();
	const tools = toolHarness({ locator: new FakeLocator({ soffice: "soffice.exe" }), runner });

	await runTool(tools.get("her_convert"), { input, target: "pdf" });

	assert.equal(runner.calls[0].file, "soffice.exe");
	const args = runner.calls[0].args;
	assert.ok(args.includes("--headless"));
	assert.ok(args.includes("--convert-to"));
	assert.ok(args.includes("pdf"));
	assert.ok(args.includes(input));
});

test("her_convert mov->mp4 uses the libx264/aac ffmpeg recipe", async () => {
	const { dir, input } = tempInput("clip.mov");
	const runner = new FakeRunner();
	const tools = toolHarness({ locator: new FakeLocator({ ffmpeg: "ffmpeg.exe" }), runner });

	await runTool(tools.get("her_convert"), { input, target: "mp4" });

	assert.deepEqual(runner.calls[0].args, ["-y", "-i", input, "-c:v", "libx264", "-c:a", "aac", join(dir, "clip.mp4")]);
});

test("her_convert mp4->gif runs the two-pass palettegen/paletteuse recipe", async () => {
	const { input } = tempInput("clip.mp4");
	const runner = new FakeRunner();
	const tools = toolHarness({ locator: new FakeLocator({ ffmpeg: "ffmpeg.exe" }), runner });

	await runTool(tools.get("her_convert"), { input, target: "gif" });

	assert.equal(runner.calls.length, 2);
	assert.ok(runner.calls[0].args.some((a) => a.includes("palettegen")));
	assert.ok(runner.calls[1].args.some((a) => a.includes("paletteuse")));
});

test("her_convert png->webp shells out to magick with [input, out]", async () => {
	const { dir, input } = tempInput("pic.png");
	const runner = new FakeRunner();
	const tools = toolHarness({ locator: new FakeLocator({ magick: "magick.exe" }), runner });

	await runTool(tools.get("her_convert"), { input, target: "webp" });

	assert.equal(runner.calls[0].file, "magick.exe");
	assert.deepEqual(runner.calls[0].args, [input, join(dir, "pic.webp")]);
	assert.equal(basename(runner.calls[0].args[1]), "pic.webp");
});
