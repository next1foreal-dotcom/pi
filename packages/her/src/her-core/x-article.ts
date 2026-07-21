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
	bytesRead: number;
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
		return { bytesRead: Buffer.byteLength(markdown, "utf8"), markdown, ok: true };
	} catch (error) {
		return {
			ok: false,
			warning: `x-article full-text fetch failed for ${tweetUrl}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
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
