import { copyFile, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { isSupportedLocalExtension } from "./classify.ts";
import { cleanVtt, countWords, stripHtml } from "./text.ts";
import type { AcquiredMaterial, HandlerContext, MaterialPlan } from "./types.ts";

interface TweetMedia {
	url: string;
	isImage: boolean;
}

interface FxTweetData {
	text: string;
	media: TweetMedia[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function fetchText(url: string, ctx: HandlerContext, init?: RequestInit): Promise<string> {
	const response = await ctx.fetcher(url, init);
	if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
	return response.text();
}

function mediaItems(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function imageExtension(url: string): string {
	try {
		const parsed = new URL(url);
		const extension = extname(parsed.pathname).toLowerCase();
		if (/^\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?)$/.test(extension)) return extension;
		const format = parsed.searchParams.get("format")?.toLowerCase() ?? "";
		if (/^(?:jpe?g|png|gif|webp|avif|bmp|tiff?)$/.test(format)) return `.${format === "jpeg" ? "jpg" : format}`;
	} catch {
		return ".bin";
	}
	return ".bin";
}

function mediaUrl(value: unknown): string | undefined {
	if (typeof value === "string") return /^https?:\/\//i.test(value) ? value : undefined;
	if (!isRecord(value) || typeof value.url !== "string") return undefined;
	return /^https?:\/\//i.test(value.url) ? value.url : undefined;
}

function mediaIsImage(value: unknown, url: string): boolean {
	if (isRecord(value) && typeof value.type === "string") {
		const type = value.type.toLowerCase();
		if (type === "photo" || type === "image" || type === "gif") return true;
		if (type === "video") return false;
	}
	return imageExtension(url) !== ".bin";
}

export function parseFxTweetPayload(payload: unknown): FxTweetData {
	if (!isRecord(payload)) throw new Error("fxtwitter response is not an object");
	const tweetValue = isRecord(payload.tweet) ? payload.tweet : payload;
	const text = typeof tweetValue.text === "string" ? tweetValue.text : "";
	const mediaValue = isRecord(tweetValue.media) ? tweetValue.media : {};
	const rawItems = [...mediaItems(mediaValue.all), ...mediaItems(mediaValue.photos)];
	const media: TweetMedia[] = [];
	const seen = new Set<string>();
	for (const item of rawItems) {
		const url = mediaUrl(item);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		media.push({ url, isImage: mediaIsImage(item, url) });
	}
	return { text, media };
}

function tweetBody(data: FxTweetData): string {
	const urls = data.media.map((item) => `- ${item.url}`);
	if (!urls.length) return data.text.trim();
	return `${data.text.trim()}\n\nMedia URLs:\n${urls.join("\n")}`.trim();
}

async function downloadMedia(
	url: string,
	fileStem: string,
	materialsDir: string,
	fetcher: HandlerContext["fetcher"],
): Promise<void> {
	const response = await fetcher(url);
	if (!response.ok) throw new Error(`HTTP ${response.status} from media URL`);
	const bytes = Buffer.from(await response.arrayBuffer());
	const extension = imageExtension(url);
	await writeFile(join(materialsDir, `${fileStem}-media${extension}`), bytes);
}

// URLs are derived only from parsed input IDs and provider response fields; no model constructs links.
export async function acquireTweet(
	id: string | undefined,
	plan: MaterialPlan,
	ctx: HandlerContext,
): Promise<AcquiredMaterial> {
	if (!id) throw new Error("tweet URL has no status id");
	const endpoint = `https://api.fxtwitter.com/status/${id}`;
	const response = await ctx.fetcher(endpoint, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`HTTP ${response.status} from ${endpoint}`);
	const payload: unknown = await response.json();
	const data = parseFxTweetPayload(payload);
	const failures: string[] = [];
	for (let index = 0; index < data.media.length; index += 1) {
		const item = data.media[index];
		if (!item?.isImage) continue;
		try {
			await downloadMedia(
				item.url,
				`${plan.stem}-${(index + 1).toString().padStart(3, "0")}`,
				ctx.materialsDir,
				ctx.fetcher,
			);
		} catch (error) {
			failures.push(`${item.url}: ${errorText(error)}`);
		}
	}
	const body = tweetBody(data);
	await writeFile(plan.absolutePath, `${body}\n`, "utf8");
	return failures.length
		? { words: countWords(data.text), status: "failed", error: `media-download-failed: ${failures.join("; ")}` }
		: { words: countWords(data.text) };
}

export async function acquireWeb(source: string, plan: MaterialPlan, ctx: HandlerContext): Promise<AcquiredMaterial> {
	let body: string;
	try {
		body = await fetchText(source, ctx);
	} catch (error) {
		const key = ctx.env.JINA_API_KEY?.trim();
		if (!key) throw new Error(`fetch-failed: ${errorText(error)}`);
		const jinaUrl = `https://r.jina.ai/${source}`;
		try {
			body = await fetchText(jinaUrl, ctx, { headers: { authorization: `Bearer ${key}` } });
		} catch (fallbackError) {
			throw new Error(`fetch-failed: ${errorText(error)}; jina-fallback-failed: ${errorText(fallbackError)}`);
		}
	}
	const text = stripHtml(body);
	await writeFile(plan.absolutePath, `${text}\n`, "utf8");
	return { words: countWords(text) };
}

function vttCandidates(files: string[], stem: string): string[] {
	return files.filter((file) => file.startsWith(`${stem}.`) && file.toLowerCase().endsWith(".vtt"));
}

function chooseVtt(files: string[], stem: string): string | undefined {
	const candidates = vttCandidates(files, stem);
	return (
		candidates.find((file) => /(?:^|[._-])zh(?:[._-]|$)/i.test(file)) ??
		candidates.find((file) => /(?:^|[._-])en(?:[._-]|$)/i.test(file)) ??
		candidates[0]
	);
}

async function removeFiles(files: string[], materialsDir: string): Promise<void> {
	for (const file of files) {
		try {
			await unlink(join(materialsDir, file));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export async function acquireYoutube(
	source: string,
	plan: MaterialPlan,
	ctx: HandlerContext,
): Promise<AcquiredMaterial> {
	const outputTemplate = join(ctx.materialsDir, `${plan.stem}.%(ext)s`);
	const args = [
		"--no-playlist",
		"--skip-download",
		"--write-auto-subs",
		"--sub-langs",
		"zh.*,en.*",
		"--sub-format",
		"vtt",
		"--no-write-info-json",
		"--output",
		outputTemplate,
		source,
	];
	const result = await ctx.ytDlpRunner("yt-dlp", args, ctx.materialsDir);
	let files = await readdir(ctx.materialsDir);
	let selected = chooseVtt(files, plan.stem);
	if (!selected && result.stdout.includes("WEBVTT")) {
		selected = `${plan.stem}.vtt`;
		await writeFile(join(ctx.materialsDir, selected), result.stdout, "utf8");
		files = [...files, selected];
	}
	if (!selected)
		throw new Error(`yt-dlp produced no VTT subtitles${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	const raw = await readFile(join(ctx.materialsDir, selected), "utf8");
	const text = cleanVtt(raw);
	if (!text) throw new Error("VTT subtitles contained no text");
	await writeFile(plan.absolutePath, `${text}\n`, "utf8");
	await removeFiles(vttCandidates(files, plan.stem), ctx.materialsDir);
	return { words: countWords(text) };
}

export async function acquireLocal(
	source: string,
	extension: string | undefined,
	plan: MaterialPlan,
): Promise<AcquiredMaterial> {
	if (!isSupportedLocalExtension(extension))
		throw new Error("unsupported local extension; expected .epub, .pdf, .md, or .txt");
	await copyFile(source, plan.absolutePath);
	if (extension === ".md" || extension === ".txt") {
		const text = await readFile(plan.absolutePath, "utf8");
		return { words: countWords(text) };
	}
	return { words: 0 };
}
