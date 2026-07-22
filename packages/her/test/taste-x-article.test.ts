import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MockAgent } from "undici";
import {
	deriveXThreadTitle,
	extractJinaReaderTitle,
	fetchXArticleFullText,
	fetchXArticleViaFxtwitter,
	resolveXArticleFullText,
} from "../src/her-core/x-article.ts";

function fakeFetcher(handler: (url: string, init?: Record<string, unknown>) => Response): typeof fetch {
	return (async (input: string | URL, init?: Record<string, unknown>) => handler(String(input), init)) as typeof fetch;
}

const lukaFxtwitterFixture = JSON.parse(
	readFileSync(new URL("./fixtures/luka-fxtwitter.json", import.meta.url), "utf8"),
);

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

test("fetchXArticleFullText builds a ProxyAgent dispatcher via the injected factory when HTTPS_PROXY is set", async () => {
	const tweetUrl = "https://x.com/lukaivanovic/status/2079178687409279303";
	const proxyMarker = { proxy: "marker" };
	const factoryCalls: string[] = [];
	let receivedDispatcher: unknown;
	const fetcher = fakeFetcher((_url, init) => {
		receivedDispatcher = init?.dispatcher;
		return new Response("Title: x\n\nfull text", { status: 200 });
	});

	const result = await fetchXArticleFullText(tweetUrl, {
		env: { HTTPS_PROXY: "http://127.0.0.1:10808" },
		fetcher,
		proxyAgentFactory: async (proxyUrl) => {
			factoryCalls.push(proxyUrl);
			return proxyMarker;
		},
	});

	assert.equal(result.ok, true);
	assert.deepEqual(factoryCalls, ["http://127.0.0.1:10808"]);
	assert.equal(receivedDispatcher, proxyMarker, "the fetch call must receive the factory's dispatcher");
});

test("fetchXArticleFullText makes a direct request (no dispatcher, no factory call) when no proxy env var is set", async () => {
	const tweetUrl = "https://x.com/lukaivanovic/status/2079178687409279303";
	let factoryCalled = false;
	let receivedDispatcher: unknown = "unset";
	const fetcher = fakeFetcher((_url, init) => {
		receivedDispatcher = init?.dispatcher;
		return new Response("Title: x\n\nfull text", { status: 200 });
	});

	const result = await fetchXArticleFullText(tweetUrl, {
		env: {},
		fetcher,
		proxyAgentFactory: async (proxyUrl) => {
			factoryCalled = true;
			return { proxyUrl };
		},
	});

	assert.equal(result.ok, true);
	assert.equal(factoryCalled, false, "no proxy env var means the ProxyAgent factory must never run");
	assert.equal(receivedDispatcher, undefined);
});

test("fetchXArticleFullText works end-to-end through a real undici dispatcher (regression: global fetch is dispatcher-incompatible)", async () => {
	// palate T2fix2 real-fire finding: a dispatcher built by the npm `undici` package (ProxyAgent,
	// and MockAgent here as its network-free stand-in) throws/hangs when handed to Node's global
	// `fetch` — a version mismatch between Node's internally bundled undici and the npm package.
	// This exercises the *default* fetcher path (no `fetcher` option injected) end-to-end through a
	// real undici dispatcher, proving the module picks a dispatcher-compatible fetch by default.
	const tweetUrl = "https://x.com/lukaivanovic/status/2079178687409279303";
	const mockAgent = new MockAgent();
	mockAgent.disableNetConnect();
	mockAgent
		.get("https://r.jina.ai")
		.intercept({ path: /.*/, method: "GET" })
		.reply(200, "Title: How to create your own design tool\n\nfull article body");

	const result = await fetchXArticleFullText(tweetUrl, {
		env: { HTTPS_PROXY: "http://127.0.0.1:0" },
		proxyAgentFactory: async () => mockAgent,
	});
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("unreachable");
	assert.match(result.markdown, /full article body/);
});

test("extractJinaReaderTitle rejects a bare-URL title (x.com login wall stand-in, e.g. a t.co short link)", () => {
	const markdown = [
		"Title: https://t.co/SaQZQxUQau",
		"",
		"URL Source: https://x.com/lukaivanovic/status/2079178687409279303",
		"",
		"Markdown Content:",
		"## Post",
	].join("\n");
	assert.equal(extractJinaReaderTitle(markdown), undefined);
});

test("deriveXThreadTitle falls through to the tweet's first line when the article title is a bare URL", () => {
	const title = deriveXThreadTitle({
		articleTitle: "https://t.co/SaQZQxUQau",
		fallbackTitle: "2079178687409279303",
		tweetText: "How to create your own design tool: a quick guide",
	});
	assert.equal(title, "How to create your own design tool: a quick guide");
});

test("deriveXThreadTitle falls through to the ID fallback when the tweet text is only intake.ts's blocked-URL diagnostic stub (no real tweet text, no article title)", () => {
	// palate T2fix2 real-fire finding (luka URL, defuddle not installed in this environment):
	// x-thread intake degrades to intake.ts's blockedUrlIntake, whose "extracted" text is a
	// diagnostic stub starting with "Requested URL: ...". That stub is not the tweet's own text
	// and must not be mistaken for a human-readable title tier.
	const stubText = [
		"Requested URL: https://x.com/lukaivanovic/status/2079178687409279303",
		"Final URL: https://x.com/lukaivanovic/status/2079178687409279303",
		"Unread reason: X/Twitter sources require browser-native or authenticated reading.",
	].join("\n");
	const title = deriveXThreadTitle({ fallbackTitle: "Unread source: 2079178687409279303", tweetText: stubText });
	assert.equal(title, "Unread source: 2079178687409279303");
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

test("deriveXThreadTitle skips a leading avatar-image markdown line (real-fire finding, luka URL: defuddle's raw markdown leads with the tweet author's avatar image link, not human text)", () => {
	const tweetText = [
		"[![user avatar](https://pbs.twimg.com/profile_images/000/avatar.jpg)](https://x.com/lukaivanovic)",
		"",
		"How to create your own design tool: a quick guide",
	].join("\n");
	const title = deriveXThreadTitle({ fallbackTitle: "2079178687409279303", tweetText });
	assert.equal(title, "How to create your own design tool: a quick guide");
});

// palate G-79: fxtwitter (api.fxtwitter.com) is a key-free, cookie-free, login-free JSON mirror for
// x-status lookups. Article-type tweets carry their linked long-form piece's full text as a
// Draft.js-shaped block array (`tweet.article.content.blocks`/`entityMap`) instead of scraped
// markdown, so it is now tried before the r.jina.ai reader-proxy channel.

test("fetchXArticleViaFxtwitter rebuilds the luka fixture's full article markdown with all chapters and embedded prompts", async () => {
	const fetcher = fakeFetcher((url) => {
		assert.equal(url, "https://api.fxtwitter.com/status/2079178687409279303");
		return new Response(JSON.stringify(lukaFxtwitterFixture), { status: 200 });
	});

	const result = await fetchXArticleViaFxtwitter("https://x.com/lukaivanovic/status/2079178687409279303", {
		fetcher,
	});
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("unreachable");
	assert.equal(result.articleTitle, "How to create your own design tool");
	assert.equal(result.channel, "fxtwitter");
	for (const heading of [
		"Chapter 1: Getting your layers",
		"Chapter 2: Provide context",
		"Chapter 3: Create your artboards",
		"Chapter 4: Go wild",
		"Additional: Editing and exporting videos",
	]) {
		assert.match(result.markdown, new RegExp(`## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	}
	assert.match(result.markdown, /Write a CLI script \(e\.g\. pnpm design:extract route/);
});

test("fetchXArticleViaFxtwitter degrades when fxtwitter's code is not 200", async () => {
	const fetcher = fakeFetcher(() => new Response(JSON.stringify({ code: 404 }), { status: 200 }));
	const result = await fetchXArticleViaFxtwitter("https://x.com/someone/status/1", { fetcher });
	assert.equal(result.ok, false);
});

test("fetchXArticleViaFxtwitter falls back to the tweet's own text when there is no article", async () => {
	const fetcher = fakeFetcher(
		() =>
			new Response(JSON.stringify({ code: 200, tweet: { text: "just a normal tweet, no article" } }), {
				status: 200,
			}),
	);
	const result = await fetchXArticleViaFxtwitter("https://x.com/someone/status/2", { fetcher });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("unreachable");
	assert.equal(result.markdown, "just a normal tweet, no article");
	assert.equal(result.articleTitle, undefined);
});

test("fetchXArticleViaFxtwitter skips an atomic block whose entity has no markdown (e.g. a media/image entity) instead of crashing", async () => {
	const body = {
		code: 200,
		tweet: {
			article: {
				content: {
					blocks: [
						{ entityRanges: [], text: "before the image", type: "unstyled" },
						{ entityRanges: [{ key: 0, length: 1, offset: 0 }], text: " ", type: "atomic" },
						{ entityRanges: [], text: "after the image", type: "unstyled" },
					],
					entityMap: [{ key: "0", value: { data: { mediaItems: [] }, mutability: "Immutable", type: "MEDIA" } }],
				},
				title: "Piece with an image",
			},
		},
	};
	const fetcher = fakeFetcher(() => new Response(JSON.stringify(body), { status: 200 }));
	const result = await fetchXArticleViaFxtwitter("https://x.com/someone/status/3", { fetcher });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("unreachable");
	assert.equal(result.markdown, "before the image\n\nafter the image");
});

test("fetchXArticleViaFxtwitter fails gracefully when no status id can be extracted from the URL", async () => {
	let fetcherCalled = false;
	const fetcher = fakeFetcher(() => {
		fetcherCalled = true;
		return new Response("should never be reached", { status: 200 });
	});
	const result = await fetchXArticleViaFxtwitter("https://example.com/not-a-tweet", { fetcher });
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("unreachable");
	assert.match(result.warning, /status id/);
	assert.equal(fetcherCalled, false);
});

test("resolveXArticleFullText falls back to the r.jina.ai reader-proxy channel when fxtwitter misses", async () => {
	let fxtwitterCalled = false;
	let jinaCalled = false;
	const fxtwitterFetcher = fakeFetcher(() => {
		fxtwitterCalled = true;
		return new Response(JSON.stringify({ code: 404 }), { status: 200 });
	});
	const jinaFetcher = fakeFetcher((url) => {
		jinaCalled = true;
		assert.match(url, /^https:\/\/r\.jina\.ai\//);
		return new Response("Title: fallback\n\nfull text via reader proxy", { status: 200 });
	});

	const result = await resolveXArticleFullText("https://x.com/someone/status/4", {
		fetcher: jinaFetcher,
		fxtwitterFetcher,
	});
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("unreachable");
	assert.equal(fxtwitterCalled, true);
	assert.equal(jinaCalled, true);
	assert.equal(result.channel, "reader-proxy");
	assert.match(result.markdown, /full text via reader proxy/);
});

test("resolveXArticleFullText returns the fxtwitter result directly and never calls the jina fallback on a hit", async () => {
	let jinaCalled = false;
	const fxtwitterFetcher = fakeFetcher(
		() => new Response(JSON.stringify({ code: 200, tweet: { text: "hit on the first channel" } }), { status: 200 }),
	);
	const jinaFetcher = fakeFetcher(() => {
		jinaCalled = true;
		return new Response("should never be reached", { status: 200 });
	});

	const result = await resolveXArticleFullText("https://x.com/someone/status/5", {
		fetcher: jinaFetcher,
		fxtwitterFetcher,
	});
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("unreachable");
	assert.equal(result.channel, "fxtwitter");
	assert.equal(jinaCalled, false);
});
