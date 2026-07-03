import assert from "node:assert/strict";
import type { lookup as dnsLookup } from "node:dns/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPathForWorldNote, readUrlForWorldNote } from "../src/her-core/index.ts";

function responseJson(data: unknown): Response {
	return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

function responseText(text: string): Response {
	return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

function responseTyped(text: string, contentType: string): Response {
	return new Response(text, { headers: { "content-type": contentType } });
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
	if (input instanceof Request) return input.url;
	if (input instanceof URL) return input.href;
	return String(input);
}

type PinnedFetchInit = Omit<RequestInit, "dispatcher"> & { dispatcher?: { pinnedAddress?: string } };

test("path intake reads a full local markdown source with honest coverage", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-path-intake-"));
	const source = join(root, "reference-note.md");
	await writeFile(
		source,
		"# Local Reference\n\nFeeding local sources should create world notes with coverage.\n",
		"utf8",
	);

	const result = await readPathForWorldNote(source, { rootDir: root });

	assert.equal(result.data.title, "Local Reference");
	assert.equal(result.data.sourceType, "local-markdown");
	assert.equal(result.data.memoryStatus, "active");
	assert.match(result.data.sourceUrl, /^file:\/\//);
	assert.match(result.data.coverage, /Read full local local-markdown file reference-note\.md/);
	assert.match(result.data.extracted, /Feeding local sources/);
	assert.equal(result.truncated, false);
	assert.ok(result.bytesRead > 0);
});

test("URL intake deep reads selected GitHub repository files", async () => {
	const fetcher: typeof fetch = async (input) => {
		const url = inputUrl(input);
		if (url === "https://api.github.com/repos/next1foreal/her-sample") {
			return responseJson({
				default_branch: "main",
				description: "A small repository for Her repo intake verification.",
			});
		}
		if (url === "https://api.github.com/repos/next1foreal/her-sample/git/trees/main?recursive=1") {
			return responseJson({
				tree: [
					{ path: "README.md", size: 84, type: "blob" },
					{ path: "package.json", size: 44, type: "blob" },
					{ path: "src/index.ts", size: 160, type: "blob" },
					{ path: "dist/index.js", size: 120, type: "blob" },
				],
			});
		}
		if (url === "https://raw.githubusercontent.com/next1foreal/her-sample/main/README.md") {
			return responseText("# Her Sample\n\nThis repo demonstrates a durable memory intake path.");
		}
		if (url === "https://raw.githubusercontent.com/next1foreal/her-sample/main/package.json") {
			return responseText('{"name":"her-sample","type":"module"}');
		}
		if (url === "https://raw.githubusercontent.com/next1foreal/her-sample/main/src/index.ts") {
			return responseText("export function runSamanthaMemory() {\n\treturn 'durable';\n}\n");
		}
		throw new Error(`unexpected fetch: ${url}`);
	};
	const lookup = (async () => [{ address: "140.82.112.4", family: 4 }]) as unknown as typeof dnsLookup;

	const result = await readUrlForWorldNote("https://github.com/next1foreal/her-sample", {
		fetcher,
		lookup,
		maxRepoFiles: 3,
	});

	assert.equal(result.data.sourceType, "repo");
	assert.equal(result.data.sourceUrl, "https://github.com/next1foreal/her-sample");
	assert.equal(result.data.title, "next1foreal/her-sample repository");
	assert.equal(result.data.memoryStatus, "active");
	assert.match(result.data.coverage, /Read 3 repository files/);
	assert.match(result.data.coverage, /Files read: README\.md, package\.json, src\/index\.ts/);
	assert.match(result.data.coverage, /src\/index\.ts: runSamanthaMemory/);
	assert.match(result.data.extracted, /## README\.md/);
	assert.match(result.data.extracted, /## src\/index\.ts/);
	assert.match(result.data.extracted, /export function runSamanthaMemory/);
	assert.deepEqual(result.data.steal, ["src/index.ts: runSamanthaMemory"]);
	assert.equal(result.truncated, false);
	assert.ok(result.bytesRead > 0);
});

test("URL intake can read ordinary public pages from curl.md optimized markdown", async () => {
	const fetcher: typeof fetch = async () => {
		throw new Error("curl.md reader should avoid the raw HTML fetch path");
	};
	const lookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as typeof dnsLookup;
	const markdownReader = async (url: URL) => ({
		markdown: "# curl.md Docs\n\nTurn websites into optimized markdown for agents.",
		finalUrl: `${url.href.replace(/\/$/, "")}/docs`,
		source: "curl.md",
	});

	const result = await readUrlForWorldNote("https://example.com", { fetcher, lookup, markdownReader });

	assert.equal(result.data.sourceType, "article");
	assert.equal(result.data.sourceUrl, "https://example.com/docs");
	assert.equal(result.data.title, "curl.md Docs");
	assert.equal(result.data.memoryStatus, "active");
	assert.match(result.data.coverage, /curl\.md optimized markdown/);
	assert.match(result.data.extracted, /optimized markdown for agents/);
	assert.equal(result.truncated, false);
	assert.ok(result.bytesRead > 0);
});

test("URL intake can read X threads through an explicit social markdown reader", async () => {
	const fetcher: typeof fetch = async () => {
		throw new Error("X reader should avoid fetching unauthenticated login-wall HTML");
	};
	const lookup = (async () => [{ address: "104.244.42.1", family: 4 }]) as unknown as typeof dnsLookup;
	const xMarkdownReader = async (url: URL) => ({
		markdown: "# X Thread Fixture\n\nA public X thread extracted through Defuddle.",
		finalUrl: url.href,
		source: "defuddle",
	});

	const result = await readUrlForWorldNote("https://x.com/example/status/1234567890", {
		fetcher,
		lookup,
		xMarkdownReader,
	});

	assert.equal(result.data.sourceType, "x-thread");
	assert.equal(result.data.memoryStatus, "active");
	assert.match(result.data.extracted, /public X thread extracted through Defuddle/);
	assert.match(result.data.coverage, /defuddle optimized markdown/);
});

test("URL intake keeps allow-local URLs on the local fetch path instead of curl.md", async () => {
	const fetcher: typeof fetch = async () => responseText("# Local Debug Page\n\nLocal-only content stays local.");
	const markdownReader = async () => ({
		markdown: "# Leaked External Markdown\n\nThis should never be used for allow-local intake.",
		source: "curl.md",
	});

	const result = await readUrlForWorldNote("http://localhost:3977/debug", {
		allowLocal: true,
		fetcher,
		markdownReader,
	});

	assert.equal(result.data.title, "Local Debug Page");
	assert.match(result.data.extracted, /Local-only content stays local/);
	assert.doesNotMatch(result.data.extracted, /Leaked External Markdown/);
});

test("URL intake marks X threads as needs_deep_read without fetching login walls", async () => {
	const fetcher: typeof fetch = async () => {
		throw new Error("X thread intake should not fetch unauthenticated HTML");
	};
	const lookup = (async () => [{ address: "104.244.42.1", family: 4 }]) as unknown as typeof dnsLookup;
	const markdownReader = async () => {
		throw new Error("X thread intake should not send login-wall sources to curl.md");
	};

	const result = await readUrlForWorldNote("https://x.com/example/status/1234567890", {
		fetcher,
		lookup,
		markdownReader,
	});

	assert.equal(result.data.sourceType, "x-thread");
	assert.equal(result.data.memoryStatus, "needs_deep_read");
	assert.match(result.data.memoryStatusReason ?? "", /browser-native or authenticated reading/);
	assert.match(result.data.coverage, /minimal URL intake did not fetch login-wall HTML/);
	assert.equal(result.bytesRead, 0);
	assert.equal(result.truncated, false);
});

test("URL intake saves arXiv papers as abstract-only paper notes", async () => {
	const fetcher: typeof fetch = async (input) => {
		const url = inputUrl(input);
		assert.equal(url, "https://export.arxiv.org/api/query?id_list=2401.12345v2");
		return responseTyped(
			`<?xml version="1.0" encoding="UTF-8"?>
			<feed xmlns="http://www.w3.org/2005/Atom">
				<entry>
					<title>Her Memory Systems &amp; Durable Recall</title>
					<id>http://arxiv.org/abs/2401.12345v2</id>
					<published>2024-01-20T00:00:00Z</published>
					<author><name>Ada Example</name></author>
					<author><name>Grace Example</name></author>
					<category term="cs.AI"/>
					<category term="cs.CL"/>
					<summary>
						We present a memory system for long-lived agents. The method uses markdown as source of truth.
					</summary>
				</entry>
			</feed>`,
			"application/atom+xml; charset=utf-8",
		);
	};
	const lookup = (async () => [{ address: "151.101.65.91", family: 4 }]) as unknown as typeof dnsLookup;

	const result = await readUrlForWorldNote("https://arxiv.org/pdf/2401.12345v2.pdf", { fetcher, lookup });

	assert.equal(result.data.sourceType, "paper");
	assert.equal(result.data.sourceUrl, "https://arxiv.org/abs/2401.12345v2");
	assert.equal(result.data.title, "Her Memory Systems & Durable Recall");
	assert.equal(result.data.memoryStatus, "needs_deep_read");
	assert.match(result.data.memoryStatusReason ?? "", /Only arXiv metadata and abstract were read/);
	assert.match(result.data.coverage, /Orientation only: read arXiv metadata and abstract/);
	assert.match(result.data.coverage, /Full PDF body, methods, experiments, limitations/);
	assert.match(result.data.extracted, /Authors: Ada Example, Grace Example/);
	assert.match(result.data.extracted, /Categories: cs\.AI, cs\.CL/);
	assert.equal(result.data.claims?.[0]?.verdict, "insufficient_evidence");
	assert.match(result.data.claims?.[0]?.claim ?? "", /We present a memory system/);
	assert.ok(result.bytesRead > 0);
});

test("URL intake accepts legacy arXiv ids with category paths", async () => {
	const fetcher: typeof fetch = async (input) => {
		assert.equal(inputUrl(input), "https://export.arxiv.org/api/query?id_list=math%2F0309136");
		return responseTyped(
			`<feed><entry><title>Legacy arXiv Paper</title><summary>Legacy ids still resolve.</summary></entry></feed>`,
			"application/atom+xml",
		);
	};
	const lookup = (async () => [{ address: "151.101.65.91", family: 4 }]) as unknown as typeof dnsLookup;

	const result = await readUrlForWorldNote("https://arxiv.org/abs/math/0309136", { fetcher, lookup });

	assert.equal(result.data.sourceType, "paper");
	assert.equal(result.data.sourceUrl, "https://arxiv.org/abs/math/0309136");
	assert.equal(result.data.title, "Legacy arXiv Paper");
});

test("URL intake marks video URLs as transcript-needed stubs without fetching HTML", async () => {
	const fetcher: typeof fetch = async () => {
		throw new Error("video intake should not fetch script-heavy video HTML");
	};
	const lookup = (async () => [{ address: "142.250.72.206", family: 4 }]) as unknown as typeof dnsLookup;

	const result = await readUrlForWorldNote("https://www.youtube.com/watch?v=abc123", { fetcher, lookup });

	assert.equal(result.data.sourceType, "video");
	assert.equal(result.data.memoryStatus, "needs_deep_read");
	assert.match(result.data.coverage, /transcript extraction or browser-native reading/);
	assert.match(result.data.read, /has not read this source yet/);
	assert.equal(result.bytesRead, 0);
});

test("URL intake marks EPUB sources as parser-needed stubs with honest coverage", async () => {
	const fetcher: typeof fetch = async () => responseTyped("epub bytes would be binary", "application/epub+zip");
	const lookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as typeof dnsLookup;

	const result = await readUrlForWorldNote("https://example.com/book.epub", { fetcher, lookup });

	assert.equal(result.data.sourceType, "epub");
	assert.equal(result.data.memoryStatus, "needs_deep_read");
	assert.match(result.data.coverage, /Fetched source but did not parse body text/);
	assert.match(result.data.memoryStatusReason ?? "", /EPUB fetched but not parsed/);
	assert.equal(result.bytesRead, 0);
});

test("URL intake pins fetch to the DNS-validated address", async () => {
	const pinnedAddresses: string[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		assert.equal(inputUrl(input), "https://rebind.test/article");
		pinnedAddresses.push(((init ?? {}) as PinnedFetchInit).dispatcher?.pinnedAddress ?? "");
		return responseText("# Rebind Fixture\n\nFetched through pinned DNS.");
	};
	const lookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as typeof dnsLookup;

	await readUrlForWorldNote("https://rebind.test/article", { fetcher, lookup });

	assert.deepEqual(pinnedAddresses, ["93.184.216.34"]);
});

test("URL intake blocks bracketed IPv4-mapped and reserved private hosts", async () => {
	const fetcher: typeof fetch = async () => {
		throw new Error("private URLs must be blocked before fetch");
	};
	const lookup = (async () => {
		throw new Error("IP literals must be blocked before DNS lookup");
	}) as unknown as typeof dnsLookup;

	for (const url of [
		"http://[::ffff:127.0.0.1]/secret",
		"http://[::ffff:10.0.0.1]/secret",
		"http://0.0.0.0/secret",
		"http://100.64.0.1/secret",
		"http://[::7f00:1]/secret",
		"http://[::a00:1]/secret",
	]) {
		await assert.rejects(() => readUrlForWorldNote(url, { fetcher, lookup }), /blocked private URL host/);
	}
});
