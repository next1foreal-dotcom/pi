/**
 * G-124 — her_publish → her-memory/published/<slug>.html + optional static server.
 */

import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PublishConfig } from "./bg-task-config.ts";
import { DEFAULT_PUBLISH_CONFIG } from "./bg-task-config.ts";

const execFileAsync = promisify(execFile);

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

let liveServer: Server | null = null;
let liveRoot: string | null = null;

export function slugifyTitle(title: string): string {
	const s = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return s || `page-${Date.now().toString(36)}`;
}

export function publishedDir(memoryRoot: string): string {
	return join(memoryRoot, "published");
}

export type PublishResult = {
	slug: string;
	url: string;
	path: string;
	bytes: number;
	commit?: string;
};

export async function herPublish(
	memoryRoot: string,
	input: {
		filePath: string;
		title: string;
		description: string;
		slug?: string;
		label?: string;
		publish?: PublishConfig;
	},
): Promise<PublishResult> {
	const cfg = input.publish ?? DEFAULT_PUBLISH_CONFIG;
	const abs = resolve(input.filePath);
	let html: string;
	try {
		html = await readFile(abs, "utf8");
	} catch {
		throw new Error(`publish source not found: ${abs}`);
	}
	// Must have read the file (ethical red line) — we just did.
	if (html.length > cfg.maxAssetBytes) {
		throw new Error(`file exceeds max_asset_bytes (${cfg.maxAssetBytes})`);
	}

	const slug = input.slug?.trim() || slugifyTitle(input.title);
	if (!SLUG_RE.test(slug)) throw new Error(`invalid slug: ${slug}`);

	const dir = publishedDir(memoryRoot);
	await mkdir(dir, { recursive: true });
	const outPath = join(dir, `${slug}.html`);
	const resolvedOut = resolve(outPath);
	if (!resolvedOut.startsWith(resolve(dir))) {
		throw new Error("slug path escape blocked");
	}

	const wrapped = wrapPublishedHtml(html, input.title, input.description);
	await writeFile(resolvedOut, wrapped, "utf8");
	const bytes = Buffer.byteLength(wrapped, "utf8");

	await ensurePublishServer(dir, cfg);
	const url = `http://${cfg.bind}:${cfg.port}/${slug}.html`;

	let commit: string | undefined;
	try {
		await execFileAsync("git", ["-C", memoryRoot, "add", "--", `published/${slug}.html`], {
			windowsHide: true,
		});
		const msg = input.label?.trim() || `publish: ${slug} — ${input.description.slice(0, 80)}`;
		await execFileAsync("git", ["-C", memoryRoot, "commit", "-m", msg], {
			windowsHide: true,
		});
		const { stdout } = await execFileAsync("git", ["-C", memoryRoot, "rev-parse", "--short", "HEAD"], {
			windowsHide: true,
		});
		commit = stdout.trim();
	} catch {
		// memory repo may be dirty / no identity — publish file still lands
	}

	return { slug, url, path: `published/${slug}.html`, bytes, ...(commit ? { commit } : {}) };
}

export function wrapPublishedHtml(body: string, title: string, description: string): string {
	const trimmed = body.trim();
	if (/<!doctype/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) {
		return trimmed;
	}
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="description" content="${escapeAttr(description)}"/>
<title>${escapeAttr(title)}</title>
<style>
:root, :root[data-theme="light"] { color-scheme: light; background:#f6f4ef; color:#1a1a1a; }
:root[data-theme="dark"] { color-scheme: dark; background:#121212; color:#eee; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { color-scheme: dark; background:#121212; color:#eee; }
}
body { margin: 1.25rem; font: 16px/1.5 system-ui, sans-serif; }
img, table, pre { max-width: 100%; }
.scroll-x { overflow-x: auto; }
</style>
</head>
<body>
${trimmed}
</body>
</html>
`;
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function ensurePublishServer(root: string, cfg: PublishConfig = DEFAULT_PUBLISH_CONFIG): Promise<void> {
	if (liveServer && liveRoot === root) return;
	if (liveServer) {
		await new Promise<void>((resolveClose) => liveServer!.close(() => resolveClose()));
		liveServer = null;
	}
	await mkdir(root, { recursive: true });
	const server = createServer(async (req, res) => {
		try {
			const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0] || "/");
			const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
			const file = resolve(root, rel);
			if (!file.startsWith(resolve(root))) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			await access(file);
			const st = await stat(file);
			if (!st.isFile()) {
				res.writeHead(404);
				res.end("not found");
				return;
			}
			res.writeHead(200, { "Content-Type": contentType(file) });
			createReadStream(file).pipe(res);
		} catch {
			res.writeHead(404);
			res.end("not found");
		}
	});
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(cfg.port, cfg.bind, () => resolveListen());
	});
	liveServer = server;
	liveRoot = root;
}

function contentType(file: string): string {
	const name = basename(file).toLowerCase();
	if (name.endsWith(".html") || name.endsWith(".htm")) return "text/html; charset=utf-8";
	if (name.endsWith(".css")) return "text/css; charset=utf-8";
	if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
	if (name.endsWith(".json")) return "application/json";
	if (name.endsWith(".svg")) return "image/svg+xml";
	return "application/octet-stream";
}

/** Test helper */
export async function stopPublishServer(): Promise<void> {
	if (!liveServer) return;
	await new Promise<void>((resolveClose) => liveServer!.close(() => resolveClose()));
	liveServer = null;
	liveRoot = null;
}
