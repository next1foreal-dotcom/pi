import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { runHerCli } from "../src/cli.ts";
import { initStore, Memory, parseFrontmatter } from "../src/her-core/index.ts";
import { withAgentBrowserTestLock, withSafeFixtureServer } from "./agent-browser-e2e.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

async function gitBackedTasteStore(): Promise<{ store: string }> {
	const store = await mkdtemp(join(tmpdir(), "her-taste-cli-"));
	const remote = await mkdtemp(join(tmpdir(), "her-taste-cli-remote-"));
	await initStore(store);
	await git(remote, "init", "--bare");
	await git(store, "init");
	await git(store, "config", "user.name", "Her Taste CLI Test");
	await git(store, "config", "user.email", "her-taste-cli-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await git(store, "branch", "-M", "master");
	await git(store, "remote", "add", "origin", remote);
	await git(store, "push", "-u", "origin", "master");
	return { store };
}

function stringWritable(): { read: () => string; stream: NodeJS.WritableStream } {
	let output = "";
	return {
		read: () => output,
		stream: new Writable({
			write(chunk, _encoding, callback) {
				output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
				callback();
			},
		}),
	};
}

async function runTasteCli(
	args: string[],
	store: string,
	options: { stdinText?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const stdout = stringWritable();
	const stderr = stringWritable();
	const stdin = options.stdinText !== undefined ? Readable.from([options.stdinText]) : undefined;
	const code = await runHerCli(args, { ...process.env, HER_MEMORY_DIR: store }, store, {
		stdout: stdout.stream,
		stderr: stderr.stream,
		...(stdin ? { stdin } : {}),
	});
	return { code, stdout: stdout.read(), stderr: stderr.read() };
}

test("CLI intake-taste creates a taste card from a local path with fei and boards", async () => {
	const { store } = await gitBackedTasteStore();
	const sourceRoot = await mkdtemp(join(tmpdir(), "her-taste-source-"));
	const source = join(sourceRoot, "own-design-tool.md");
	await writeFile(source, "# Own Design Tool\n\nA reference on building your own design tool.\n", "utf8");

	const result = await runTasteCli(
		["intake-taste", source, "--fei", "好东西", "--boards", "design,agent", "--json"],
		store,
	);
	assert.equal(result.code, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.match(payload.result.noteId, /^[0-9a-f]{8}$/);
	assert.deepEqual(payload.result.boards, ["design", "agent"]);
	assert.equal(payload.result.fei, "好东西");

	const world = await readFile(join(store, "world", "own-design-tool.md"), "utf8");
	const parsed = parseFrontmatter(world);
	assert.equal(parsed.data.source_type, "taste-card");
	assert.deepEqual(parsed.data.boards, ["design", "agent"]);
	assert.equal(parsed.data.fei, "好东西");
	assert.ok(parsed.data.snapshot);
	const snapshot = parsed.data.snapshot as { text: string; screenshot: unknown; media: unknown[] };
	assert.match(snapshot.text, /^world\/_snapshots\//);
	assert.equal(snapshot.screenshot, null);
	assert.deepEqual(snapshot.media, []);

	const seen = JSON.parse(await readFile(join(store, ".her", "seen.json"), "utf8"));
	assert.ok(Object.values(seen).includes(parsed.data.id));

	const snapshotText = await readFile(join(store, snapshot.text), "utf8");
	assert.match(snapshotText, /building your own design tool/);
});

test("CLI intake-taste on a repeat contentHash merges boards and keeps fei", async () => {
	const { store } = await gitBackedTasteStore();
	const sourceRoot = await mkdtemp(join(tmpdir(), "her-taste-source-2-"));
	const source = join(sourceRoot, "repeat-card.md");
	await writeFile(source, "# Repeat Card\n\nSame content both times.\n", "utf8");

	const first = await runTasteCli(
		["intake-taste", source, "--fei", "keep me", "--boards", "design,agent", "--json"],
		store,
	);
	assert.equal(first.code, 0, first.stderr);
	const firstPayload = JSON.parse(first.stdout);

	const second = await runTasteCli(["intake-taste", source, "--boards", "motion", "--json"], store);
	assert.equal(second.code, 0, second.stderr);
	const secondPayload = JSON.parse(second.stdout);

	assert.equal(secondPayload.result.noteId, firstPayload.result.noteId);

	const worldFiles = (await readdir(join(store, "world"))).filter((entry) => entry.endsWith(".md"));
	assert.deepEqual(worldFiles, ["repeat-card.md"]);

	const world = await readFile(join(store, "world", "repeat-card.md"), "utf8");
	const parsed = parseFrontmatter(world);
	assert.deepEqual([...(parsed.data.boards as string[])].sort(), ["agent", "design", "motion"]);
	assert.equal(parsed.data.fei, "keep me");
});

function baseTasteData(overrides: Partial<Parameters<Memory["writeWorldNote"]>[0]> = {}) {
	return {
		title: "Repeat Intake Backfill",
		sourceUrl: "https://x.com/lukaivanovic/status/2079178687409279303",
		sourceType: "taste-card" as const,
		contentHash: "repeat-backfill-hash",
		memoryStatus: "active" as const,
		extracted: "Two nested jpgs from twitter/lukaivanovic/.",
		coverage: "Read full tweet.",
		read: "The useful point is the nested media layout.",
		steal: [],
		connections: [],
		take: "Worth stealing.",
		possibleMoves: [],
		boards: ["design"],
		fei: "",
		...overrides,
	};
}

test("writeWorldNote backfills a repeat taste-card's stale-empty snapshot.media/screenshot without overwriting existing values", async () => {
	const store = await mkdtemp(join(tmpdir(), "her-taste-backfill-"));
	await initStore(store);
	const memory = new Memory(store);

	// First intake: simulates the pre-fix bug where listExistingFiles was non-recursive and
	// registered an empty media array + no screenshot despite real captured material on disk.
	const firstId = await memory.writeWorldNote(
		baseTasteData({
			snapshot: { text: "world/_snapshots/repeat-backfill/original.md", screenshot: null, media: [] },
		}),
	);

	// Repeat intake (same contentHash, e.g. a rerun after the fix): incoming snapshot now carries
	// the real media/screenshot the fixed capture found. The on-disk card must be backfilled.
	const secondId = await memory.writeWorldNote(
		baseTasteData({
			snapshot: {
				text: "world/_snapshots/repeat-backfill/original.md",
				screenshot: "world/_snapshots/repeat-backfill/page.png",
				media: ["taste-media/repeat-backfill/twitter/lukaivanovic/one.jpg"],
			},
		}),
	);
	assert.equal(secondId, firstId);

	const worldFiles = (await readdir(join(store, "world"))).filter((entry) => entry.endsWith(".md"));
	assert.deepEqual(worldFiles, ["repeat-intake-backfill.md"]);
	const text = await readFile(join(store, "world", worldFiles[0]), "utf8");
	const parsed = parseFrontmatter(text);
	const snapshotAfterBackfill = parsed.data.snapshot as { text: string; screenshot: string | null; media: string[] };
	assert.equal(snapshotAfterBackfill.screenshot, "world/_snapshots/repeat-backfill/page.png");
	assert.deepEqual(snapshotAfterBackfill.media, ["taste-media/repeat-backfill/twitter/lukaivanovic/one.jpg"]);

	// A third intake with different incoming media must NOT overwrite the now-populated values.
	const thirdId = await memory.writeWorldNote(
		baseTasteData({
			snapshot: {
				text: "world/_snapshots/repeat-backfill/original.md",
				screenshot: "world/_snapshots/repeat-backfill/different.png",
				media: ["taste-media/repeat-backfill/should-not-appear.jpg"],
			},
		}),
	);
	assert.equal(thirdId, firstId);
	const textAfterThird = await readFile(join(store, "world", worldFiles[0]), "utf8");
	const parsedAfterThird = parseFrontmatter(textAfterThird);
	const snapshotAfterThird = parsedAfterThird.data.snapshot as {
		text: string;
		screenshot: string | null;
		media: string[];
	};
	assert.equal(snapshotAfterThird.screenshot, "world/_snapshots/repeat-backfill/page.png");
	assert.deepEqual(snapshotAfterThird.media, ["taste-media/repeat-backfill/twitter/lukaivanovic/one.jpg"]);
});

test("CLI intake-taste reads stdin text as a taste card", async () => {
	const { store } = await gitBackedTasteStore();
	const result = await runTasteCli(["intake-taste", "-", "--boards", "quote", "--json"], store, {
		stdinText: "A perfect quote about slow mornings and good coffee.",
	});
	assert.equal(result.code, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.result.boards, ["quote"]);

	const worldFiles = (await readdir(join(store, "world"))).filter((entry) => entry.endsWith(".md"));
	assert.equal(worldFiles.length, 1);
	const world = await readFile(join(store, "world", worldFiles[0]), "utf8");
	const parsed = parseFrontmatter(world);
	assert.equal(parsed.data.source_type, "taste-card");
	assert.equal(parsed.data.source_url, "text");
	assert.match(world, /A perfect quote about slow mornings/);
});

test("CLI intake-taste rejects an internal URL under SSRF protection", async () => {
	const { store } = await gitBackedTasteStore();
	await assert.rejects(
		() => runTasteCli(["intake-taste", "http://127.0.0.1/x", "--json"], store),
		/blocked (private|local) URL host/,
	);
});

test("CLI intake-taste captures a full-page screenshot for a webpage URL (palate T2, real agent-browser run)", async () => {
	const { store } = await gitBackedTasteStore();
	const html = [
		"<!doctype html><html><head><title>Palate T2 Webpage Fixture</title></head>",
		'<body style="margin:0"><h1 style="padding:40px">Palate T2 CLI Screenshot Test</h1>',
		'<div style="height:1200px;background:linear-gradient(#eee,#999)"></div></body></html>',
	].join("\n");
	await withAgentBrowserTestLock(async () => {
		await withSafeFixtureServer(html, async (url) => {
			const stdout = stringWritable();
			const stderr = stringWritable();
			const code = await runHerCli(
				["intake-taste", url, "--boards", "web", "--json"],
				{
					...process.env,
					HER_ALLOW_LOCAL_URLS: "1",
					HER_MEMORY_DIR: store,
				},
				store,
				{ stdout: stdout.stream, stderr: stderr.stream },
			);
			assert.equal(code, 0, stderr.read());

			const payload = JSON.parse(stdout.read());
			const worldFiles = (await readdir(join(store, "world"))).filter((entry) => entry.endsWith(".md"));
			const world = await readFile(join(store, "world", worldFiles[0]), "utf8");
			const parsed = parseFrontmatter(world);
			const snapshot = parsed.data.snapshot as { text: string; screenshot: string; media: unknown[] };
			assert.match(snapshot.screenshot, /^world\/_snapshots\/.+\/page\.png$/);
			assert.deepEqual(snapshot.media, []);

			const stats = await stat(join(store, snapshot.screenshot));
			assert.ok(stats.size > 1000, `expected a real PNG, got ${stats.size} bytes`);
			assert.equal(payload.result.contentHash, parsed.data.content_hash);
		});
	});
});
test("CLI intake-taste copies a local PDF original into taste-media and extracts its text layer (palate T2)", async () => {
	const { store } = await gitBackedTasteStore();
	const sourceRoot = await mkdtemp(join(tmpdir(), "her-taste-pdf-source-"));
	const pdfPath = join(sourceRoot, "field-notes.pdf");
	const minimalPdf = [
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
	await writeFile(pdfPath, minimalPdf, "utf8");

	const result = await runTasteCli(["intake-taste", pdfPath, "--boards", "reading", "--json"], store);
	assert.equal(result.code, 0, result.stderr);

	const worldFiles = (await readdir(join(store, "world"))).filter((entry) => entry.endsWith(".md"));
	const world = await readFile(join(store, "world", worldFiles[0]), "utf8");
	const parsed = parseFrontmatter(world);
	const snapshot = parsed.data.snapshot as { text: string; screenshot: unknown; media: string[] };
	assert.equal(snapshot.screenshot, null);
	assert.equal(snapshot.media.length, 1);
	assert.match(snapshot.media[0] ?? "", /^taste-media\/.+\/field-notes\.pdf$/);

	const copied = await readFile(join(store, snapshot.media[0] ?? ""), "utf8");
	assert.equal(copied, minimalPdf);

	const snapshotText = await readFile(join(store, snapshot.text), "utf8");
	assert.match(snapshotText, /Hello Taste PDF/);
});

test("CLI intake-taste degrades gracefully when the screenshot tool binary is missing (palate T2)", async () => {
	const { store } = await gitBackedTasteStore();
	const html = "<!doctype html><html><body><h1>Unreachable tool fixture</h1></body></html>";
	await withSafeFixtureServer(html, async (url) => {
		const stdout = stringWritable();
		const stderr = stringWritable();
		const code = await runHerCli(
			["intake-taste", url, "--json"],
			{
				...process.env,
				HER_ALLOW_LOCAL_URLS: "1",
				HER_AGENT_BROWSER_BIN: join(store, "no-such-agent-browser.exe"),
				HER_MEMORY_DIR: store,
			},
			store,
			{ stdout: stdout.stream, stderr: stderr.stream },
		);
		assert.equal(code, 0, stderr.read());
		assert.match(stderr.read(), /intake-taste:.*screenshot capture failed/);

		const worldFiles = (await readdir(join(store, "world"))).filter((entry) => entry.endsWith(".md"));
		const world = await readFile(join(store, "world", worldFiles[0]), "utf8");
		const parsed = parseFrontmatter(world);
		const snapshot = parsed.data.snapshot as { text: string; screenshot: unknown; media: unknown[] };
		assert.equal(snapshot.screenshot, null);
		assert.deepEqual(snapshot.media, []);
		// text still lands even though the screenshot failed (degrade, don't lose the card).
		const snapshotText = await readFile(join(store, snapshot.text), "utf8");
		assert.ok(snapshotText.length > 0);
	});
});
