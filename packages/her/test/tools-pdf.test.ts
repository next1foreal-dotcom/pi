import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeLocator, FakeRunner, runTool, toolHarness } from "./tools-harness.ts";

function tempPdf(name: string): { dir: string; input: string } {
	const dir = mkdtempSync(join(tmpdir(), "her-pdf-"));
	const input = join(dir, name);
	writeFileSync(input, "%PDF-1.7");
	return { dir, input };
}

const qpdf = new FakeLocator({ qpdf: "qpdf.exe" });

test("her_pdf reports a missing qpdf with its winget line", async () => {
	const tools = toolHarness({ locator: new FakeLocator({}), runner: new FakeRunner() });
	const text = await runTool(tools.get("her_pdf"), { action: "merge", files: ["a.pdf", "b.pdf"] });
	assert.match(text, /qpdf 未安装/);
});

test("her_pdf merge needs at least two files", async () => {
	const { input } = tempPdf("a.pdf");
	const tools = toolHarness({ locator: qpdf, runner: new FakeRunner() });
	const text = await runTool(tools.get("her_pdf"), { action: "merge", files: [input] });
	assert.match(text, /至少两个/);
});

test("her_pdf merge builds the qpdf --empty --pages ... -- out recipe", async () => {
	const { dir, input } = tempPdf("a.pdf");
	const b = join(dir, "b.pdf");
	writeFileSync(b, "%PDF-1.7");
	const runner = new FakeRunner((call) => {
		if (call.args.includes("--show-npages")) return { stdout: "5" };
		return { writeFiles: [{ path: call.args[call.args.length - 1], content: "%PDF" }] };
	});
	const tools = toolHarness({ locator: qpdf, runner });

	const text = await runTool(tools.get("her_pdf"), { action: "merge", files: [input, b] });

	const out = join(dir, "merged.pdf");
	assert.deepEqual(runner.calls[0].args, ["--empty", "--pages", input, b, "--", out]);
	assert.match(text, /已合并 2 个 PDF/);
	assert.match(text, /5 页/);
});

test("her_pdf extract requires a pages range and passes it to qpdf", async () => {
	const { dir, input } = tempPdf("doc.pdf");
	const missingPages = await runTool(toolHarness({ locator: qpdf, runner: new FakeRunner() }).get("her_pdf"), {
		action: "extract",
		input,
	});
	assert.match(missingPages, /需要页码范围/);

	const runner = new FakeRunner((call) => {
		if (call.args.includes("--show-npages")) return { stdout: "4" };
		return { writeFiles: [{ path: call.args[call.args.length - 1], content: "%PDF" }] };
	});
	const tools = toolHarness({ locator: qpdf, runner });
	await runTool(tools.get("her_pdf"), { action: "extract", input, pages: "2-5" });
	assert.deepEqual(runner.calls[0].args, [input, "--pages", ".", "2-5", "--", join(dir, "doc-p2_5.pdf")]);
});

test("her_pdf encrypt requires userPassword and uses 256-bit encryption", async () => {
	const { dir, input } = tempPdf("doc.pdf");
	const noPw = await runTool(toolHarness({ locator: qpdf, runner: new FakeRunner() }).get("her_pdf"), {
		action: "encrypt",
		input,
	});
	assert.match(noPw, /需要 userPassword/);

	const runner = new FakeRunner((call) => ({
		writeFiles: [{ path: call.args[call.args.length - 1], content: "%PDF" }],
	}));
	const tools = toolHarness({ locator: qpdf, runner });
	await runTool(tools.get("her_pdf"), { action: "encrypt", input, userPassword: "s3cret" });
	assert.deepEqual(runner.calls[0].args, [
		"--encrypt",
		"s3cret",
		"s3cret",
		"256",
		"--",
		input,
		join(dir, "doc.enc.pdf"),
	]);
});

test("her_pdf decrypt refuses without a password (no brute force)", async () => {
	const { input } = tempPdf("doc.pdf");
	const tools = toolHarness({ locator: qpdf, runner: new FakeRunner() });
	const text = await runTool(tools.get("her_pdf"), { action: "decrypt", input });
	assert.match(text, /需要 password/);
	assert.match(text, /不做爆破/);
});

test("her_pdf shrink honestly reports Ghostscript is not installed and does not crash", async () => {
	const { input } = tempPdf("big.pdf");
	const runner = new FakeRunner();
	// gswin64c intentionally absent from the locator.
	const tools = toolHarness({ locator: qpdf, runner });

	const text = await runTool(tools.get("her_pdf"), { action: "shrink", input });

	assert.match(text, /Ghostscript/);
	assert.match(text, /未安装/);
	assert.equal(runner.calls.length, 0);
});
