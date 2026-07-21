import assert from "node:assert/strict";
import test from "node:test";
import { deriveXThreadTitle, extractJinaReaderTitle, fetchXArticleFullText } from "../src/her-core/x-article.ts";

function fakeFetcher(handler: (url: string) => Response): typeof fetch {
	return (async (input: string | URL) => handler(String(input))) as typeof fetch;
}

test("fetchXArticleFullText fetches the linked article's full text through the reader proxy", async () => {
	const tweetUrl = "https://x.com/lukaivanovic/status/2079178687409279303";
	const jinaMarkdown = [
		"Title: How to create your own design tool",
		"",
		"URL Source: https://example.com/design-tool-article",
		"",
		"Markdown Content:",
		"Long-form article body far beyond the tweet's own text.",
	].join("\n");
	const fetcher = fakeFetcher((url) => {
		assert.equal(url, `https://r.jina.ai/${tweetUrl}`);
		return new Response(jinaMarkdown, { status: 200 });
	});

	const result = await fetchXArticleFullText(tweetUrl, { fetcher });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("unreachable");
	assert.match(result.markdown, /Long-form article body/);
	assert.equal(result.bytesRead, Buffer.byteLength(jinaMarkdown, "utf8"));
	assert.equal(extractJinaReaderTitle(result.markdown), "How to create your own design tool");
});

test("fetchXArticleFullText rejects a tweet URL that fails the SSRF gate before it is ever concatenated into the proxy URL", async () => {
	let fetcherCalled = false;
	const fetcher = fakeFetcher(() => {
		fetcherCalled = true;
		return new Response("should never be reached", { status: 200 });
	});

	const result = await fetchXArticleFullText("http://127.0.0.1/status/1", { fetcher });
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("unreachable");
	assert.match(result.warning, /blocked (private|local) URL host/);
	assert.equal(fetcherCalled, false, "the reader proxy must never be called for an unsafe source URL");
});

test("fetchXArticleFullText degrades to a warning when the reader proxy returns a non-OK response", async () => {
	const tweetUrl = "https://x.com/someone/status/999";
	const fetcher = fakeFetcher(() => new Response("rate limited", { status: 429 }));
	const result = await fetchXArticleFullText(tweetUrl, { fetcher });
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("unreachable");
	assert.match(result.warning, /HTTP 429/);
});

test("deriveXThreadTitle prefers the linked article's title over the tweet text and the ID fallback", () => {
	const title = deriveXThreadTitle({
		articleTitle: "How to create your own design tool",
		fallbackTitle: "2079178687409279303",
		tweetText: "check out my new post on design tools",
	});
	assert.equal(title, "How to create your own design tool");
});

test("deriveXThreadTitle falls back to the tweet's first line (max 80 chars) when there is no article title", () => {
	const longLine = "a".repeat(120);
	const title = deriveXThreadTitle({
		fallbackTitle: "2079178687409279303",
		tweetText: `${longLine}\nsecond line`,
	});
	assert.equal(title, "a".repeat(80));
});

test("deriveXThreadTitle falls back to the caller's existing title when the tweet text is empty", () => {
	const title = deriveXThreadTitle({ fallbackTitle: "2079178687409279303", tweetText: "   \n  " });
	assert.equal(title, "2079178687409279303");
});
