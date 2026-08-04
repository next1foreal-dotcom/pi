/**
 * G-128 / mechanism D.2 — when a published page ≥ inline_threshold_bytes,
 * lift large data: URIs into published/assets/<sha16>.<ext> (content-addressed).
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_URI_RE = /src=(["'])data:([^;]+);base64,([A-Za-z0-9+/=\s]+)\1/gi;

const EXT_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"font/woff": "woff",
	"font/woff2": "woff2",
	"application/octet-stream": "bin",
};

export type ExternalizeResult = {
	html: string;
	assets: string[]; // relative paths under published/, e.g. assets/abcd….png
	rewrote: number;
};

export async function externalizeLargeDataUris(
	html: string,
	publishedRoot: string,
	inlineThresholdBytes: number,
): Promise<ExternalizeResult> {
	const bytes = Buffer.byteLength(html, "utf8");
	if (bytes < inlineThresholdBytes) {
		return { html, assets: [], rewrote: 0 };
	}

	await mkdir(join(publishedRoot, "assets"), { recursive: true });

	const written = new Map<string, string>();
	const assets: string[] = [];
	const writes: Promise<void>[] = [];
	let rewrote = 0;

	const next = html.replace(DATA_URI_RE, (match, quote: string, mimeRaw: string, b64raw: string) => {
		const mime = mimeRaw.trim().toLowerCase();
		const b64 = b64raw.replace(/\s+/g, "");
		let buf: Buffer;
		try {
			buf = Buffer.from(b64, "base64");
		} catch {
			return match;
		}
		if (buf.length === 0) return match;

		const sha16 = createHash("sha256").update(buf).digest("hex").slice(0, 16);
		let rel = written.get(sha16);
		if (!rel) {
			const ext = EXT_BY_MIME[mime] ?? "bin";
			rel = `assets/${sha16}.${ext}`;
			written.set(sha16, rel);
			assets.push(rel);
			writes.push(writeFile(join(publishedRoot, rel), buf));
		}
		rewrote += 1;
		return `src=${quote}${rel}${quote}`;
	});

	await Promise.all(writes);
	return { html: next, assets, rewrote };
}
