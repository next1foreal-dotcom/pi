import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { classifySource } from "./classify.ts";
import { acquireLocal, acquireTweet, acquireWeb, acquireYoutube } from "./handlers.ts";
import { cleanVtt, countWords, stripHtml } from "./text.ts";
import type { AcquiredMaterial, AcquireOptions, HandlerContext, Manifest, MaterialPlan, YtDlpResult } from "./types.ts";

const execFileAsync = promisify(execFile);

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normaliseRelative(path: string): string {
	return path.split(sep).join("/");
}

function safeSlug(slug: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) || slug === "." || slug === "..") {
		throw new Error("slug must contain only letters, numbers, dot, underscore, or hyphen");
	}
	return slug;
}

function safeBaseName(source: string): string {
	const sourceName = basename(source.replace(/\\/g, "/"));
	const cleaned = sourceName.replace(/[^A-Za-z0-9._-]/g, "_");
	return cleaned || "source";
}

function makePlan(
	index: number,
	source: string,
	kind: string,
	materialsDir: string,
	compendiumDir: string,
): MaterialPlan {
	const prefix = `${(index + 1).toString().padStart(3, "0")}-${kind}`;
	const fileName = kind === "local" ? `${prefix}-${safeBaseName(source)}` : `${prefix}.txt`;
	const absolutePath = join(materialsDir, fileName);
	return {
		absolutePath,
		relativePath: normaliseRelative(relative(compendiumDir, absolutePath)),
		stem: fileName.replace(/\.txt$/i, ""),
	};
}

async function defaultFetcher(url: string, init?: RequestInit): Promise<Response> {
	if (!globalThis.fetch) throw new Error("global fetch is unavailable");
	return globalThis.fetch(url, init);
}

async function defaultYtDlpRunner(command: string, args: string[], cwd: string): Promise<YtDlpResult> {
	try {
		const result = await execFileAsync(command, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
		return { stdout: String(result.stdout), stderr: String(result.stderr) };
	} catch (error) {
		const details = error as NodeJS.ErrnoException & { stderr?: string };
		const suffix = details.stderr?.trim() ? `: ${details.stderr.trim()}` : "";
		throw new Error(`yt-dlp failed${suffix}`);
	}
}

function planFor(
	index: number,
	source: string,
	kind: string,
	materialsDir: string,
	compendiumDir: string,
): MaterialPlan {
	return makePlan(index, source, kind, materialsDir, compendiumDir);
}

async function acquireOne(
	source: string,
	classification: ReturnType<typeof classifySource>,
	plan: MaterialPlan,
	ctx: HandlerContext,
): Promise<AcquiredMaterial> {
	switch (classification.kind) {
		case "youtube":
			return acquireYoutube(source, plan, ctx);
		case "tweet":
			return acquireTweet(classification.id, plan, ctx);
		case "web":
			return acquireWeb(source, plan, ctx);
		case "local":
			return acquireLocal(source, classification.extension, plan);
	}
}

export async function acquireSources(
	sources: readonly string[],
	slug: string,
	options: AcquireOptions = {},
): Promise<Manifest> {
	if (!sources.length) throw new Error("at least one source is required");
	const memoryDir = resolve(
		options.memoryDir ??
			options.env?.HER_MEMORY_DIR ??
			process.env.HER_MEMORY_DIR ??
			join(process.cwd(), "..", "her-memory"),
	);
	const compendiumDir = join(memoryDir, ".her", "compendium", safeSlug(slug));
	const materialsDir = join(compendiumDir, "materials");
	await mkdir(materialsDir, { recursive: true });
	const ctx: HandlerContext = {
		fetcher: options.fetcher ?? defaultFetcher,
		ytDlpRunner: options.ytDlpRunner ?? defaultYtDlpRunner,
		env: options.env ?? process.env,
		materialsDir,
	};
	const items = [] as Manifest["items"];
	for (let index = 0; index < sources.length; index += 1) {
		const source = sources[index] ?? "";
		const classification = classifySource(source);
		const plan = planFor(index, source, classification.kind, materialsDir, compendiumDir);
		const item = await acquireItem(
			source,
			classification,
			plan,
			ctx,
			options.now ?? (() => new Date().toISOString()),
		);
		items.push(item);
	}
	const manifest: Manifest = { items };
	await writeFile(join(compendiumDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return manifest;
}

async function acquireItem(
	source: string,
	classification: ReturnType<typeof classifySource>,
	plan: MaterialPlan,
	ctx: HandlerContext,
	now: () => string,
): Promise<Manifest["items"][number]> {
	const fetchedAt = now();
	try {
		const result = await acquireOne(source, classification, plan, ctx);
		return {
			sourceUrl: source,
			localPath: plan.relativePath,
			kind: classification.kind,
			words: result.words,
			fetchedAt,
			status: result.status ?? "ok",
			...(result.error ? { error: result.error } : {}),
		};
	} catch (error) {
		return {
			sourceUrl: source,
			localPath: plan.relativePath,
			kind: classification.kind,
			words: 0,
			fetchedAt,
			status: "failed",
			error: errorText(error),
		};
	}
}

export { classifySource, isSupportedLocalExtension } from "./classify.ts";
export { parseFxTweetPayload } from "./handlers.ts";
export { cleanVtt, countWords, stripHtml };
export type {
	AcquireOptions,
	Manifest,
	ManifestItem,
	MaterialKind,
	MaterialStatus,
	SourceClassification,
	YtDlpResult,
	YtDlpRunner,
} from "./types.ts";
