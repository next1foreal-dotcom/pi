import type { Rect } from "./types";

export type SnapGuide = { axis: "x" | "y"; pos: number };

export type SnapLine = { axis: "x" | "y"; pos: number };

export type SnapResult = {
  x: number;
  y: number;
  lines: SnapLine[];
};

type Edges = { start: number; mid: number; end: number };

function edgesX(b: Rect): Edges {
  return { start: b.x, mid: b.x + b.width / 2, end: b.x + b.width };
}

function edgesY(b: Rect): Edges {
  return { start: b.y, mid: b.y + b.height / 2, end: b.y + b.height };
}

function snapAxis(
  moving: Edges,
  others: Edges[],
  guidePositions: number[],
  tolerance: number,
): { delta: number; pos: number | null } {
  let best = tolerance + 1;
  let delta = 0;
  let pos: number | null = null;
  const src = [moving.start, moving.mid, moving.end];
  const dst = [
    ...others.flatMap((o) => [o.start, o.mid, o.end]),
    ...guidePositions,
  ];
  for (const s of src) {
    for (const d of dst) {
      const dist = Math.abs(s - d);
      if (dist <= tolerance && dist < best) {
        best = dist;
        delta = d - s;
        pos = d;
      }
    }
  }
  return { delta, pos };
}

export function snapMovingBox(
  moving: Rect,
  others: readonly Rect[],
  guides: readonly SnapGuide[],
  tolerance: number,
  pixelGrid: boolean,
  bypass: boolean,
): SnapResult {
  if (bypass) {
    return { x: moving.x, y: moving.y, lines: [] };
  }
  const xSnap = snapAxis(
    edgesX(moving),
    others.map(edgesX),
    guides.filter((g) => g.axis === "x").map((g) => g.pos),
    tolerance,
  );
  const ySnap = snapAxis(
    edgesY(moving),
    others.map(edgesY),
    guides.filter((g) => g.axis === "y").map((g) => g.pos),
    tolerance,
  );
  let x = moving.x + (xSnap.pos != null ? xSnap.delta : 0);
  let y = moving.y + (ySnap.pos != null ? ySnap.delta : 0);
  if (pixelGrid) {
    if (xSnap.pos == null) x = Math.round(x);
    if (ySnap.pos == null) y = Math.round(y);
  }
  const lines: SnapLine[] = [];
  if (xSnap.pos != null) lines.push({ axis: "x", pos: xSnap.pos });
  if (ySnap.pos != null) lines.push({ axis: "y", pos: ySnap.pos });
  return { x, y, lines };
}

export function snapResize(
  box: Rect,
  pixelGrid: boolean,
  bypass: boolean,
): Rect {
  if (bypass || !pixelGrid) return box;
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.max(1, Math.round(box.width)),
    height: Math.max(1, Math.round(box.height)),
  };
}
