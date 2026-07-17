import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeLocator, FakeRunner, runTool, toolHarness } from "./tools-harness.ts";

function tempInput(name: string): { dir: string; input: string } {
	const dir = mkdtempSync(join(tmpdir(), "her-ocr-"));
	const input = join(dir, name);
	writeFileSync(input, "binary");
	return { dir, input };
}

test("her_ocr reports a missing tesseract with its winget line", async () => {
	const { input } = tempInput("scan.png");
	const runner = new FakeRunner();
	const tools = toolHarness({ locator: new FakeLocator({}), runner });

	const text = await runTool(tools.get("her_ocr"), { input });

	assert.match(text, /tesseract 未安装/);
	assert.match(text, /winget install/);
	assert.equal(runner.calls.length, 0);
});

test("her_ocr on an image runs tesseract with the tessdata dir and chi_sim+eng default", async () => {
	const { dir, input } = tempInput("scan.png");
	const runner = new FakeRunner((call) => ({
		writeFiles: [{ path: `${call.args[1]}.txt`, content: "她的记忆属于她自己" }],
	}));
	const tools = toolHarness({ locator: new FakeLocator({ tesseract: "tesseract.exe" }), runner });

	const text = await runTool(tools.get("her_ocr"), { input });

	const args = runner.calls[0].args;
	assert.equal(args[0], input);
	assert.equal(args[1], join(dir, "scan")); // output prefix, no .txt
	assert.ok(args.includes("-l"));
	assert.ok(args.includes("chi_sim+eng"));
	assert.ok(args.includes("--tessdata-dir"));
	assert.match(text, /已识别/);
	assert.match(text, /9 字/); // 9 CJK chars
	assert.match(text, /人工校对/); // honest proofread caveat
});

test("her_ocr honors an explicit lang override", async () => {
	const { input } = tempInput("scan.png");
	const runner = new FakeRunner((call) => ({ writeFiles: [{ path: `${call.args[1]}.txt`, content: "text" }] }));
	const tools = toolHarness({ locator: new FakeLocator({ tesseract: "tesseract.exe" }), runner });

	await runTool(tools.get("her_ocr"), { input, lang: "eng" });

	assert.ok(runner.calls[0].args.includes("eng"));
	assert.ok(!runner.calls[0].args.includes("chi_sim+eng"));
});
