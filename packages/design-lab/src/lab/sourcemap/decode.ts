/**
 * Just enough of a source-map consumer to answer one question: the module the
 * dev server handed the browser says something happened at generated line L,
 * column C — where is that in the file a person edits?
 *
 * Written here rather than installed because the whole job is one lookup over
 * one map, `mappings` is a page of grammar, and this package's dependency list
 * is three packages long on purpose.
 *
 * Two things this deliberately does NOT do, both because being wrong is worse
 * than saying nothing:
 *
 *   - a segment carrying only a generated column is a real segment meaning
 *     "this stretch maps to nothing". It is not skipped over in favour of the
 *     last segment that did have a source; that is how a lookup lands on a
 *     plausible line belonging to some earlier expression.
 *   - a malformed field count (2 or 3) rejects the WHOLE map rather than
 *     dropping the segment. A map we do not fully understand is one we must
 *     not quote numbers out of.
 */

/**
 * One entry of the `mappings` field. `srcLine`/`srcCol` are 0-based, as in the
 * file format; `originalPositionFor` is what converts to 1-based lines.
 */
export type MapSegment = {
  /** 0-based column in the generated line. */
  genCol: number;
  /** Index into `sources`. Absent on a segment that maps to nothing. */
  source?: number;
  srcLine?: number;
  srcCol?: number;
};

export type DecodedMap = {
  /** As written in the map: usually one bare filename under vite's dev server. */
  sources: (string | null)[];
  /** Segments per generated line, 0-based, in generated-column order. */
  lines: MapSegment[][];
};

export type OriginalPosition = {
  source: string | null;
  /** 1-based, so it can be compared with a stack frame's line directly. */
  line: number;
  column: number;
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Five continuation bytes is already a 32-bit field; more is malformed. */
const MAX_SHIFT = 40;

/**
 * One comma-free run of base64 VLQ into its numbers, or null if it is not one.
 *
 * The arithmetic is deliberately `* 2 ** shift` and `% 2` rather than `<<` and
 * `& 1`: JavaScript's bitwise operators coerce to int32, so a legal 32-bit
 * field would come back negative and silently wrong.
 */
function decodeVlq(text: string): number[] | null {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const digit = B64.indexOf(text[i]);
    if (digit < 0) return null;
    open = true;
    value += (digit & 31) * 2 ** shift;
    if ((digit & 32) === 0) {
      const negative = value % 2 === 1;
      const magnitude = (value - (negative ? 1 : 0)) / 2;
      out.push(negative ? -magnitude : magnitude);
      value = 0;
      shift = 0;
      open = false;
      continue;
    }
    shift += 5;
    if (shift > MAX_SHIFT) return null;
  }
  // A trailing continuation byte with nothing after it is a truncated field.
  return open ? null : out;
}

/** The `mappings` string into per-line segments, or null if it is malformed. */
function decodeMappings(mappings: string): MapSegment[][] | null {
  const lines: MapSegment[][] = [];
  let source = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const lineText of mappings.split(";")) {
    const segments: MapSegment[] = [];
    let genCol = 0;
    if (lineText) {
      for (const segmentText of lineText.split(",")) {
        if (!segmentText) continue;
        const fields = decodeVlq(segmentText);
        if (!fields) return null;
        if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5) {
          return null;
        }
        genCol += fields[0];
        if (genCol < 0) return null;
        if (fields.length === 1) {
          segments.push({ genCol });
          continue;
        }
        source += fields[1];
        srcLine += fields[2];
        srcCol += fields[3];
        if (source < 0 || srcLine < 0 || srcCol < 0) return null;
        segments.push({ genCol, source, srcLine, srcCol });
      }
    }
    lines.push(segments);
  }
  return lines;
}

/** A source map's JSON text into something lookups can run on. Null if it is
 * not a v3 map, or if any part of `mappings` does not decode. */
export function decodeSourceMap(json: string): DecodedMap | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { version, sources, mappings } = raw as {
    version?: unknown;
    sources?: unknown;
    mappings?: unknown;
  };
  if (version !== 3) return null;
  if (typeof mappings !== "string") return null;
  if (!Array.isArray(sources)) return null;
  const lines = decodeMappings(mappings);
  if (!lines) return null;
  return {
    sources: sources.map((s) => (typeof s === "string" ? s : null)),
    lines,
  };
}

/**
 * The source position a generated one came from, both 1-based, or null when
 * that spot in the generated file maps to nothing.
 *
 * Greatest lower bound on the generated column, which is what a stack frame
 * needs: the frame points at the first character of the call, and the segment
 * that owns that character is the last one starting at or before it.
 */
export function originalPositionFor(
  map: DecodedMap,
  line: number,
  column: number,
): OriginalPosition | null {
  const segments = map.lines[line - 1];
  if (!segments || segments.length === 0) return null;
  const target = column - 1;
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].genCol <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const hit = segments[found];
  if (hit.source === undefined || hit.srcLine === undefined || hit.srcCol === undefined) {
    return null;
  }
  return {
    source: map.sources[hit.source] ?? null,
    line: hit.srcLine + 1,
    column: hit.srcCol + 1,
  };
}

/** Every `//# sourceMappingURL=` comment; the last one wins, per the format. */
const MAP_URL_RE = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/g;

/**
 * The map JSON carried inside a module's own text, or null.
 *
 * Only `data:` URIs are read. Vite's dev server inlines every map it makes, so
 * an external `.map` file does not occur on the path this exists for, and
 * fetching one would be a second round trip taken on a guess. A module whose
 * map is external therefore reports as unmappable — which is a refusal, not a
 * wrong number.
 */
export function inlineSourceMapOf(moduleText: string): string | null {
  MAP_URL_RE.lastIndex = 0;
  let last: string | null = null;
  for (;;) {
    const m = MAP_URL_RE.exec(moduleText);
    if (!m) break;
    last = m[1];
  }
  if (!last || !last.startsWith("data:")) return null;
  const comma = last.indexOf(",");
  if (comma < 0) return null;
  const meta = last.slice(0, comma);
  const payload = last.slice(comma + 1);
  if (!/;base64$/i.test(meta)) {
    try {
      return decodeURIComponent(payload);
    } catch {
      return null;
    }
  }
  try {
    // `atob` yields one char per byte; the JSON is UTF-8 and sourcesContent is
    // full of prose, so it has to go back through a decoder to stay readable.
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
