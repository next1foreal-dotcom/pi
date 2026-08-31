import { boundsOf, screenToPage, zoomToBounds } from "../core/math";
import type { Camera, Point, Rect } from "../core/types";

/** Grow tiny mutation boxes so zoomToBounds cannot dive into a 2px node. */
export const MIN_SPOTLIGHT_SIZE = 240;

export function isValidRect(r: Rect): boolean {
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    r.width > 0 &&
    r.height > 0
  );
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  return boundsOf(rects.filter(isValidRect));
}

export function resolveSpotlightTarget(
  rects: readonly Rect[],
  fallback: Rect,
): Rect {
  return unionRects(rects) ?? fallback;
}

export function minFrameRect(
  r: Rect,
  minSize: number = MIN_SPOTLIGHT_SIZE,
): Rect {
  const w = Math.max(r.width, minSize);
  const h = Math.max(r.height, minSize);
  return {
    x: r.x - (w - r.width) / 2,
    y: r.y - (h - r.height) / 2,
    width: w,
    height: h,
  };
}

export function spotlightCamera(
  target: Rect,
  viewport: { width: number; height: number },
): Camera {
  return zoomToBounds(minFrameRect(target), viewport);
}

export function clientRectToCanvas(
  rect: { left: number; top: number; right: number; bottom: number },
  camera: Camera,
  origin: Point,
): Rect {
  const tl = screenToPage({ x: rect.left, y: rect.top }, camera, origin);
  const br = screenToPage({ x: rect.right, y: rect.bottom }, camera, origin);
  return {
    x: tl.x,
    y: tl.y,
    width: br.x - tl.x,
    height: br.y - tl.y,
  };
}
