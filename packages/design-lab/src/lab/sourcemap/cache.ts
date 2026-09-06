/**
 * One parsed source map per served module, kept for the life of the page.
 *
 * Reading a map means fetching the module and decoding a few KB of base64, and
 * neither is free. The lookup that needs it, though, is synchronous — it runs
 * inside a pointerdown handler, inside a repaint, and inside a one-shot script
 * an agent evaluates over CDP. So the fetch cannot happen at the lookup; the
 * lookup can only ask what has already been read.
 *
 * That gives this module its shape:
 *
 *   - `cachedSourceMap` is the synchronous question, and it distinguishes
 *     "never read" (undefined) from "read, and there is nothing usable"
 *     (null). The caller must not treat those the same: the first is a wait,
 *     the second is an answer.
 *   - `loadSourceMap` is the asynchronous read, deduplicated per URL so a
 *     hundred elements from one module cause one fetch.
 *   - `primeSourceMaps` is how the cache gets warm before anyone asks.
 *
 * The key is the module URL exactly as the stack frame spelled it, `?t=` cache
 * buster and all. That is deliberate: after a hot update the same file is
 * served at a new `?t=`, and its coordinates belong to that version of the
 * module and no other. Keying on the bare path would map new coordinates
 * through an old map, which is the same class of silent wrongness this whole
 * file exists to remove.
 */

import { decodeSourceMap, inlineSourceMapOf, type DecodedMap } from "./decode";

/** A parsed map, or null once we know this module has none we can use. */
export type MapEntry = DecodedMap | null;

/**
 * Every hot update mints a new key, so an afternoon of editing would otherwise
 * grow this without bound. Evicting the oldest costs at most one refetch.
 */
const MAX_ENTRIES = 100;

const parsed = new Map<string, MapEntry>();
const inflight = new Map<string, Promise<MapEntry>>();
let parses = 0;

function remember(url: string, entry: MapEntry): void {
  parsed.set(url, entry);
  while (parsed.size > MAX_ENTRIES) {
    const oldest = parsed.keys().next();
    if (oldest.done) break;
    parsed.delete(oldest.value);
  }
}

/**
 * The map for a module if it has already been read. `undefined` means nobody
 * has read it yet — not that it has none.
 */
export function cachedSourceMap(url: string): MapEntry | undefined {
  return parsed.has(url) ? (parsed.get(url) as MapEntry) : undefined;
}

async function readMap(url: string): Promise<MapEntry> {
  try {
    const get = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof get !== "function") return null;
    const res = await get(url);
    if (!res.ok) return null;
    const json = inlineSourceMapOf(await res.text());
    if (!json) return null;
    const map = decodeSourceMap(json);
    if (map) parses++;
    return map;
  } catch {
    // A module that will not load is a module with no map. Never throws: the
    // callers are a paint and a pointer handler.
    return null;
  }
}

/** Read one module's map, at most once. Resolves to null when it has none. */
export function loadSourceMap(url: string): Promise<MapEntry> {
  if (parsed.has(url)) return Promise.resolve(parsed.get(url) as MapEntry);
  const running = inflight.get(url);
  if (running) return running;
  const job = readMap(url).then((entry) => {
    inflight.delete(url);
    remember(url, entry);
    return entry;
  });
  inflight.set(url, job);
  return job;
}

/** Read every map in `urls` that has not been read, and wait for all of them. */
export function primeSourceMaps(urls: Iterable<string>): Promise<void> {
  const jobs: Promise<MapEntry>[] = [];
  for (const url of urls) {
    if (!parsed.has(url)) jobs.push(loadSourceMap(url));
  }
  if (jobs.length === 0) return Promise.resolve();
  return Promise.all(jobs).then(() => undefined);
}

/** How many maps have been decoded. For tests that assert the cache works. */
export function sourceMapParses(): number {
  return parses;
}

/** Empty the cache. For tests; nothing in the lab needs to forget a map. */
export function resetSourceMaps(): void {
  parsed.clear();
  inflight.clear();
  parses = 0;
}
