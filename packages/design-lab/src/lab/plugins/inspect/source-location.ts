/**
 * DOM node -> the line of JSX that made it.
 *
 * React 19 removed `_debugSource`, the property older inspectors read. What it
 * kept, in dev builds only, is `_debugStack`: an `Error` captured inside
 * `jsxDEV`/`createElement` at the moment the element was created. Its second
 * frame is the JSX tag itself. Observed shape, from a real render under vitest:
 *
 *     Error: react-stack-top-frame
 *         at ...jsxDEV (D:\...\node_modules\react\cjs\react-jsx-dev-runtime.development.js:333:13)
 *         at ProbeCard (D:/.../src/lab/plugins/inspect/probe-fixture.tsx:9:7)
 *         at ...react_stack_bottom_frame (D:\...\node_modules\react-dom\...)
 *
 * So the rule is: walk the frames, throw away everything inside node_modules,
 * and the first frame left is the tag. The function name on that frame is the
 * component that rendered it, not the tag — `ProbeCard` above owns a `<button>`.
 *
 * Two address spaces have to normalise to the same repo-relative path:
 *
 *   - the dev server, where a frame reads `http://localhost:5180/src/x.tsx?t=1`
 *     (vite's root is this package, so `/src` means `packages/design-lab/src`)
 *   - node/vitest, where it reads `D:/repo/packages/design-lab/src/x.tsx`
 *
 * Note `new URL("D:/a/b")` does NOT throw — it parses `d:` as the protocol and
 * hands back `/a/b`, silently eating the drive letter. Parsing specs as URLs is
 * therefore not safe here, and this file does string work instead.
 *
 * ── the line numbers are not in the same space as the path ────────────────
 * Normalising the path is only half of it, and the missing half shipped. The
 * LINE and COLUMN on a browser frame are coordinates in the module vite
 * served, not in the file on disk. The JSX transform expands one tag into a
 * multi-line call, so the drift is not a constant offset — it grows down the
 * file. Measured on a real screen, live:
 *
 *     served module  `_jsxDEV(BrowseRow, …)`      at 108:33   (252 lines long)
 *     source file    `<BrowseRow product={…} />`  at  97:17   (136 lines long)
 *
 * Under vitest none of this shows, because vitest source-maps a stack before
 * anything can read it — which is exactly why every test passed while the
 * browser was reporting numbers nothing else in the repo agreed with: the
 * components index outlined nothing, and the element tools quoted lines that
 * were not the ones a person would edit.
 *
 * So a browser frame is mapped back through the module's own inline source map
 * before it leaves this file, and a frame whose map has not been read yet says
 * so (`source-map-pending`) rather than passing served coordinates off as
 * source ones. Node frames are already in source coordinates and are left
 * alone; `servedModuleUrl` is what tells the two apart, by looking at the
 * scheme the frame actually carries rather than guessing from the environment.
 */

import {
  cachedSourceMap,
  loadSourceMap,
  primeSourceMaps,
} from "../../sourcemap/cache";
import { originalPositionFor } from "../../sourcemap/decode";

/** This package's path from the repo root; the dev server serves it at `/`. */
export const LAB_PACKAGE_DIR = "packages/design-lab";

/** Why a location could not be produced. `null` on success. */
export type SourceProblem =
  | "no-react-fiber"
  | "no-debug-stack"
  | "no-project-source-frame"
  | "source-probe-threw"
  /** Browser frame; its module's map has not been read yet. Ask again. */
  | "source-map-pending"
  /** Browser frame; the module was read and its map cannot place this spot. */
  | "source-map-unavailable";

export type SourceLocation = {
  /** Repo-relative, forward slashes, no query string. Null if unresolved. */
  file: string | null;
  /** In the SOURCE file, never in the module the dev server served. */
  line: number | null;
  column: number | null;
  /** The component that rendered the tag, when the frame names one. */
  component: string | null;
  /**
   * Null when file/line/column are all real. Otherwise why they are not — and
   * on the two `source-map-*` problems `file` and `component` are still real
   * while `line` and `column` are null, because the only honest thing to say
   * about coordinates that could not be mapped is nothing.
   */
  problem: SourceProblem | null;
};

type Fiber = {
  return?: Fiber | null;
  _debugStack?: unknown;
};

const FIBER_PREFIX = "__reactFiber$";

/** `at Name (spec:line:col)` and the nameless `at spec:line:col`. */
const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(\S+):(\d+):(\d+)\)?\s*$/;

/** A function name, possibly dotted (`Object.foo`). Never a path. */
const NAME_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** `packages/<pkg>/src/...` anywhere in an absolute path. */
const IN_PACKAGE_RE = /(?:^|\/)(packages\/[^/]+\/src\/.+)$/;

function unproblematic(problem: SourceProblem): SourceLocation {
  return { file: null, line: null, column: null, component: null, problem };
}

/**
 * A stack frame's file spec -> repo-relative path, or null if it is not a file
 * in this repo's source (vendor code, virtual modules, react internals).
 */
export function normalizeSpec(spec: string): string | null {
  let s = spec.trim();
  if (!s) return null;
  // Windows stacks mix separators: react's own files arrive with backslashes,
  // vite-transformed ones with forward slashes.
  s = s.replace(/\\/g, "/");
  // `?t=1712` (vite's cache buster) and `#hash` are not part of the path.
  s = s.replace(/[?#].*$/, "");
  // scheme://authority -> nothing. Covers http, https and file.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  // `/D:/repo/...` or `D:/repo/...` -> `/repo/...`
  s = s.replace(/^\/?[A-Za-z]:\//, "/");
  // Vendor code is never the answer; `.vite/deps` lives under node_modules too.
  if (s.includes("node_modules")) return null;
  const inPackage = IN_PACKAGE_RE.exec(s);
  if (inPackage?.[1]) return inPackage[1];
  // Dev server: vite's root is this package, so `/src/x` is our `src/x`.
  const bare = s.replace(/^\//, "");
  if (bare.startsWith("src/")) return `${LAB_PACKAGE_DIR}/${bare}`;
  return null;
}

/** A frame served over http(s) is in the dev server's address space. */
const SERVED_RE = /^https?:\/\//i;

/**
 * The URL to fetch to read this frame's source map, or null when the frame is
 * already in source coordinates.
 *
 * The query string is KEPT. `?t=1712` identifies which version of the module
 * these coordinates belong to; dropping it would let a hot-updated file's map
 * be used for numbers taken from the version before it.
 */
export function servedModuleUrl(spec: string): string | null {
  const s = spec.trim().replace(/\\/g, "/");
  if (!SERVED_RE.test(s)) return null;
  return s.replace(/#.*$/, "");
}

export type StackFrame = {
  file: string;
  /** As the frame reported it: source coordinates only if `moduleUrl` is null. */
  line: number;
  column: number;
  component: string | null;
  /** Set when the frame came from the dev server and needs mapping back. */
  moduleUrl: string | null;
};

/** One `at ...` line -> a repo-relative frame, or null to skip it. */
export function parseFrame(text: string): StackFrame | null {
  const m = FRAME_RE.exec(text);
  if (!m) return null;
  const [, rawName, spec, rawLine, rawCol] = m;
  if (!spec) return null;
  const line = Number(rawLine);
  const column = Number(rawCol);
  if (!Number.isFinite(line) || !Number.isFinite(column)) return null;
  const file = normalizeSpec(spec);
  if (!file) return null;
  const component = rawName && NAME_RE.test(rawName) ? rawName : null;
  return { file, line, column, component, moduleUrl: servedModuleUrl(spec) };
}

/** Last path segment, query and hash removed. */
function baseName(spec: string): string {
  const clean = spec.replace(/\\/g, "/").replace(/[?#].*$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/**
 * A frame -> a location in the coordinates of the file on disk.
 *
 * Node frames pass straight through. Browser frames are mapped, and when they
 * cannot be they lose their line and column rather than keeping numbers that
 * would read as source ones. `problem` is the only place that distinction is
 * recorded, so callers that ignore it get nothing rather than a lie.
 */
export function resolveFrame(frame: StackFrame): SourceLocation {
  const known = { file: frame.file, component: frame.component };
  if (!frame.moduleUrl) {
    return { ...known, line: frame.line, column: frame.column, problem: null };
  }
  const map = cachedSourceMap(frame.moduleUrl);
  if (map === undefined) {
    // Nobody has read this module yet. Start, and say the answer is not ready.
    void loadSourceMap(frame.moduleUrl);
    return { ...known, line: null, column: null, problem: "source-map-pending" };
  }
  const unavailable: SourceLocation = {
    ...known,
    line: null,
    column: null,
    problem: "source-map-unavailable",
  };
  if (!map) return unavailable;
  const at = originalPositionFor(map, frame.line, frame.column);
  if (!at || at.source === null) return unavailable;
  // A map with several sources could place this in a file other than the one
  // the frame names, and then the path and the line would describe different
  // files. Vite's dev maps carry one source; anything else is not answered.
  if (baseName(at.source) !== baseName(frame.moduleUrl)) return unavailable;
  return { ...known, line: at.line, column: at.column, problem: null };
}

/** `_debugStack` is an Error in practice, but has been a string historically. */
function stackText(debugStack: unknown): string | null {
  if (typeof debugStack === "string") return debugStack;
  if (debugStack instanceof Error) return debugStack.stack ?? null;
  if (debugStack && typeof debugStack === "object") {
    const { stack } = debugStack as { stack?: unknown };
    if (typeof stack === "string") return stack;
  }
  return null;
}

/** The fiber React hung on this exact node. Does not climb the DOM: another
 * element's location is not this element's location. */
export function fiberOf(el: Element): Fiber | null {
  const bag = el as unknown as Record<string, unknown>;
  for (const key in bag) {
    if (!key.startsWith(FIBER_PREFIX)) continue;
    const value = bag[key];
    if (value && typeof value === "object") return value as Fiber;
  }
  return null;
}

type FrameLookup =
  | { frame: StackFrame; problem: null }
  | { frame: null; problem: SourceProblem };

/** The one frame that is this element's own. Parsing only; nothing is fetched. */
function frameFor(el: Element): FrameLookup {
  const fiber = fiberOf(el);
  if (!fiber) return { frame: null, problem: "no-react-fiber" };
  let sawStack = false;
  const seen = new Set<Fiber>();
  let cur: Fiber | null | undefined = fiber;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const text = stackText(cur._debugStack);
    if (text) {
      sawStack = true;
      for (const raw of text.split("\n")) {
        const frame = parseFrame(raw);
        if (frame) return { frame, problem: null };
      }
    }
    cur = cur.return;
  }
  return {
    frame: null,
    problem: sawStack ? "no-project-source-frame" : "no-debug-stack",
  };
}

/**
 * The JSX that produced `el`. Never throws and never guesses: when it cannot
 * answer it says which way it failed, so a caller can tell "React is in
 * production mode" apart from "this node was not made by React".
 *
 * Synchronous, and it has to be: a repaint calls it (`spotlight/pick.ts`), a
 * pointerdown handler calls it, and an agent reaches it through a one-shot
 * expression evaluated in the page. Reading a source map is not synchronous,
 * so in the browser this answers from `sourcemap/cache` and starts the read on
 * a miss — the miss is reported as `source-map-pending` and the next call
 * answers. `primeSourceLocations` is how a caller avoids ever seeing one.
 */
export function locateElement(el: Element): SourceLocation {
  try {
    const found = frameFor(el);
    return found.frame ? resolveFrame(found.frame) : unproblematic(found.problem);
  } catch {
    return unproblematic("source-probe-threw");
  }
}

/**
 * `locateElement`, but it waits for the map instead of reporting a pending
 * one. For callers that are already asynchronous — there is no reason for
 * those to see a half answer.
 */
export async function locateElementSourced(el: Element): Promise<SourceLocation> {
  let found: FrameLookup;
  try {
    found = frameFor(el);
  } catch {
    return unproblematic("source-probe-threw");
  }
  if (!found.frame) return unproblematic(found.problem);
  try {
    if (found.frame.moduleUrl) await loadSourceMap(found.frame.moduleUrl);
    return resolveFrame(found.frame);
  } catch {
    return unproblematic("source-probe-threw");
  }
}

/** A place in a source file, in the coordinates `locateElement` reports. */
export type SourceTarget = {
  file: string;
  line: number;
  column: number;
};

/**
 * The element under `root` that the JSX at `target` produced — `locateElement`
 * run backwards.
 *
 * All three numbers have to agree. File and line alone would answer with
 * whichever of two tags sharing a line came first, and being off by one tag is
 * the failure nobody notices: the panel would go on describing "the element",
 * and the next edit would land on a different one.
 *
 * One JSX tag can make several nodes (a `.map()` over a list). They are
 * indistinguishable here by construction — same file, same line, same column —
 * and that is not a coincidence to paper over: they are the same source handle,
 * so an edit through any of them writes exactly the same bytes. The first in
 * document order is returned, and the only thing that choice decides is which
 * twin wears the outline.
 *
 * `accept` is asked only about nodes that already matched the position, so a
 * caller can add a condition of its own without reimplementing the lookup.
 * `locate` is a seam for tests.
 */
export function findBySourceLocation(
  root: ParentNode,
  target: SourceTarget,
  opts: {
    accept?: (el: Element) => boolean;
    locate?: (el: Element) => SourceLocation;
  } = {},
): Element | null {
  const locate = opts.locate ?? locateElement;
  // Indexed, not for..of: this package's lib is ES2023+DOM without
  // DOM.Iterable, so iterating a NodeList is a type error here.
  const all = root.querySelectorAll("*");
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i];
    // A node that has left the document is not somewhere he can be shown.
    if (!el.isConnected) continue;
    const loc = locate(el);
    // A half answer is not a match: `source-map-pending` carries a real file
    // and null coordinates, and null equals null.
    if (loc.problem !== null) continue;
    if (loc.file !== target.file) continue;
    if (loc.line !== target.line) continue;
    if (loc.column !== target.column) continue;
    if (opts.accept && !opts.accept(el)) continue;
    return el;
  }
  return null;
}

/**
 * Every served module the fibers under `root` name, one per fiber, matching
 * exactly the frames a later lookup will choose. Parsing only; no fetches.
 */
export function servedModulesUnder(root: ParentNode): string[] {
  const urls = new Set<string>();
  const seen = new Set<Fiber>();
  // .forEach, not for..of: this package's lib is ES2023+DOM without
  // DOM.Iterable, so iterating a NodeList is a type error here.
  root.querySelectorAll("*").forEach((el) => {
    let cur: Fiber | null | undefined = fiberOf(el);
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const text = stackText(cur._debugStack);
      if (text) {
        for (const raw of text.split("\n")) {
          const frame = parseFrame(raw);
          if (!frame) continue;
          if (frame.moduleUrl) urls.add(frame.moduleUrl);
          break;
        }
      }
      cur = cur.return;
    }
  });
  const out: string[] = [];
  urls.forEach((url) => out.push(url));
  return out;
}

/**
 * Read every map the live tree needs, so that the synchronous lookups which
 * follow are cache hits. Cheap to call again: modules already read are skipped.
 */
export function primeSourceLocations(root: ParentNode): Promise<void> {
  try {
    return primeSourceMaps(servedModulesUnder(root));
  } catch {
    return Promise.resolve();
  }
}
