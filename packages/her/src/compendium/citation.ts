import type { Citation, CitationSource } from "./types.ts";

const TIMESTAMP = /(?:^|\b)(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d+)?(?:\b|$)/;

export function resolveCitation(
	sourceId: string,
	locator: string,
	sources: readonly CitationSource[],
): Citation | null {
	const id = sourceId.trim();
	if (!id) return null;
	const source = sources.find((item) => item.id === id);
	if (!source?.sourceUrl.trim()) return null;
	const sourceUrl = source.sourceUrl.trim();
	const trimmedLocator = locator.trim();
	return {
		sourceId: id,
		sourceUrl,
		locator: trimmedLocator,
		href: citationHref(sourceUrl, trimmedLocator),
	};
}

export function citationHref(sourceUrl: string, locator: string): string {
	const seconds = timestampSeconds(locator);
	if (seconds === null) return sourceUrl;
	try {
		const url = new URL(sourceUrl);
		if (!isYouTubeHost(url.hostname.toLowerCase().replace(/\.$/, ""))) return sourceUrl;
		url.searchParams.set("t", String(seconds));
		return url.toString();
	} catch {
		return sourceUrl;
	}
}

function timestampSeconds(locator: string): number | null {
	const match = locator.match(TIMESTAMP);
	if (!match) return null;
	const hours = match[1] !== undefined ? Number(match[1]) : 0;
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	if (![hours, minutes, seconds].every((value) => Number.isInteger(value))) return null;
	if (minutes > 59 || seconds > 59) return null;
	return hours * 3600 + minutes * 60 + seconds;
}

function isYouTubeHost(host: string): boolean {
	return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
}
