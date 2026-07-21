import { assertPubliclyFetchableUrl, fetchUrlSafely, type UrlIntakeOptions } from "./intake.ts";

/**
 * palate T2fix2 (AC-2): x-thread intake only ever captured the tweet's own text plus whatever
 * defuddle's article intro grabbed — an article-type tweet's linked long-form piece (e.g. "How to
 * create your own design tool") never made it into the taste card. This module fetches that
 * article's full text through r.jina.ai's Reader proxy (already relied on locally by the
 * twitter-reader skill) and degrades to the caller's existing tweet-only text on any failure.
 */

const DEFAULT_JINA_READER_BASE = "https://r.jina.ai/";
const DEFAULT_MAX_BYTES = 250_000;
const JINA_TITLE_LINE = /^Title:\s*(.+)$/m;

export interface XArticleFullTextOptions {
	allowLocal?: boolean;
	fetcher?: typeof fetch;
	lookup?: UrlIntakeOptions["lookup"];
	maxBytes?: number;
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
	const intakeOpts: Pick<UrlIntakeOptions, "allowLocal" | "fetcher" | "lookup"> = {
		allowLocal: opts.allowLocal,
		fetcher: opts.fetcher,
		lookup: opts.lookup,
	};
	try {
		// The tweet URL is validated on its own (not just the proxy host) before it is concatenated
		// into the reader-proxy URL, per the T2 path-traversal-style SSRF contract.
		const validated = await assertPubliclyFetchableUrl(tweetUrl, intakeOpts);
		const readerBase = opts.readerBaseUrl ?? DEFAULT_JINA_READER_BASE;
		const proxyUrl = `${readerBase}${validated.href}`;
		const response = await fetchUrlSafely(proxyUrl, intakeOpts);
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

/** Extracts a Jina Reader response's leading "Title: ..." line, if present. */
export function extractJinaReaderTitle(markdown: string): string | undefined {
	const match = JINA_TITLE_LINE.exec(markdown)?.[1]?.trim();
	return match ? match : undefined;
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

/**
 * palate T2fix2 (contract §4): an x-status taste card's title must never be a naked numeric
 * status ID. Priority: the linked article's own title, then the tweet's first non-empty line
 * (truncated to 80 chars), then whatever title the caller already had (its last-resort fallback).
 */
export function deriveXThreadTitle(input: XThreadTitleInput): string {
	if (input.articleTitle?.trim()) return input.articleTitle.trim();
	const firstLine = input.tweetText
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	if (firstLine) return firstLine.slice(0, TWEET_FIRST_LINE_MAX_CHARS);
	return input.fallbackTitle;
}
