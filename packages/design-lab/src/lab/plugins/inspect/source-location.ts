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
 */

/** This package's path from the repo root; the dev server serves it at `/`. */
export const LAB_PACKAGE_DIR = "packages/design-lab";

/** Why a location could not be produced. `null` on success. */
export type SourceProblem =
  | "no-react-fiber"
  | "no-debug-stack"
  | "no-project-source-frame"
  | "source-probe-threw";

export type SourceLocation = {
  /** Repo-relative, forward slashes, no query string. Null if unresolved. */
  file: string | null;
  line: number | null;
  column: number | null;
  /** The component that rendered the tag, when the frame names one. */
  component: string | null;
  /** Null when file/line/column are all real. Otherwise why they are not. */
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

export type StackFrame = {
  file: string;
  line: number;
  column: number;
  component: string | null;
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
  return { file, line, column, component };
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

/**
 * The JSX that produced `el`. Never throws and never guesses: when it cannot
 * answer it says which of the four ways it failed, so a caller can tell "React
 * is in production mode" apart from "this node was not made by React".
 */
export function locateElement(el: Element): SourceLocation {
  try {
    const fiber = fiberOf(el);
    if (!fiber) return unproblematic("no-react-fiber");
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
          if (frame) return { ...frame, problem: null };
        }
      }
      cur = cur.return;
    }
    return unproblematic(sawStack ? "no-project-source-frame" : "no-debug-stack");
  } catch {
    return unproblematic("source-probe-threw");
  }
}
