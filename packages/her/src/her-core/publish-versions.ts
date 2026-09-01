/**
 * G-404 — version archive for her_publish (paths, numbering, manifest I/O).
 *
 * sha256 values in the manifest are a 16-hex-char prefix of sha256 (short hash).
 * Manifest writes use writeJson (atomic writeText temp+rename). writeNewText is
 * wx-create-only and cannot update an existing index.json.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJson } from "./store.ts";

export const PUBLISH_VERSION_CAP = 20;

export type PublishVersionEntry = {
	n: number;
	at: string;
	label?: string;
	bytes: number;
	sha256: string;
	sessionId?: string;
};

export type PublishVersionManifest = {
	slug: string;
	currentSessionId?: string;
	currentLabel?: string;
	versions: PublishVersionEntry[];
};

export type PublishWakePayload = {
	from: string;
	to: string;
	at: string;
	urgent: true;
	origin: string;
	body: string;
};

export function shortSha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function nextVersionNumber(versions: Array<{ n: number }>): number {
	let max = 0;
	for (const row of versions) {
		if (Number.isInteger(row.n) && row.n > max) max = row.n;
	}
	return max + 1;
}

export function publishVersionDir(publishedRoot: string, slug: string): string {
	return join(publishedRoot, "versions", slug);
}

export function publishVersionFilePath(publishedRoot: string, slug: string, n: number): string {
	return join(publishVersionDir(publishedRoot, slug), `v${n}.html`);
}

export function publishVersionManifestPath(publishedRoot: string, slug: string): string {
	return join(publishVersionDir(publishedRoot, slug), "index.json");
}

export function buildPublishWakeMessage(opts: {
	slug: string;
	archivedN: number;
	label?: string;
	fromSessionId: string;
	toSessionId: string;
	now?: Date;
}): PublishWakePayload {
	const n = opts.archivedN;
	const labelText = opts.label?.trim() || "无";
	return {
		from: opts.fromSessionId,
		to: opts.toSessionId,
		at: (opts.now ?? new Date()).toISOString(),
		urgent: true,
		origin: `publish-${opts.slug}-v${n}`,
		body: `[发布更新] ${opts.slug} 被覆盖为 v${n + 1}(标签:${labelText})。旧版留档:published/versions/${opts.slug}/v${n}.html`,
	};
}

export async function readPublishManifest(publishedRoot: string, slug: string): Promise<PublishVersionManifest> {
	const fallback: PublishVersionManifest = { slug, versions: [] };
	try {
		const data = await readJson<Partial<PublishVersionManifest>>(
			publishVersionManifestPath(publishedRoot, slug),
			fallback,
		);
		const versions = Array.isArray(data.versions)
			? data.versions.map(asVersionEntry).filter((row): row is PublishVersionEntry => row !== undefined)
			: [];
		const manifest: PublishVersionManifest = {
			slug: typeof data.slug === "string" && data.slug ? data.slug : slug,
			versions,
		};
		if (typeof data.currentSessionId === "string" && data.currentSessionId) {
			manifest.currentSessionId = data.currentSessionId;
		}
		if (typeof data.currentLabel === "string" && data.currentLabel) {
			manifest.currentLabel = data.currentLabel;
		}
		return manifest;
	} catch {
		return fallback;
	}
}

export async function writePublishManifest(
	publishedRoot: string,
	slug: string,
	manifest: PublishVersionManifest,
): Promise<void> {
	await writeJson(publishVersionManifestPath(publishedRoot, slug), manifest);
}

export async function recordCurrentPublisher(opts: {
	publishedRoot: string;
	slug: string;
	sessionId?: string;
	label?: string;
}): Promise<void> {
	const man = await readPublishManifest(opts.publishedRoot, opts.slug);
	const next: PublishVersionManifest = {
		slug: opts.slug,
		versions: man.versions,
	};
	if (opts.sessionId) next.currentSessionId = opts.sessionId;
	if (opts.label) next.currentLabel = opts.label;
	await writePublishManifest(opts.publishedRoot, opts.slug, next);
}

export async function archiveExistingPublish(opts: {
	publishedRoot: string;
	slug: string;
	cap?: number;
	now?: Date;
}): Promise<{ entry: PublishVersionEntry; previousSessionId?: string } | null> {
	const livePath = join(opts.publishedRoot, `${opts.slug}.html`);
	let buf: Buffer;
	try {
		buf = await readFile(livePath);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
	const manifest = await readPublishManifest(opts.publishedRoot, opts.slug);
	const n = nextVersionNumber(manifest.versions);
	const entry: PublishVersionEntry = {
		n,
		at: (opts.now ?? new Date()).toISOString(),
		bytes: buf.byteLength,
		sha256: shortSha256(buf),
	};
	if (manifest.currentLabel) entry.label = manifest.currentLabel;
	if (manifest.currentSessionId) entry.sessionId = manifest.currentSessionId;
	const dir = publishVersionDir(opts.publishedRoot, opts.slug);
	await mkdir(dir, { recursive: true });
	await writeFile(publishVersionFilePath(opts.publishedRoot, opts.slug, n), buf);
	const kept = await pruneOldest(
		opts.publishedRoot,
		opts.slug,
		[...manifest.versions, entry],
		opts.cap ?? PUBLISH_VERSION_CAP,
	);
	const next: PublishVersionManifest = {
		slug: opts.slug,
		versions: kept,
	};
	if (manifest.currentSessionId) next.currentSessionId = manifest.currentSessionId;
	if (manifest.currentLabel) next.currentLabel = manifest.currentLabel;
	await writePublishManifest(opts.publishedRoot, opts.slug, next);
	return {
		entry,
		...(manifest.currentSessionId ? { previousSessionId: manifest.currentSessionId } : {}),
	};
}

function asVersionEntry(value: unknown): PublishVersionEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const row = value as Record<string, unknown>;
	if (typeof row.n !== "number" || !Number.isInteger(row.n) || row.n < 1) return undefined;
	if (typeof row.at !== "string") return undefined;
	if (typeof row.bytes !== "number") return undefined;
	if (typeof row.sha256 !== "string") return undefined;
	const entry: PublishVersionEntry = {
		n: row.n,
		at: row.at,
		bytes: row.bytes,
		sha256: row.sha256,
	};
	if (typeof row.label === "string" && row.label) entry.label = row.label;
	if (typeof row.sessionId === "string" && row.sessionId) entry.sessionId = row.sessionId;
	return entry;
}

async function pruneOldest(
	publishedRoot: string,
	slug: string,
	versions: PublishVersionEntry[],
	cap: number,
): Promise<PublishVersionEntry[]> {
	const sorted = [...versions].sort((a, b) => a.n - b.n);
	while (sorted.length > cap) {
		const oldest = sorted.shift();
		if (!oldest) break;
		try {
			await unlink(publishVersionFilePath(publishedRoot, slug, oldest.n));
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
				throw error;
			}
		}
	}
	return sorted;
}
