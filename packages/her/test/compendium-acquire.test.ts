import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireSources, classifySource, cleanVtt, countWords, stripHtml } from "../src/compendium/acquire.ts";

function responseText(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function responseJson(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("classifySource applies the ordered source rules", () => {
	assert.deepEqual(classifySource("https://www.youtube.com/watch?v=abc"), { kind: "youtube" });
	assert.deepEqual(classifySource("https://youtu.be/abc"), { kind: "youtube" });
	assert.deepEqual(classifySource("https://x.com/user/status/123"), { kind: "tweet", id: "123" });
	assert.deepEqual(classifySource("https://twitter.com/user/status/456"), { kind: "tweet", id: "456" });
	assert.deepEqual(classifySource("https://example.com/article"), { kind: "web" });
	assert.deepEqual(classifySource("notes/brief.md"), { kind: "local", extension: ".md" });
});

test("stripHtml and cleanVtt produce compact timestamped text", () => {
	assert.equal(
		stripHtml("<h1>Title</h1><script>bad()</script><p>Hello&nbsp;world &amp; all</p>"),
		"Title Hello world & all",
	);
	const vtt =
		"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello <b>there</b>\n\n00:00:03.500 --> 00:00:04.000\nSecond line\n";
	assert.equal(cleanVtt(vtt), "[00:00:01.000] Hello there\n[00:00:03.500] Second line");
	assert.equal(countWords("one two\nthree"), 3);
});

test("acquireSources writes all material kinds and a manifest with injected IO", async () => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-compendium-"));
	const localPath = join(memoryDir, "source.md");
	await writeFile(localPath, "Local source words here.", "utf8");
	const calls: string[] = [];
	const fetcher = async (url: string): Promise<Response> => {
		calls.push(url);
		if (url === "https://api.fxtwitter.com/status/123") {
			return responseJson({
				tweet: {
					text: "A fixture tweet",
					media: { all: [{ type: "photo", url: "https://cdn.example/photo.jpg" }] },
				},
			});
		}
		if (url === "https://cdn.example/photo.jpg") return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
		if (url === "https://example.com/article") return responseText("<main><p>Web fixture text.</p></main>");
		throw new Error(`unexpected URL: ${url}`);
	};
	const ytDlpRunner = async (_command: string, args: string[], _cwd: string) => {
		const output = args[args.indexOf("--output") + 1];
		assert.ok(output);
		await writeFile(
			output.replace("%(ext)s", "zh.vtt"),
			"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nVideo words\n",
			"utf8",
		);
		return { stdout: "", stderr: "" };
	};

	const manifest = await acquireSources(
		[
			"https://www.youtube.com/watch?v=abc",
			"https://x.com/user/status/123",
			"https://example.com/article",
			localPath,
		],
		"fixture-batch",
		{ memoryDir, env: {}, now: () => "2026-08-12T12:00:00.000Z", fetcher, ytDlpRunner },
	);

	assert.equal(manifest.items.length, 4);
	assert.deepEqual(
		manifest.items.map((item) => [item.kind, item.status]),
		[
			["youtube", "ok"],
			["tweet", "ok"],
			["web", "ok"],
			["local", "ok"],
		],
	);
	assert.deepEqual(
		manifest.items.map((item) => item.fetchedAt),
		["2026-08-12T12:00:00.000Z", "2026-08-12T12:00:00.000Z", "2026-08-12T12:00:00.000Z", "2026-08-12T12:00:00.000Z"],
	);
	assert.ok(manifest.items.every((item) => item.localPath.startsWith("materials/")));
	assert.ok(calls.includes("https://api.fxtwitter.com/status/123"));
	assert.ok(calls.includes("https://cdn.example/photo.jpg"));
	const compendium = join(memoryDir, ".her", "compendium", "fixture-batch");
	const savedManifest = JSON.parse(await readFile(join(compendium, "manifest.json"), "utf8")) as typeof manifest;
	assert.deepEqual(savedManifest, manifest);
	const files = await readdir(join(compendium, "materials"));
	assert.equal(files.length, 5);
	assert.match(
		await readFile(join(compendium, "materials", "001-youtube.txt"), "utf8"),
		/\[00:00:01.000\] Video words/,
	);
	assert.match(
		await readFile(join(compendium, "materials", "002-tweet.txt"), "utf8"),
		/Media URLs:\n- https:\/\/cdn\.example\/photo\.jpg/,
	);
});

test("a failed item is recorded and does not stop the batch", async () => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-compendium-failure-"));
	const localPath = join(memoryDir, "after.txt");
	await writeFile(localPath, "after failure", "utf8");
	const manifest = await acquireSources(["https://example.com/fails", localPath], "failure-batch", {
		memoryDir,
		env: {},
		fetcher: async () => {
			throw new Error("fixture network failure");
		},
		now: () => "2026-08-12T12:00:00.000Z",
	});
	assert.equal(manifest.items[0]?.status, "failed");
	assert.match(manifest.items[0]?.error ?? "", /fetch-failed/);
	assert.equal(manifest.items[1]?.status, "ok");
});
test("web acquisition uses the Jina fallback only when a key is supplied", async () => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-compendium-jina-"));
	const calls: string[] = [];
	const manifest = await acquireSources(["https://example.com/fallback"], "jina-batch", {
		memoryDir,
		env: { JINA_API_KEY: "fixture-key" },
		fetcher: async (url: string, init?: RequestInit) => {
			calls.push(`${url}:${init?.headers ? "headers" : "no-headers"}`);
			if (url === "https://example.com/fallback") throw new Error("origin unavailable");
			return responseText("<article>Jina fallback body.</article>");
		},
		now: () => "2026-08-12T12:00:00.000Z",
	});
	assert.equal(manifest.items[0]?.status, "ok");
	assert.equal(manifest.items[0]?.words, 3);
	assert.deepEqual(calls, [
		"https://example.com/fallback:no-headers",
		"https://r.jina.ai/https://example.com/fallback:headers",
	]);
});

test("YouTube subtitles prefer zh VTT over en VTT", async () => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-compendium-language-"));
	const manifest = await acquireSources(["https://youtu.be/language"], "language-batch", {
		memoryDir,
		env: {},
		ytDlpRunner: async (_command, args) => {
			const output = args[args.indexOf("--output") + 1];
			assert.ok(output);
			await writeFile(
				output.replace("%(ext)s", "en.vtt"),
				"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEnglish\n",
				"utf8",
			);
			await writeFile(
				output.replace("%(ext)s", "zh.vtt"),
				"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nPreferred\n",
				"utf8",
			);
			return { stdout: "", stderr: "" };
		},
		now: () => "2026-08-12T12:00:00.000Z",
	});
	assert.equal(manifest.items[0]?.status, "ok");
	const file = join(memoryDir, ".her", "compendium", "language-batch", "materials", "001-youtube.txt");
	assert.match(await readFile(file, "utf8"), /Preferred/);
	assert.doesNotMatch(await readFile(file, "utf8"), /English/);
});
