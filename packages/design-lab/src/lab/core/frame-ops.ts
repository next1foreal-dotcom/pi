import type { ScreenLayout } from "./types";
import type { ResizeEdge } from "./screen-frame";

export function applyResize(
  start: ScreenLayout,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  minW: number,
  minH: number,
): ScreenLayout {
  let { x, y, width, height } = start;
  if (edge.includes("e")) width += dx;
  if (edge.includes("w")) {
    x += dx;
    width -= dx;
  }
  if (edge.includes("s")) height += dy;
  if (edge.includes("n")) {
    y += dy;
    height -= dy;
  }
  if (width < minW) {
    if (edge.includes("w")) x -= minW - width;
    width = minW;
  }
  if (height < minH) {
    if (edge.includes("n")) y -= minH - height;
    height = minH;
  }
  return { x, y, width, height };
}

export function cleanupRow(
  layouts: Record<string, ScreenLayout>,
  order: string[],
  gap: number,
): Record<string, ScreenLayout> {
  const next = { ...layouts };
  const ys = order.map((id) => next[id].y);
  const top = Math.min(...ys);
  let x = Math.min(...order.map((id) => next[id].x));
  for (const id of order) {
    const l = next[id];
    next[id] = { ...l, x, y: top };
    x += l.width + gap;
  }
  return next;
}
