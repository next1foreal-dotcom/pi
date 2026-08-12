import { extname } from "node:path";
import type { SourceClassification } from "./types.ts";

const LOCAL_EXTENSIONS = new Set([".epub", ".pdf", ".md", ".txt"]);

function parseHttpUrl(source: string): URL | undefined {
	try {
		const parsed = new URL(source);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function isYouTubeHost(host: string): boolean {
	return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
}

function isXHost(host: string): boolean {
	return host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");
}

function statusId(pathname: string): string | undefined {
	return pathname.match(/(?:^|\/)status\/(\d+)(?:\/|$)/i)?.[1];
}

export function classifySource(source: string): SourceClassification {
	const parsed = parseHttpUrl(source);
	if (parsed) {
		const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
		if (isYouTubeHost(host)) return { kind: "youtube" };
		if (isXHost(host)) {
			const id = statusId(parsed.pathname);
			if (id) return { kind: "tweet", id };
		}
		return { kind: "web" };
	}
	const extension = extname(source).toLowerCase();
	return { kind: "local", extension: LOCAL_EXTENSIONS.has(extension) ? extension : extension || undefined };
}

export function isSupportedLocalExtension(extension: string | undefined): boolean {
	return extension !== undefined && LOCAL_EXTENSIONS.has(extension.toLowerCase());
}
