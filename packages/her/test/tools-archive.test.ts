import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeLocator, FakeRunner, runTool, toolHarness } from "./tools-harness.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "her-archive-"));
}

test("her_archive reports a missing 7z with its winget line", async () => {
	const tools = toolHarness({ locator: new FakeLocator({}), runner: new FakeRunner() });
	const text = await runTool(tools.get("her_archive"), { action: "list", target: "x.7z" });
	assert.match(text, /7z 未安装/);
	assert.match(text, /winget install/);
});

test("her_archive pack zip records -mcu=on and reports success", async () => {
	const dir = tempDir();
	const file = join(dir, "note.txt");
	writeFileSync(file, "hi");
	const target = join(dir, "bundle.zip");
	const runner = new FakeRunner((call) => ({ writeFiles: [{ path: call.args[1], bytes: 30 }] }));
	const tools = toolHarness({ locator: new FakeLocator({ "7z": "7z.exe" }), runner });

	const text = await runTool(tools.get("her_archive"), { action: "pack", target, files: [file] });

	assert.deepEqual(runner.calls[0].args, ["a", target, file, "-mcu=on"]);
	assert.match(text, /已打包/);
});

test("her_archive pack refuses an empty file list", async () => {
	const dir = tempDir();
	const runner = new FakeRunner();
	const tools = toolHarness({ locator: new FakeLocator({ "7z": "7z.exe" }), runner });

	const text = await runTool(tools.get("her_archive"), { action: "pack", target: join(dir, "b.zip"), files: [] });

	assert.match(text, /至少一个/);
	assert.equal(runner.calls.length, 0);
});

test("her_archive unpack maps a wrong-password failure to a clear message", async () => {
	const dir = tempDir();
	const archive = join(dir, "secret.7z");
	writeFileSync(archive, "data");
	const runner = new FakeRunner(() => ({ ok: false, exitCode: 2, stderr: "Wrong password?" }));
	const tools = toolHarness({ locator: new FakeLocator({ "7z": "7z.exe" }), runner });

	const text = await runTool(tools.get("her_archive"), { action: "unpack", target: archive, password: "nope" });

	assert.match(text, /密码错误/);
	const args = runner.calls[0].args;
	assert.equal(args[0], "x");
	assert.ok(args.some((a) => a.startsWith("-o")));
	assert.ok(args.includes("-y"));
});

test("her_archive list surfaces the 7z listing output", async () => {
	const dir = tempDir();
	const archive = join(dir, "a.7z");
	writeFileSync(archive, "data");
	const runner = new FakeRunner(() => ({ stdout: "1 file, 中文.txt" }));
	const tools = toolHarness({ locator: new FakeLocator({ "7z": "7z.exe" }), runner });

	const text = await runTool(tools.get("her_archive"), { action: "list", target: archive });

	assert.match(text, /内容清单/);
	assert.match(text, /中文\.txt/);
});
