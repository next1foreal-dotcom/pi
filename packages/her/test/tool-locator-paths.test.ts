import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, relative, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { globFirst } from "../src/tools/locate.ts";

async function fixture(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-locator-"));
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
	return root;
}

// PR #10 workspace follow-up: use native filesystem paths on both Linux and Windows.
test("globFirst preserves an absolute root and expands a versioned directory with spaces", async (t) => {
	const root = await fixture(t);
	const file = join(root, "qpdf 12.3.2", "bin", "qpdf.exe");
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, "");
	assert.equal(globFirst(join(root, "qpdf*", "bin", "qpdf.exe")), file);
});

test("globFirst preserves the native filesystem root itself", () => {
	const root = parse(process.cwd()).root;
	assert.equal(globFirst(root), root);
});

test("globFirst returns an exact existing path without inventing separators", async (t) => {
	const root = await fixture(t);
	const file = join(root, "plain.txt");
	await writeFile(file, "");
	assert.equal(globFirst(file), file);
});

test("globFirst handles multiple wildcard segments and keeps descending-name preference", async (t) => {
	const root = await fixture(t);
	for (const version of ["1.0", "2.0"]) {
		const file = join(root, `tool-${version}`, "bin-x64", "tool.exe");
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, "");
	}
	assert.equal(globFirst(join(root, "tool-*", "bin-*", "*.exe")), join(root, "tool-2.0", "bin-x64", "tool.exe"));
});

test("globFirst falls back when the preferred directory lacks the requested binary", async (t) => {
	const root = await fixture(t);
	await mkdir(join(root, "tool-9", "bin"), { recursive: true });
	await mkdir(join(root, "tool-8", "bin"), { recursive: true });
	const file = join(root, "tool-8", "bin", "tool.exe");
	await writeFile(file, "");
	assert.equal(globFirst(join(root, "tool-*", "bin", "tool.exe")), file);
});

test("globFirst treats regex metacharacters literally and supports Unicode directory names", async (t) => {
	const root = await fixture(t);
	const file = join(root, "工具 [x]+ 1.0", "tool.exe");
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, "");
	assert.equal(globFirst(join(root, "工具 [x]+ *", "tool.exe")), file);
	assert.equal(globFirst(join(root, "工具 x *", "tool.exe")), null);
});

test("globFirst returns null for missing paths and non-directory wildcard parents", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "file"), "");
	assert.equal(globFirst(join(root, "missing*", "tool.exe")), null);
	assert.equal(globFirst(join(root, "file", "*")), null);
	assert.equal(globFirst(join(root, "absent")), null);
});

test("globFirst resolves relative patterns without changing the caller working directory", async (t) => {
	const root = await fixture(t);
	const file = join(root, "qpdf-1", "qpdf.exe");
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, "");
	const cwd = process.cwd();
	const pattern = join(relative(cwd, root), "qpdf-*", "qpdf.exe");
	assert.equal(globFirst(pattern), relative(cwd, file));
	assert.equal(process.cwd(), cwd);
	assert.equal(basename(globFirst(pattern)!), "qpdf.exe");
});

test("globFirst accepts forward slashes and repeated native separators", async (t) => {
	const root = await fixture(t);
	const file = join(root, "folder", "tool.exe");
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, "");
	assert.equal(globFirst(`${root}${sep}${sep}folder${sep}*.exe`), file);
	assert.equal(globFirst(join(root, "folder", "*.exe").replaceAll("\\", "/")), file);
});
