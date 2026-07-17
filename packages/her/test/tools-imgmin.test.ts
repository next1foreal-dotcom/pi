import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeLocator, FakeRunner, runTool, toolHarness } from "./tools-harness.ts";

function tempInput(name: string, bytes = 1000): { dir: string; input: string } {
	const dir = mkdtempSync(join(tmpdir(), "her-imgmin-"));
	const input = join(dir, name);
	writeFileSync(input, "x".repeat(bytes));
	return { dir, input };
}

test("her_imgmin lossless PNG uses oxipng --out to a .min copy and reports before->after", async () => {
	const { dir, input } = tempInput("pic.png", 1000);
	const runner = new FakeRunner((call) => ({
		writeFiles: [{ path: call.args[call.args.indexOf("--out") + 1], bytes: 250 }],
	}));
	const tools = toolHarness({ locator: new FakeLocator({ oxipng: "oxipng.exe" }), runner });

	const text = await runTool(tools.get("her_imgmin"), { input });

	const out = join(dir, "pic.min.png");
	assert.deepEqual(runner.calls[0].args, ["-o", "4", "--strip", "safe", "--out", out, input]);
	assert.match(text, /省 75%/);
	assert.match(text, /真无损/);
});

test("her_imgmin defaults to lossless (visual must be explicit)", async () => {
	const { input } = tempInput("pic.jpg");
	const runner = new FakeRunner((call) => ({
		writeFiles: [{ path: call.args[call.args.indexOf("-outfile") + 1], bytes: 500 }],
	}));
	const tools = toolHarness({ locator: new FakeLocator({ jpegtran: "jpegtran.exe" }), runner });

	await runTool(tools.get("her_imgmin"), { input });

	assert.equal(runner.calls[0].file, "jpegtran.exe");
	assert.ok(runner.calls[0].args.includes("-optimize"));
});

test("her_imgmin visual mode is lossy and routes PNG through magick -quality", async () => {
	const { dir, input } = tempInput("pic.png");
	const runner = new FakeRunner((call) => ({ writeFiles: [{ path: call.args[call.args.length - 1], bytes: 400 }] }));
	const tools = toolHarness({ locator: new FakeLocator({ magick: "magick.exe" }), runner });

	const text = await runTool(tools.get("her_imgmin"), { input, mode: "visual" });

	assert.deepEqual(runner.calls[0].args, [input, "-quality", "85", join(dir, "pic.min.png")]);
	assert.match(text, /有损|像素已变/);
});

test("her_imgmin rejects unsupported formats and points to her_convert", async () => {
	const { input } = tempInput("pic.gif");
	const runner = new FakeRunner();
	const tools = toolHarness({ locator: new FakeLocator({ magick: "magick.exe" }), runner });

	const text = await runTool(tools.get("her_imgmin"), { input });

	assert.match(text, /只支持 png\/jpg\/webp/);
	assert.equal(runner.calls.length, 0);
});

test("her_imgmin reports a missing compressor with its winget line", async () => {
	const { input } = tempInput("pic.png");
	const tools = toolHarness({ locator: new FakeLocator({}), runner: new FakeRunner() });

	const text = await runTool(tools.get("her_imgmin"), { input });

	assert.match(text, /oxipng 未安装/);
});
