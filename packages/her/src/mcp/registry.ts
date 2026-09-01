/**
 * Make a connected server's tools first-class in her tool list.
 *
 * Before this, an external server gave her exactly two tools —
 * `her_mcp_list` and `her_mcp_call` — so she had to already suspect a server
 * might help, go ask what it offered, and only then call it. Claude Code
 * surfaces every remote tool directly (`mcp__server__tool`), which is the
 * difference between "wired up" and "usable": a tool she can see in her list
 * is one she will reach for.
 *
 * pi registers tools synchronously at activation, so discovery cannot happen
 * during registration without blocking startup on every configured server.
 * The cache is what bridges that: registration reads a file, and refreshing
 * it is an explicit act. The cost is honest and stated in the refresh tool's
 * own reply — newly discovered tools appear next session, not this one.
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CACHE_RELATIVE = join(".her", "connectors.cache.json");

/** Namespaced the way Claude Code names them, so the shape is familiar. */
export function toolNameFor(slug: string, tool: string): string {
	return `mcp__${slug}__${tool}`;
}

export interface CachedTool {
	name: string;
	description?: string;
	/** The remote's own JSON Schema, passed through untouched. */
	inputSchema?: unknown;
}

export interface CachedConnector {
	slug: string;
	label: string;
	tools: CachedTool[];
	/** When this entry was written, so a stale cache can say so. */
	discoveredAt: string;
}

export interface ToolCache {
	version: 1;
	connectors: CachedConnector[];
}

const EMPTY: ToolCache = { version: 1, connectors: [] };

export function cachePath(repoRoot: string): string {
	return join(repoRoot, CACHE_RELATIVE);
}

/**
 * Read synchronously: registration happens during activation, and an async
 * read there would register nothing.
 */
export function readToolCacheSync(repoRoot: string): ToolCache {
	try {
		const parsed = JSON.parse(readFileSync(cachePath(repoRoot), "utf8")) as ToolCache;
		if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.connectors)) return EMPTY;
		return {
			version: 1,
			connectors: parsed.connectors.filter(
				(entry): entry is CachedConnector =>
					!!entry && typeof entry.slug === "string" && Array.isArray(entry.tools),
			),
		};
	} catch {
		// No cache yet, or unreadable — she simply has no remote tools listed.
		return EMPTY;
	}
}

export async function writeToolCache(repoRoot: string, cache: ToolCache): Promise<void> {
	const path = cachePath(repoRoot);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

/**
 * A remote description, trimmed and tagged with its origin.
 *
 * The tag is not decoration: the text comes from a third party, and she should
 * be able to tell at a glance which of her tools are hers and which arrived
 * from a server someone else runs.
 */
export function describeRemoteTool(label: string, tool: CachedTool): string {
	const own = (tool.description ?? "").trim().replace(/\s+/g, " ");
	const head = own ? own.slice(0, 200) : "（这个外接工具没有自述）";
	return `[外接 ${label}] ${head}`;
}
