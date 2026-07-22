import { ProxyAgent, fetch as undiciFetch } from "undici";
import { assertPubliclyFetchableUrl, type UrlIntakeOptions } from "./intake.ts";

/**
 * palate T2fix2 (AC-2): x-thread intake only ever captured the tweet's own text plus whatever
 * defuddle's article intro grabbed — an article-type tweet's linked long-form piece (e.g. "How to
 * create your own design tool") never made it into the taste card. This module fetches that
 * article's full text through r.jina.ai's Reader proxy (already relied on locally by the
 * twitter-reader skill) and degrades to the caller's existing tweet-only text on any failure.
 *
 * palate T2fix2 (proxy ruling): the reader-proxy host itself (r.jina.ai) is a hardcoded, trusted
 * constant — the only attacker-influenceable part is the tweet URL path suffix, which is validated
 * by assertPubliclyFetchableUrl before it is ever concatenated in. Because the host is fixed and
 * trusted, intake.ts's DNS-pinning anti-SSRF model (built for arbitrary, user-supplied hosts)
 * doesn't apply here, so this module makes its own direct (optionally proxied) request instead of
 * routing through intake.ts's shared fetchUrlSafely/fetchWithSafeRedirects — those stay untouched;
 * adding proxy support to that shared, arbitrary-host path is a separate, larger architecture
 * decision this fix does not make.
 */

const DEFAULT_JINA_READER_BASE = "https://r.jina.ai/";
const DEFAULT_MAX_BYTES = 250_000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const JINA_TITLE_LINE = /^Title:\s*(.+)$/m;

/** Builds an undici ProxyAgent for `proxyUrl`; a separate module-level indirection so tests can inject a fake. */
async function defaultProxyAgentFactory(proxyUrl: string): Promise<unknown> {
	return new ProxyAgent(proxyUrl);
}

/** Reads the standard HTTPS_PROXY/HTTP_PROXY (and lowercase) env vars; undefined means "connect directly". */
function resolveProxyUrl(env: NodeJS.ProcessEnv): string | undefined {
	return (
		env.HTTPS_PROXY?.trim() ||
		env.https_proxy?.trim() ||
		env.HTTP_PROXY?.trim() ||
		env.http_proxy?.trim() ||
		undefined
	);
}

export interface XArticleFullTextOptions {
	allowLocal?: boolean;
	/** defaults to process.env; only read for HTTPS_PROXY/HTTP_PROXY proxy selection. */
	env?: NodeJS.ProcessEnv;
	fetcher?: typeof fetch;
	lookup?: UrlIntakeOptions["lookup"];
	maxBytes?: number;
	/** test hook; defaults to constructing a real undici ProxyAgent. */
	proxyAgentFactory?: (proxyUrl: string) => Promise<unknown>;
	/** test hook; defaults to the real r.jina.ai Reader prefix. */
	readerBaseUrl?: string;
}

export interface XArticleFullTextResult {
	/** the linked article's own title (fxtwitter channel only; the r.jina.ai channel has no equivalent). */
	articleTitle?: string;
	bytesRead: number;
	/** palate G-79: which full-text channel produced this result, for coverage-text/diagnostics. */
	channel?: "fxtwitter" | "reader-proxy";
	markdown: string;
	ok: true;
}

export interface XArticleFullTextFailure {
	ok: false;
	warning: string;
}

/** Fetches `tweetUrl`'s full article text via a reader proxy; never throws. */
export async function fetchXArticleFullText(
	tweetUrl: string,
	opts: XArticleFullTextOptions = {},
): Promise<XArticleFullTextResult | XArticleFullTextFailure> {
	try {
		// The tweet URL is validated on its own (not just the proxy host) before it is concatenated
		// into the reader-proxy URL, per the T2 path-traversal-style SSRF contract.
		const validated = await assertPubliclyFetchableUrl(tweetUrl, {
			allowLocal: opts.allowLocal,
			lookup: opts.lookup,
		});
		const readerBase = opts.readerBaseUrl ?? DEFAULT_JINA_READER_BASE;
		const readerRequestUrl = `${readerBase}${validated.href}`;

		const env = opts.env ?? process.env;
		const httpProxyUrl = resolveProxyUrl(env);
		const dispatcher = httpProxyUrl
			? await (opts.proxyAgentFactory ?? defaultProxyAgentFactory)(httpProxyUrl)
			: undefined;

		// palate T2fix2 (real-fire finding): a dispatcher built by the npm `undici` package is not
		// compatible with Node's global `fetch` (it uses its own, differently-versioned bundled
		// undici internally) — passing one throws/hangs with an "invalid onRequestStart method"
		// error. Always default to undici's own `fetch` export, which is dispatcher-compatible
		// whether or not a proxy is actually configured, instead of the ambient global `fetch`.
		const fetcher = (opts.fetcher ?? undiciFetch) as (
			url: string,
			init: Record<string, unknown>,
		) => Promise<Response>;
		const response = await fetcher(readerRequestUrl, {
			signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
			...(dispatcher ? { dispatcher } : {}),
		});
		if (!response.ok) {
			return { ok: false, warning: `x-article full-text proxy returned HTTP ${response.status} for ${tweetUrl}` };
		}
		const text = (await response.text()).trim();
		if (!text) return { ok: false, warning: `x-article full-text proxy returned no content for ${tweetUrl}` };
		const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
		const bytes = Buffer.from(text, "utf8");
		const markdown = bytes.byteLength > maxBytes ? bytes.subarray(0, maxBytes).toString("utf8") : text;
		return { bytesRead: Buffer.byteLength(markdown, "utf8"), channel: "reader-proxy", markdown, ok: true };
	} catch (error) {
		return {
			ok: false,
			warning: `x-article full-text fetch failed for ${tweetUrl}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

const STATUS_ID_PATTERN = /\/status\/(\d+)/;
const DEFAULT_FXTWITTER_BASE_URL = "https://api.fxtwitter.com/status/";
const DEFAULT_FXTWITTER_TIMEOUT_MS = 15_000;

interface FxtwitterEntityMapItem {
	key: string;
	value: { data?: { markdown?: string } };
}

interface FxtwitterArticleBlock {
	entityRanges: Array<{ key: number }>;
	text: string;
	type: string;
}

interface FxtwitterResponseBody {
	code: number;
	tweet?: {
		article?: {
			content?: { blocks?: FxtwitterArticleBlock[]; entityMap?: FxtwitterEntityMapItem[] };
			title?: string;
		};
		text?: string;
	};
}

export interface XArticleFxtwitterOptions {
	/** test hook; defaults to the real fxtwitter status-lookup prefix. */
	baseUrl?: string;
	fetcher?: typeof fetch;
}

/**
 * palate G-79: rebuilds an fxtwitter article's ordered Draft.js-shaped content blocks (plus the
 * embedded prompt/code entities `atomic` blocks point at) into one markdown string. An atomic block
 * whose entity has no `data.markdown` (e.g. an image/video MEDIA entity, or a DIVIDER) contributes
 * nothing — it is skipped, not stubbed with a placeholder.
 */
function renderFxtwitterArticleMarkdown(blocks: FxtwitterArticleBlock[], entityMap: FxtwitterEntityMapItem[]): string {
	const entityByKey = new Map(entityMap.map((item) => [item.key, item]));
	const parts: string[] = [];
	let orderedListIndex = 0;
	for (const block of blocks) {
		if (block.type !== "ordered-list-item") orderedListIndex = 0;
		if (block.type === "unstyled") parts.push(block.text);
		else if (block.type === "header-one") parts.push(`# ${block.text}`);
		else if (block.type === "header-two") parts.push(`## ${block.text}`);
		else if (block.type === "header-three") parts.push(`### ${block.text}`);
		else if (block.type === "ordered-list-item") parts.push(`${++orderedListIndex}. ${block.text}`);
		else if (block.type === "unordered-list-item") parts.push(`- ${block.text}`);
		else if (block.type === "atomic") {
			const key = block.entityRanges[0]?.key;
			const markdown = key === undefined ? undefined : entityByKey.get(String(key))?.value?.data?.markdown;
			if (markdown) parts.push(markdown);
		}
	}
	return parts.join("\n\n").trim();
}

/**
 * palate G-79: fetches an x-status's linked long-form article (or, absent one, the tweet's own
 * text) via fxtwitter's key-free, cookie-free, login-free JSON mirror (`api.fxtwitter.com`) — a
 * fixed, trusted host constant, same SSRF posture as r.jina.ai above (only the numeric status id,
 * validated by STATUS_ID_PATTERN, is attacker-influenceable). Never throws.
 */
export async function fetchXArticleViaFxtwitter(
	tweetUrl: string,
	opts: XArticleFxtwitterOptions = {},
): Promise<XArticleFullTextResult | XArticleFullTextFailure> {
	const statusMatch = STATUS_ID_PATTERN.exec(tweetUrl);
	if (!statusMatch) return { ok: false, warning: `fxtwitter: could not find a status id in ${tweetUrl}` };
	try {
		const requestUrl = `${opts.baseUrl ?? DEFAULT_FXTWITTER_BASE_URL}${statusMatch[1]}`;
		const fetcher = (opts.fetcher ?? undiciFetch) as (
			url: string,
			init: Record<string, unknown>,
		) => Promise<Response>;
		const response = await fetcher(requestUrl, { signal: AbortSignal.timeout(DEFAULT_FXTWITTER_TIMEOUT_MS) });
		if (!response.ok) return { ok: false, warning: `fxtwitter returned HTTP ${response.status} for ${tweetUrl}` };
		const body = (await response.json()) as FxtwitterResponseBody;
		if (body.code !== 200 || !body.tweet) {
			return { ok: false, warning: `fxtwitter returned code ${body.code} (no tweet) for ${tweetUrl}` };
		}
		const blocks = body.tweet.article?.content?.blocks;
		if (blocks?.length) {
			const markdown = renderFxtwitterArticleMarkdown(blocks, body.tweet.article?.content?.entityMap ?? []);
			if (markdown) {
				return {
					articleTitle: body.tweet.article?.title?.trim() || undefined,
					bytesRead: Buffer.byteLength(markdown, "utf8"),
					channel: "fxtwitter",
					markdown,
					ok: true,
				};
			}
		}
		const tweetText = body.tweet.text?.trim();
		if (tweetText) {
			return {
				bytesRead: Buffer.byteLength(tweetText, "utf8"),
				channel: "fxtwitter",
				markdown: tweetText,
				ok: true,
			};
		}
		return { ok: false, warning: `fxtwitter: tweet ${tweetUrl} has no article and no text` };
	} catch (error) {
		return {
			ok: false,
			warning: `fxtwitter fetch failed for ${tweetUrl}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export interface ResolveXArticleFullTextOptions extends XArticleFullTextOptions {
	/** test hook; defaults to the real fxtwitter status-lookup prefix. */
	fxtwitterBaseUrl?: string;
	/** test hook; kept separate from `fetcher` (the r.jina.ai fallback's fetcher) so both channels
	 * can be mocked independently. Defaults to the real undici fetch. */
	fxtwitterFetcher?: typeof fetch;
}

/**
 * palate G-79 (channel order): tries the key-free fxtwitter channel first; on any miss (bad/missing
 * status id, non-200, no article and no tweet text) falls back to the existing r.jina.ai
 * reader-proxy channel (fetchXArticleFullText, unchanged). This is the function cli.ts's
 * enhanceXThreadTasteData now calls instead of fetchXArticleFullText directly.
 */
export async function resolveXArticleFullText(
	tweetUrl: string,
	opts: ResolveXArticleFullTextOptions = {},
): Promise<XArticleFullTextResult | XArticleFullTextFailure> {
	const viaFxtwitter = await fetchXArticleViaFxtwitter(tweetUrl, {
		baseUrl: opts.fxtwitterBaseUrl,
		fetcher: opts.fxtwitterFetcher,
	});
	if (viaFxtwitter.ok) return viaFxtwitter;
	return fetchXArticleFullText(tweetUrl, opts);
}

const BARE_URL = /^https?:\/\//i;

/**
 * Extracts a Jina Reader response's leading "Title: ..." line, if present and human-readable.
 * palate T2fix2 (real-fire finding, luka URL): x.com's login wall means Jina's anonymous fetch
 * sometimes only sees a t.co short-link stand-in for the page's real title (e.g.
 * "Title: https://t.co/SaQZQxUQau") — a bare URL is not the "人话" title contract §4 requires, so
 * it is treated the same as no title at all and the caller falls through to the next tier.
 */
export function extractJinaReaderTitle(markdown: string): string | undefined {
	const match = JINA_TITLE_LINE.exec(markdown)?.[1]?.trim();
	if (!match || BARE_URL.test(match)) return undefined;
	return match;
}

export interface XThreadTitleInput {
	/** the linked article's own title, if a full-text fetch succeeded and one was found. */
	articleTitle?: string;
	/** the existing title Her would otherwise fall back to (may be a naked status ID). */
	fallbackTitle: string;
	/** the tweet's own text, as read by the existing defuddle/blocked-stub channel. */
	tweetText: string;
}

const TWEET_FIRST_LINE_MAX_CHARS = 80;
// Matches intake.ts's blockedUrlIntake/failedUrlIntake diagnostic stub's first line — not real
// tweet text, so it must not be mistaken for a human-readable title tier (real-fire finding, luka
// URL: defuddle isn't installed in every environment, so x-thread reads often degrade to this stub).
const DIAGNOSTIC_STUB_LINE = /^Requested URL:/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const MARKDOWN_LINE_PREFIX = /^(#+\s+|>\s+|[*-]\s+)/;

/**
 * palate T2fix3 (real-fire finding, luka URL): defuddle's raw markdown output leads with the
 * tweet author's avatar image link (e.g. `[![user avatar](https://pbs.twimg.com/...)](https://x.com/...)`),
 * not human-readable text. Tier-2 title derivation must read *plain text* lines, not raw markdown
 * source, or that image/link syntax itself becomes the title. This strips markdown image syntax
 * entirely (no alt-text fallback — an avatar's alt text is not article content either), reduces
 * links to their anchor text, strips heading/quote/list-item prefixes, and drops now-empty lines.
 */
function stripMarkdownToPlainLines(markdown: string): string[] {
	return markdown
		.replace(MARKDOWN_IMAGE, "")
		.replace(MARKDOWN_LINK, "$1")
		.split("\n")
		.map((line) => line.replace(MARKDOWN_LINE_PREFIX, "").trim())
		.filter(Boolean);
}

/**
 * palate T2fix2 (contract §4): an x-status taste card's title must never be a naked numeric
 * status ID. Priority: the linked article's own title, then the tweet's first non-empty line
 * (truncated to 80 chars), then whatever title the caller already had (its last-resort fallback).
 */
export function deriveXThreadTitle(input: XThreadTitleInput): string {
	const articleTitle = input.articleTitle?.trim();
	if (articleTitle && !BARE_URL.test(articleTitle)) return articleTitle;
	const firstLine = stripMarkdownToPlainLines(input.tweetText).find(Boolean);
	if (firstLine && !DIAGNOSTIC_STUB_LINE.test(firstLine)) return firstLine.slice(0, TWEET_FIRST_LINE_MAX_CHARS);
	return input.fallbackTitle;
}
