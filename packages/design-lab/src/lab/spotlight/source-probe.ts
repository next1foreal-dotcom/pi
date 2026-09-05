export interface SourceRef {
  file: string;
  line: number;
  col: number;
  component: string | null;
}

type Fiber = {
  return?: Fiber | null;
  _debugStack?: unknown;
};

const FIBER_PREFIX = "__reactFiber$";

const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(\S+):(\d+):(\d+)\)?\s*$/;

function fiberOn(el: object): Fiber | null {
  const rec = el as Record<string, unknown>;
  for (const key in rec) {
    if (key.startsWith(FIBER_PREFIX)) {
      const value = rec[key];
      if (value && typeof value === "object") return value as Fiber;
    }
  }
  return null;
}

function fiberFrom(el: Element): Fiber | null {
  let cur: Element | null = el;
  while (cur) {
    const fiber = fiberOn(cur);
    if (fiber) return fiber;
    cur = cur.parentElement;
  }
  return null;
}

function stackText(debugStack: unknown): string | null {
  if (typeof debugStack === "string") return debugStack;
  if (debugStack instanceof Error) return debugStack.stack ?? null;
  if (
    debugStack &&
    typeof debugStack === "object" &&
    "stack" in debugStack &&
    typeof (debugStack as { stack: unknown }).stack === "string"
  ) {
    return (debugStack as { stack: string }).stack;
  }
  return null;
}

function fileFromSpec(spec: string, root?: string): string | null {
  const trimmed = spec.trim();
  let href = trimmed;
  if (root && href.startsWith(root)) href = href.slice(root.length);
  try {
    const url = new URL(href);
    const path = url.pathname.replace(/^\//, "");
    return path || null;
  } catch {
    const path = href.replace(/^\//, "");
    return path.includes("/") || path.endsWith(".tsx") || path.endsWith(".ts")
      ? path
      : null;
  }
}

function parseFrame(
  line: string,
  root?: string,
): (SourceRef & { raw: string }) | null {
  const m = FRAME_RE.exec(line);
  if (!m) return null;
  const name = m[1];
  const spec = m[2];
  const lineNo = Number(m[3]);
  const col = Number(m[4]);
  if (!spec || !Number.isFinite(lineNo) || !Number.isFinite(col)) return null;
  const file = fileFromSpec(spec, root);
  if (!file) return null;
  const component =
    name && name !== spec && !name.startsWith("http") ? name : null;
  return { file, line: lineNo, col, component, raw: file };
}

function inScreens(file: string): boolean {
  return (
    file.startsWith("src/screens/") || file.includes("/src/screens/")
  );
}

function inSrc(file: string): boolean {
  return file.startsWith("src/") || file.includes("/src/");
}

function isViteDep(file: string): boolean {
  return file.includes("node_modules/.vite");
}

function pickFrame(frames: SourceRef[]): SourceRef | null {
  const screen = frames.find((f) => inScreens(f.file) && !isViteDep(f.file));
  if (screen) return screen;
  return frames.find((f) => inSrc(f.file) && !isViteDep(f.file)) ?? null;
}

function framesFrom(fiber: Fiber, root?: string): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set<Fiber>();
  let cur: Fiber | null | undefined = fiber;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const text = stackText(cur._debugStack);
    if (text) {
      for (const line of text.split("\n")) {
        const parsed = parseFrame(line, root);
        if (parsed) out.push(parsed);
      }
    }
    cur = cur.return;
  }
  return out;
}

export function sourceOf(
  el: Element,
  opts?: { root?: string },
): SourceRef | null {
  try {
    const fiber = fiberFrom(el);
    if (!fiber) return null;
    const frames = framesFrom(fiber, opts?.root);
    const picked = pickFrame(frames);
    if (!picked) return null;
    return {
      file: picked.file,
      line: picked.line,
      col: picked.col,
      component: picked.component,
    };
  } catch {
    return null;
  }
}
