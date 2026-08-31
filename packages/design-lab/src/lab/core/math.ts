import type { Camera, Point, Rect } from "./types";

export const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4] as const;
export const INTERACTIVE_Z_MIN = ZOOM_STEPS[0];
export const INTERACTIVE_Z_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
export const FIT_Z_MIN = 0.02;
export const FIT_Z_MAX = 1;

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function toDomPrecision(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function screenToPage(
  screen: Point,
  camera: Camera,
  origin: Point,
): Point {
  return {
    x: (screen.x - origin.x) / camera.z - camera.x,
    y: (screen.y - origin.y) / camera.z - camera.y,
  };
}

export function pageToScreen(page: Point, camera: Camera, origin: Point): Point {
  return {
    x: (page.x + camera.x) * camera.z + origin.x,
    y: (page.y + camera.y) * camera.z + origin.y,
  };
}

/** Zoom so the screen-space point `p` (canvas-local) stays fixed. */
export function zoomAt(camera: Camera, p: Point, z2: number): Camera {
  return {
    x: camera.x + p.x / z2 - p.x / camera.z,
    y: camera.y + p.y / z2 - p.y / camera.z,
    z: z2,
  };
}

export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return {
    x: camera.x + dx / camera.z,
    y: camera.y + dy / camera.z,
    z: camera.z,
  };
}

export function pageAtViewportCenter(
  camera: Camera,
  viewport: { width: number; height: number },
): Point {
  return {
    x: viewport.width / 2 / camera.z - camera.x,
    y: viewport.height / 2 / camera.z - camera.y,
  };
}

export function cameraCentering(
  page: Point,
  z: number,
  viewport: { width: number; height: number },
): Camera {
  return {
    x: viewport.width / 2 / z - page.x,
    y: viewport.height / 2 / z - page.y,
    z,
  };
}

export function nextZoomStep(z: number, direction: 1 | -1): number {
  if (direction > 0) {
    for (const step of ZOOM_STEPS) {
      if (step > z + 1e-6) return step;
    }
    return INTERACTIVE_Z_MAX;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const step = ZOOM_STEPS[i];
    if (step < z - 1e-6) return step;
  }
  return INTERACTIVE_Z_MIN;
}

export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Fit never zooms past 100%; floor 0.02 sits below the gesture min 0.05. */
export function zoomToBounds(
  bounds: Rect,
  viewport: { width: number; height: number },
): Camera {
  const inset = Math.min(96, viewport.width * 0.28);
  const z = clamp(
    Math.min(
      (viewport.width - inset * 2) / Math.max(bounds.width, 1),
      (viewport.height - inset * 2) / Math.max(bounds.height, 1),
    ),
    FIT_Z_MIN,
    FIT_Z_MAX,
  );
  return cameraCentering(
    { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    z,
    viewport,
  );
}

export function cameraTransform(camera: Camera): string {
  const x = toDomPrecision(camera.x);
  const y = toDomPrecision(camera.y);
  const z = toDomPrecision(camera.z);
  if (z === 1) return `translate(${x}px, ${y}px)`;
  return `scale(${z}) translate(${x}px, ${y}px)`;
}

export function snapTranslateToDevicePixels(
  camera: Camera,
  dpr: number,
): Camera {
  const sx = camera.x * camera.z;
  const sy = camera.y * camera.z;
  const snappedX = Math.round(sx * dpr) / dpr;
  const snappedY = Math.round(sy * dpr) / dpr;
  return {
    x: snappedX / camera.z,
    y: snappedY / camera.z,
    z: camera.z,
  };
}

export function easeOutQuint(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u * u * u;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function expandRect(r: Rect, margin: number): Rect {
  return {
    x: r.x - margin,
    y: r.y - margin,
    width: r.width + margin * 2,
    height: r.height + margin * 2,
  };
}

export function viewportPageBounds(
  camera: Camera,
  viewport: { width: number; height: number },
): Rect {
  const x = -camera.x;
  const y = -camera.y;
  return {
    x,
    y,
    width: viewport.width / camera.z,
    height: viewport.height / camera.z,
  };
}

/** Smallest 1/2/5 × 10^n whose screen span is ≥ minScreenPx (d3 tick shape). */
export function niceTick(minPage: number): number {
  if (!(minPage > 0) || !Number.isFinite(minPage)) return 1;
  const power = 10 ** Math.floor(Math.log10(minPage));
  const error = minPage / power;
  const e10 = Math.sqrt(50);
  const e5 = Math.sqrt(10);
  const e2 = Math.sqrt(2);
  if (error <= e2) return power;
  if (error <= e5) return 2 * power;
  if (error <= e10) return 5 * power;
  return 10 * power;
}

export function formatPageUnits(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

export function luminance(hex: string): number {
  const c = parseHex(hex);
  if (!c) return 1;
  return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}

export function parseHex(
  hex: string,
): { r: number; g: number; b: number } | null {
  const raw = hex.trim().replace(/^#/, "");
  if (raw.length === 3) {
    const r = Number.parseInt(raw[0] + raw[0], 16);
    const g = Number.parseInt(raw[1] + raw[1], 16);
    const b = Number.parseInt(raw[2] + raw[2], 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r, g, b };
  }
  if (raw.length === 6) {
    const r = Number.parseInt(raw.slice(0, 2), 16);
    const g = Number.parseInt(raw.slice(2, 4), 16);
    const b = Number.parseInt(raw.slice(4, 6), 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r, g, b };
  }
  return null;
}

export function normalizeHex(input: string): string | null {
  const c = parseHex(input);
  if (!c) return null;
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.hasAttribute("contenteditable")) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
