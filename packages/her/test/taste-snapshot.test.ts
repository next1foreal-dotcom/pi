import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildLocalPdfTasteData,
	captureTasteSnapshot,
	extractLocalPdfText,
	resolveTasteMediaRoot,
	resolveTasteToolConfig,
	resolveWithinRoot,
} from "../src/her-core/taste-snapshot.ts";

// Hand-written minimal PDF (no valid xref table); pdftotext recovers it via its reconstruction
// path. Verified with a real `pdftotext -layout` run during T2 development (see task report).
const MINIMAL_PDF = [
	"%PDF-1.4",
	"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
	"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
	"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
	"4 0 obj<</Length 58>>stream",
	"BT /F1 24 Tf 20 100 Td (Hello Taste PDF) Tj ET",
	"endstream",
	"endobj",
	"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
	"trailer<</Size 6/Root 1 0 R>>",
	"%%EOF",
].join("\n");

function tools(overrides: Partial<ReturnType<typeof resolveTasteToolConfig>> = {}) {
	return { ...resolveTasteToolConfig({}), ...overrides };
}

test("resolveWithinRoot accepts paths inside the root", () => {
	const resolved = resolveWithinRoot("D:\\her-memory\\taste-media", "a-slug", "file.jpg");
	assert.match(resolved.replace(/\\/g, "/"), /taste-media\/a-slug\/file\.jpg$/);
});

test("resolveWithinRoot rejects a segment that escapes the root (contract path-traversal gate)", () => {
	assert.throws(() => resolveWithinRoot("D:\\her-memory\\taste-media", "..", "..", "evil.txt"), /escapes its root/);
	assert.throws(() => resolveWithinRoot("D:\\her-memory\\taste-media", "..\\evil-sibling"), /escapes its root/);
});

test("resolveTasteMediaRoot places media under <memoryDir>/taste-media", () => {
	const root = resolveTasteMediaRoot("D:\\her-memory");
	assert.equal(root.replace(/\\/g, "/"), "D:/her-memory/taste-media");
});

test("captureTasteSnapshot degrades loudly when grab.py's python binary does not exist", async () => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-taste-snapshot-"));
	const result = await captureTasteSnapshot({
		kind: "tweet",
		memoryDir,
		slug: "missing-tool-slug",
		sourceUrl: "https://x.com/someone/status/12345",
		tools: tools({ grabPyPython: join(memoryDir, "no-such-python-binary.exe") }),
	});
	assert.deepEqual(result.media, []);
	assert.equal(result.screenshot, null);
	assert.ok(result.warnings.length > 0, "expected a warning explaining the missing tool");
	assert.match(result.warnings.join("\n"), /grab\.py media capture failed/);
});

test("captureTasteSnapshot is idempotent: an already-populated media dir is reused without invoking the tool", async () => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-taste-snapshot-"));
	const mediaRoot = resolveTasteMediaRoot(memoryDir);
	const mediaDir = join(mediaRoot, "repeat-slug");
	await mkdir(mediaDir, { recursive: true });
	await writeFile(join(mediaDir, "already-here.jpg"), "fake-bytes");

	// Deliberately broken tool config: if the idempotency guard failed and grab.py were invoked,
	// this would either throw or add a failure warning instead of reusing the existing file.
	const result = await captureTasteSnapshot({
		kind: "tweet",
		memoryDir,
		slug: "repeat-slug",
		sourceUrl: "https://x.com/someone/status/99999",
		tools: tools({ grabPyPython: join(memoryDir, "no-such-python-binary.exe") }),
	});
	assert.deepEqual(result.media, ["taste-media/repeat-slug/already-here.jpg"]);
	assert.deepEqual(result.warnings, []);
});

test("captureTasteSnapshot copies a local PDF original into taste-media and is idempotent on repeat", async () => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-taste-snapshot-"));
	const sourceDir = await mkdtemp(join(tmpdir(), "her-taste-pdf-source-"));
	const pdfPath = join(sourceDir, "report.pdf");
	await writeFile(pdfPath, MINIMAL_PDF, "utf8");

	const first = await captureTasteSnapshot({
		kind: "local-pdf",
		localPath: pdfPath,
		memoryDir,
		slug: "report-slug",
		sourceUrl: `file://${pdfPath.replace(/\\/g, "/")}`,
		tools: tools(),
	});
	assert.deepEqual(first.media, ["taste-media/report-slug/report.pdf"]);
	assert.equal(first.screenshot, null);
	assert.deepEqual(first.warnings, []);
	const copiedBytes = await readFile(join(resolveTasteMediaRoot(memoryDir), "report-slug", "report.pdf"));
	assert.equal(copiedBytes.toString("utf8"), MINIMAL_PDF);

	// Repeat capture must not re-copy: proven by deleting the source first. If the guard were
	// missing, this call would try to copyFile from a path that no longer exists and fail.
	await unlink(pdfPath);
	const second = await captureTasteSnapshot({
		kind: "local-pdf",
		localPath: pdfPath,
		memoryDir,
		slug: "report-slug",
		sourceUrl: `file://${pdfPath.replace(/\\/g, "/")}`,
		tools: tools(),
	});
	assert.deepEqual(second.media, ["taste-media/report-slug/report.pdf"]);
	assert.deepEqual(second.warnings, []);
});

test("captureTasteSnapshot rejects a slug that would place media outside taste-media/", async () => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-taste-snapshot-"));
	await assert.rejects(
		() =>
			captureTasteSnapshot({
				kind: "tweet",
				memoryDir,
				slug: "../../escape-attempt",
				sourceUrl: "https://x.com/someone/status/1",
				tools: tools(),
			}),
		/escapes its root/,
	);
});

test("extractLocalPdfText reads the text layer via a real pdftotext invocation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "her-taste-pdf-text-"));
	const pdfPath = join(dir, "mini.pdf");
	await writeFile(pdfPath, MINIMAL_PDF, "utf8");
	const result = await extractLocalPdfText(pdfPath, tools());
	assert.equal(result.ok, true);
	assert.match(result.extracted, /Hello Taste PDF/);
});

test("extractLocalPdfText degrades to a stub when pdftotext is missing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "her-taste-pdf-text-"));
	const pdfPath = join(dir, "mini.pdf");
	await writeFile(pdfPath, MINIMAL_PDF, "utf8");
	const result = await extractLocalPdfText(pdfPath, tools({ pdftotextBin: join(dir, "no-such-pdftotext.exe") }));
	assert.equal(result.ok, false);
	assert.ok(result.warning);
	assert.match(result.extracted, /PDF text layer not extracted/);
});

test("buildLocalPdfTasteData marks memoryStatus active with the extracted text, or needs_deep_read with a reason on failure", () => {
	const ok = buildLocalPdfTasteData("C:\\docs\\report.pdf", { extracted: "Hello Taste PDF", ok: true });
	assert.equal(ok.data.memoryStatus, "active");
	assert.equal(ok.data.sourceType, "local-pdf");
	assert.equal(ok.data.title, "report");
	assert.equal(ok.data.memoryStatusReason, undefined);

	const failed = buildLocalPdfTasteData("C:\\docs\\report.pdf", {
		extracted: "(PDF text layer not extracted: boom)",
		ok: false,
		warning: "boom",
	});
	assert.equal(failed.data.memoryStatus, "needs_deep_read");
	assert.equal(failed.data.memoryStatusReason, "boom");
});

test("captureTasteSnapshot takes a real full-page screenshot of a local fixture page via agent-browser", async () => {
	const html = [
		"<!doctype html><html><head><title>Taste Snapshot Fixture</title></head>",
		'<body style="margin:0"><h1 style="padding:40px">Taste Snapshot Test Page</h1>',
		'<div style="height:1400px;background:linear-gradient(#eee,#999)"></div></body></html>',
	].join("\n");
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end(html);
	});
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected a TCP address");
	const url = `http://127.0.0.1:${address.port}/fixture`;

	try {
		const memoryDir = await mkdtemp(join(tmpdir(), "her-taste-snapshot-"));
		const result = await captureTasteSnapshot({
			kind: "webpage",
			memoryDir,
			slug: "webpage-slug",
			sourceUrl: url,
			tools: tools(),
		});
		assert.equal(result.media.length, 0);
		assert.ok(result.screenshot, `expected a screenshot path; warnings: ${result.warnings.join("; ")}`);
		assert.match((result.screenshot ?? "").replace(/\\/g, "/"), /^world\/_snapshots\/webpage-slug\/page\.png$/);
		const screenshotPath = join(memoryDir, result.screenshot ?? "");
		const stats = await stat(screenshotPath);
		assert.ok(stats.size > 1000, `expected a real PNG file, got ${stats.size} bytes`);

		// Idempotent repeat: reuses the file without invoking agent-browser again.
		const repeat = await captureTasteSnapshot({
			kind: "webpage",
			memoryDir,
			slug: "webpage-slug",
			sourceUrl: url,
			tools: tools({ agentBrowserBin: join(memoryDir, "no-such-agent-browser.exe") }),
		});
		assert.equal(repeat.screenshot, result.screenshot);
		assert.deepEqual(repeat.warnings, []);
	} finally {
		await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	}
});
