import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { WorldNoteData } from "./memory.ts";

export interface UrlIntakeOptions {
	allowLocal?: boolean;
	fetcher?: typeof fetch;
	lookup?: typeof dnsLookup;
	maxBytes?: number;
}

export interface UrlIntakeResult {
	data: WorldNoteData;
	bytesRead: number;
	finalUrl: string;
	truncated: boolean;
}

const DEFAULT_MAX_BYTES = 250_000;
const MAX_REDIRECTS = 3;

export async function readUrlForWorldNote(sourceUrl: string, opts: UrlIntakeOptions = {}): Promise<UrlIntakeResult> {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const fetcher = opts.fetcher ?? fetch;
	const lookup = opts.lookup ?? dnsLookup;
	const startUrl = normalizeSourceUrl(sourceUrl);
	await assertSafeHttpUrl(startUrl, { allowLocal: opts.allowLocal, lookup });
	const response = await fetchWithSafeRedirects(startUrl, { allowLocal: opts.allowLocal, fetcher, lookup });
	const contentType = response.headers.get("content-type") ?? "";
	const finalUrl = response.url || startUrl.href;
	const sourceType = detectSourceType(finalUrl, contentType);

	if (!response.ok) {
		return failedUrlIntake(startUrl.href, finalUrl, sourceType, `HTTP ${response.status}`, maxBytes);
	}

	if (sourceType === "pdf") {
		return unreadableUrlIntake(
			startUrl.href,
			finalUrl,
			sourceType,
			"PDF fetched but not parsed by the minimal URL intake.",
			maxBytes,
		);
	}

	const { text, bytesRead, truncated } = await readResponseText(response, maxBytes);
	const extracted = normalizeExtractedText(sourceType === "article" ? stripHtml(text) : text);
	const title = extractTitle(text) ?? titleFromUrl(finalUrl);
	const memoryStatus = truncated || extracted.length === 0 ? "needs_deep_read" : "active";
	const memoryStatusReason = truncated
		? `Fetched text exceeded ${maxBytes} bytes; saved only the first chunk for orientation.`
		: extracted.length === 0
			? "Fetched source did not yield readable text in the minimal URL intake."
			: undefined;
	const coverage = truncated
		? `Orientation only: read first ${bytesRead} bytes from ${finalUrl}; source needs deep read.`
		: `Read full fetched ${sourceType} text from ${finalUrl}; ${bytesRead} bytes read; content-type: ${contentType || "unknown"}.`;
	const take =
		memoryStatus === "active"
			? "Saved through the minimal URL intake so Samantha can recall and connect this source later."
			: "Saved as a source stub because this needs a deeper reader before strong claims are made.";
	const data: WorldNoteData = {
		title,
		sourceUrl: finalUrl,
		sourceType,
		contentHash: intakeContentHash(finalUrl, extracted || coverage),
		memoryStatus,
		...(memoryStatusReason ? { memoryStatusReason } : {}),
		extracted: extracted || "(no readable text extracted)",
		coverage,
		read:
			memoryStatus === "active"
				? `Samantha read the fetched source text and preserved it as evidence for later synthesis.`
				: "Samantha only has an orientation stub for this source.",
		steal: [],
		connections: [],
		take,
		possibleMoves:
			memoryStatus === "active"
				? ["Connect this source to related topics during topic-map or idea maintenance."]
				: ["Run /her-intake or deep-reader on this source for full coverage."],
	};
	return { data, bytesRead, finalUrl, truncated };
}

export function failedUrlIntake(
	requestedUrl: string,
	finalUrl: string,
	sourceType: string,
	reason: string,
	maxBytes = DEFAULT_MAX_BYTES,
): UrlIntakeResult {
	const coverage = `Fetch failed before source text could be read: ${reason}`;
	const extracted = `Requested URL: ${requestedUrl}\nFinal URL: ${finalUrl}\nFailure: ${reason}`;
	return {
		data: {
			title: `Unfetched source: ${titleFromUrl(finalUrl || requestedUrl)}`,
			sourceUrl: finalUrl || requestedUrl,
			sourceType,
			contentHash: intakeContentHash(finalUrl || requestedUrl, extracted),
			memoryStatus: "needs_deep_read",
			memoryStatusReason: coverage,
			extracted,
			coverage,
			read: "Samantha could not fetch this source yet.",
			steal: [],
			connections: [],
			take: "Keep this stub so the intent to read the source is not lost.",
			possibleMoves: ["Retry with browser-native, web-access, or a logged-in/deeper reader."],
		},
		bytesRead: 0,
		finalUrl,
		truncated: maxBytes <= 0,
	};
}

async function fetchWithSafeRedirects(
	url: URL,
	opts: Required<Pick<UrlIntakeOptions, "fetcher" | "lookup">> & Pick<UrlIntakeOptions, "allowLocal">,
): Promise<Response> {
	let current = url;
	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
		const response = await opts.fetcher(current, { redirect: "manual" });
		const isRedirect = response.status >= 300 && response.status < 400;
		const location = response.headers.get("location");
		if (!isRedirect || !location) return response;
		current = new URL(location, current);
		await assertSafeHttpUrl(current, opts);
	}
	throw new Error(`too many redirects after ${MAX_REDIRECTS}`);
}

async function assertSafeHttpUrl(url: URL, opts: Pick<UrlIntakeOptions, "allowLocal" | "lookup">): Promise<void> {
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error(`unsupported URL protocol: ${url.protocol}`);
	if (url.username || url.password) throw new Error("URLs with embedded credentials are not accepted");
	if (opts.allowLocal) return;
	if (isLocalHostname(url.hostname)) throw new Error(`blocked local URL host: ${url.hostname}`);
	if (isPrivateIp(url.hostname)) throw new Error(`blocked private URL host: ${url.hostname}`);
	const addresses = await (opts.lookup ?? dnsLookup)(url.hostname, { all: true }).catch((error) => {
		throw new Error(
			`DNS lookup failed for ${url.hostname}: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
	for (const address of addresses) {
		if (isPrivateIp(address.address)) throw new Error(`blocked private resolved address: ${address.address}`);
	}
}

async function readResponseText(
	response: Response,
	maxBytes: number,
): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) return { text: await response.text(), bytesRead: 0, truncated: false };
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		const remaining = maxBytes - bytesRead;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
		chunks.push(chunk);
		bytesRead += chunk.byteLength;
		if (value.byteLength > remaining) {
			truncated = true;
			break;
		}
	}
	return { text: Buffer.concat(chunks, bytesRead).toString("utf8"), bytesRead, truncated };
}

function normalizeSourceUrl(sourceUrl: string): URL {
	const trimmed = sourceUrl.trim();
	if (!trimmed) throw new Error("intake-url requires a non-empty URL");
	return new URL(/^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed);
}

function detectSourceType(url: string, contentType: string): string {
	const lowerUrl = url.toLowerCase();
	const lowerType = contentType.toLowerCase();
	if (lowerUrl.endsWith(".pdf") || lowerType.includes("application/pdf")) return "pdf";
	if (lowerType.includes("text/html")) return "article";
	if (lowerType.includes("text/plain") || lowerType.includes("text/markdown")) return "text";
	return "article";
}

function stripHtml(html: string): string {
	const title = extractTitle(html);
	const body = html
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|header|footer|li|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	return normalizeExtractedText([title ? `# ${title}` : "", decodeHtmlEntities(body)].filter(Boolean).join("\n\n"));
}

function extractTitle(text: string): string | undefined {
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? /^#\s+(.+)$/m.exec(text)?.[1];
	return title ? normalizeExtractedText(decodeHtmlEntities(title)).slice(0, 120) : undefined;
}

function normalizeExtractedText(text: string): string {
	return decodeHtmlEntities(text)
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}

function titleFromUrl(url: string): string {
	const parsed = new URL(url);
	const stem = parsed.pathname.split("/").filter(Boolean).at(-1) ?? parsed.hostname;
	return stem.replace(/\.[A-Za-z0-9]+$/, "").replace(/[-_]+/g, " ") || parsed.hostname;
}

function intakeContentHash(sourceUrl: string, extracted: string): string {
	return createHash("sha256").update(`${sourceUrl}\n${extracted}`).digest("hex");
}

function unreadableUrlIntake(
	requestedUrl: string,
	finalUrl: string,
	sourceType: string,
	reason: string,
	maxBytes: number,
): UrlIntakeResult {
	return failedUrlIntake(requestedUrl, finalUrl, sourceType, reason, maxBytes);
}

function isLocalHostname(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	return lower === "localhost" || lower.endsWith(".localhost");
}

function isPrivateIp(hostname: string): boolean {
	const version = isIP(hostname);
	if (version === 4) {
		const parts = hostname.split(".").map((part) => Number(part));
		return (
			parts[0] === 10 ||
			parts[0] === 127 ||
			(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
			(parts[0] === 192 && parts[1] === 168) ||
			(parts[0] === 169 && parts[1] === 254)
		);
	}
	if (version === 6) {
		const lower = hostname.toLowerCase();
		return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
	}
	return false;
}
