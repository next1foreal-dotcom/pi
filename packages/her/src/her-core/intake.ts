import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { WorldNoteData } from "./memory.ts";

export interface UrlIntakeOptions {
	allowLocal?: boolean;
	fetcher?: typeof fetch;
	lookup?: typeof dnsLookup;
	maxBytes?: number;
	maxRepoFiles?: number;
}

export interface UrlIntakeResult {
	data: WorldNoteData;
	bytesRead: number;
	finalUrl: string;
	truncated: boolean;
}

const DEFAULT_MAX_BYTES = 250_000;
const DEFAULT_MAX_REPO_FILES = 4;
const DEFAULT_REPO_FILE_BYTES = 40_000;
const MAX_REDIRECTS = 3;

interface GitHubRepoTarget {
	owner: string;
	repo: string;
}

interface GitHubTreeEntry {
	path?: string;
	size?: number;
	type?: string;
}

export async function readUrlForWorldNote(sourceUrl: string, opts: UrlIntakeOptions = {}): Promise<UrlIntakeResult> {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const fetcher = opts.fetcher ?? fetch;
	const lookup = opts.lookup ?? dnsLookup;
	const startUrl = normalizeSourceUrl(sourceUrl);
	await assertSafeHttpUrl(startUrl, { allowLocal: opts.allowLocal, lookup });
	const githubRepo = parseGithubRepoUrl(startUrl);
	if (githubRepo) {
		return readGithubRepoForWorldNote(startUrl.href, githubRepo, {
			allowLocal: opts.allowLocal,
			fetcher,
			lookup,
			...opts,
		});
	}
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

async function readGithubRepoForWorldNote(
	requestedUrl: string,
	target: GitHubRepoTarget,
	opts: UrlIntakeOptions,
): Promise<UrlIntakeResult> {
	const fetcher = opts.fetcher ?? fetch;
	const lookup = opts.lookup ?? dnsLookup;
	const maxRepoFiles = opts.maxRepoFiles ?? DEFAULT_MAX_REPO_FILES;
	const repoUrl = `https://github.com/${target.owner}/${target.repo}`;
	const apiUrl = new URL(`https://api.github.com/repos/${target.owner}/${target.repo}`);
	await assertSafeHttpUrl(apiUrl, { allowLocal: opts.allowLocal, lookup });
	const metadataResponse = await fetchWithSafeRedirects(apiUrl, { allowLocal: opts.allowLocal, fetcher, lookup });
	if (!metadataResponse.ok) {
		return failedUrlIntake(requestedUrl, repoUrl, "repo", `GitHub metadata HTTP ${metadataResponse.status}`);
	}
	const metadata = await readJsonResponse(metadataResponse);
	const defaultBranch = stringValue(metadata, "default_branch") ?? "main";
	const description = stringValue(metadata, "description");
	const treeUrl = new URL(
		`https://api.github.com/repos/${target.owner}/${target.repo}/git/trees/${encodeURIComponent(defaultBranch)}`,
	);
	treeUrl.searchParams.set("recursive", "1");
	await assertSafeHttpUrl(treeUrl, { allowLocal: opts.allowLocal, lookup });
	const treeResponse = await fetchWithSafeRedirects(treeUrl, { allowLocal: opts.allowLocal, fetcher, lookup });
	if (!treeResponse.ok) {
		return failedUrlIntake(requestedUrl, repoUrl, "repo", `GitHub tree HTTP ${treeResponse.status}`);
	}
	const tree = await readJsonResponse(treeResponse);
	const entries = Array.isArray(tree.tree) ? (tree.tree as GitHubTreeEntry[]) : [];
	const candidates = chooseRepoFiles(entries, maxRepoFiles);
	const files: Array<{ bytesRead: number; path: string; text: string; truncated: boolean }> = [];
	let bytesRead = 0;
	let truncated = false;

	for (const entry of candidates) {
		if (!entry.path) continue;
		const rawUrl = githubRawFileUrl(target, defaultBranch, entry.path);
		await assertSafeHttpUrl(rawUrl, { allowLocal: opts.allowLocal, lookup });
		const response = await fetchWithSafeRedirects(rawUrl, { allowLocal: opts.allowLocal, fetcher, lookup });
		if (!response.ok) continue;
		const read = await readResponseText(
			response,
			Math.min(opts.maxBytes ?? DEFAULT_MAX_BYTES, DEFAULT_REPO_FILE_BYTES),
		);
		const text = normalizeExtractedText(read.text);
		files.push({ bytesRead: read.bytesRead, path: entry.path, text, truncated: read.truncated });
		bytesRead += read.bytesRead;
		truncated = truncated || read.truncated;
	}

	const symbols = files.flatMap((file) =>
		extractCodeSymbols(file.path, file.text).map((symbol) => `${file.path}: ${symbol}`),
	);
	const memoryStatus = files.length >= 2 && symbols.length > 0 ? "active" : "needs_deep_read";
	const memoryStatusReason =
		memoryStatus === "active"
			? undefined
			: `Repository intake read ${files.length} file(s) and detected ${symbols.length} code symbol(s); needs deeper repo reader.`;
	const coverage = [
		`Read ${files.length} repository files from ${repoUrl} on branch ${defaultBranch}.`,
		files.length > 0
			? `Files read: ${files.map((file) => file.path).join(", ")}.`
			: "No readable files were fetched.",
		symbols.length > 0 ? `Detected real code symbols: ${symbols.join("; ")}.` : "No code symbols detected.",
		truncated
			? "At least one file was truncated to keep minimal intake bounded."
			: "Selected files were read within the minimal repo intake budget.",
	].join(" ");
	const extracted = renderRepoExtracted(target, defaultBranch, description, files, symbols);
	const data: WorldNoteData = {
		title: `${target.owner}/${target.repo} repository`,
		sourceUrl: repoUrl,
		sourceType: "repo",
		contentHash: intakeContentHash(repoUrl, extracted || coverage),
		memoryStatus,
		...(memoryStatusReason ? { memoryStatusReason } : {}),
		extracted: extracted || "(no readable repository files extracted)",
		coverage,
		read:
			memoryStatus === "active"
				? "Samantha read selected repository files and identified concrete code symbols for later recall."
				: "Samantha only has a bounded repository orientation stub.",
		steal: symbols.slice(0, 3),
		connections: [],
		take:
			memoryStatus === "active"
				? "This repo can now be recalled by actual files and methods, not only by its README or directory shape."
				: "Keep this repo stub and run a deeper repo reader before relying on implementation claims.",
		possibleMoves:
			memoryStatus === "active"
				? ["Run a deeper repo sweep when a task needs architecture-level confidence."]
				: ["Retry with deep-reader or a local clone for broader repository coverage."],
	};
	return { data, bytesRead, finalUrl: repoUrl, truncated };
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

function parseGithubRepoUrl(url: URL): GitHubRepoTarget | undefined {
	if (url.hostname.toLowerCase() !== "github.com") return undefined;
	const [owner, repo] = url.pathname
		.split("/")
		.filter(Boolean)
		.map((part) => part.trim());
	if (!owner || !repo) return undefined;
	const normalizedRepo = repo.replace(/\.git$/i, "");
	const valid = /^[A-Za-z0-9_.-]+$/;
	if (!valid.test(owner) || !valid.test(normalizedRepo)) return undefined;
	return { owner, repo: normalizedRepo };
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

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	const parsed = JSON.parse(text) as unknown;
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function chooseRepoFiles(entries: GitHubTreeEntry[], maxFiles: number): GitHubTreeEntry[] {
	return entries
		.filter((entry) => entry.type === "blob" && entry.path && isReadableRepoFile(entry.path, entry.size))
		.map((entry) => ({ ...entry, score: repoFileScore(entry.path ?? "") }))
		.sort((a, b) => b.score - a.score || String(a.path).localeCompare(String(b.path)))
		.slice(0, maxFiles)
		.map(({ score: _score, ...entry }) => entry);
}

function isReadableRepoFile(path: string, size = 0): boolean {
	const normalized = path.replace(/\\/g, "/");
	if (size > 250_000) return false;
	if (/(^|\/)(\.git|node_modules|vendor|dist|build|coverage|target|__pycache__)\//i.test(normalized)) return false;
	if (/(^|\/)(package-lock|npm-shrinkwrap|pnpm-lock|yarn\.lock|bun\.lockb)$/i.test(normalized)) return false;
	return /\.(md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|json|toml|ya?ml)$/i.test(normalized);
}

function repoFileScore(path: string): number {
	const normalized = path.replace(/\\/g, "/");
	const name = normalized.split("/").at(-1) ?? normalized;
	if (/^README(\..*)?$/i.test(name)) return 100;
	if (/^(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|deno\.json|tsconfig\.json)$/i.test(name)) return 92;
	if (
		/^(src|lib|app|packages)\//i.test(normalized) &&
		/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php)$/i.test(name)
	) {
		return /(?:index|main|app|server|extension|cli)\.[^.]+$/i.test(name) ? 88 : 78;
	}
	if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php)$/i.test(name)) return 64;
	if (/^(docs|documentation)\//i.test(normalized)) return 30;
	return 20;
}

function githubRawFileUrl(target: GitHubRepoTarget, branch: string, path: string): URL {
	const encodedPath = path
		.split("/")
		.filter(Boolean)
		.map((part) => encodeURIComponent(part))
		.join("/");
	return new URL(
		`https://raw.githubusercontent.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/${encodeURIComponent(branch)}/${encodedPath}`,
	);
}

function renderRepoExtracted(
	target: GitHubRepoTarget,
	branch: string,
	description: string | undefined,
	files: Array<{ path: string; text: string; truncated: boolean }>,
	symbols: string[],
): string {
	const fileSections = files.map((file) =>
		[`## ${file.path}${file.truncated ? " (truncated)" : ""}`, "```", file.text, "```"].join("\n"),
	);
	return normalizeExtractedText(
		[
			`# ${target.owner}/${target.repo}`,
			description ? `Description: ${description}` : "",
			`Default branch: ${branch}`,
			files.length > 0 ? `Files read: ${files.map((file) => file.path).join(", ")}` : "Files read: (none)",
			symbols.length > 0 ? `Code symbols: ${symbols.join("; ")}` : "Code symbols: (none)",
			...fileSections,
		]
			.filter(Boolean)
			.join("\n\n"),
	);
}

function extractCodeSymbols(path: string, text: string): string[] {
	if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php)$/i.test(path)) return [];
	const patterns = [
		/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
		/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
		/\bclass\s+([A-Za-z_$][\w$]*)\b/g,
		/\bdef\s+([A-Za-z_][\w]*)\s*\(/g,
		/\bfunc\s+([A-Za-z_][\w]*)\s*\(/g,
		/\bfn\s+([A-Za-z_][\w]*)\s*\(/g,
	];
	const symbols: string[] = [];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			const symbol = match[1];
			if (symbol && !symbols.includes(symbol)) symbols.push(symbol);
			if (symbols.length >= 5) return symbols;
		}
	}
	return symbols;
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
