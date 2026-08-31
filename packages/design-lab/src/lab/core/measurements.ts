import { formatPageUnits, pageToScreen } from "./math";
import type { Camera, Rect } from "./types";

/** Verbatim port of Penpot `calculate-distance-lines`. */
export function calculateDistanceLines(
  fromS: number,
  fromE: number,
  toS: number,
  toE: number,
): [number, number][] {
  const ss = toS - fromS;
  const se = toE - fromS;
  const es = toS - fromE;
  const ee = toE - fromE;
  const out: [number, number][] = [];
  if ((ss < 0 && se > 0) || (ss > 0 && ee < 0) || (ss < 0 && ss > se)) {
    out.push([fromS, fromS + ss]);
  }
  if (se < 0 && ss <= se) {
    out.push([fromS, fromS + se]);
  }
  if (es > 0 && es <= ee) {
    out.push([fromE, fromE + es]);
  }
  if ((ee > 0 && es < 0) || (ee < 0 && ss > 0) || (ee > 0 && ee < es)) {
    out.push([fromE, fromE + ee]);
  }
  return out;
}

export function fullyContained(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export type MeasureSeg = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  distance: number;
};

export function measureSegments(from: Rect, to: Rect): MeasureSeg[] {
  const fixedX = fullyContained(from, to)
    ? to.x + to.width / 2
    : from.x + from.width / 2;
  const fixedY = fullyContained(from, to)
    ? to.y + to.height / 2
    : from.y + from.height / 2;
  const segs: MeasureSeg[] = [];
  for (const [a, b] of calculateDistanceLines(
    from.y,
    from.y + from.height,
    to.y,
    to.y + to.height,
  )) {
    segs.push({
      x1: fixedX,
      y1: a,
      x2: fixedX,
      y2: b,
      distance: Math.abs(b - a),
    });
  }
  for (const [a, b] of calculateDistanceLines(
    from.x,
    from.x + from.width,
    to.x,
    to.x + to.width,
  )) {
    segs.push({
      x1: a,
      y1: fixedY,
      x2: b,
      y2: fixedY,
      distance: Math.abs(b - a),
    });
  }
  return segs.filter((s) => s.distance > 0.001);
}

const COLOR = "#f24822";

export function paintMeasurements(
  canvas: HTMLCanvasElement,
  segs: MeasureSeg[],
  selected: Rect | null,
  camera: Camera,
  viewport: { width: number; height: number },
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(viewport.width));
  const h = Math.max(1, Math.round(viewport.height));
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!selected || segs.length === 0) return;

  const toS = (x: number, y: number) => {
    const p = pageToScreen({ x, y }, camera, { x: 0, y: 0 });
    return { x: p.x, y: p.y };
  };

  ctx.lineWidth = 1;
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const seg of segs) {
    const a = toS(seg.x1, seg.y1);
    const b = toS(seg.x2, seg.y2);
    ctx.strokeStyle = COLOR;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    if (selected) {
      const horiz = Math.abs(seg.y1 - seg.y2) < 1e-6;
      if (horiz) {
        const y = seg.y1;
        const misses = y < selected.y - 0.5 || y > selected.y + selected.height + 0.5;
        if (misses) {
          const sx = toS(selected.x + selected.width / 2, selected.y);
          const ex = toS(selected.x + selected.width / 2, selected.y + selected.height);
          const cross = toS(selected.x + selected.width / 2, y);
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(y < selected.y ? sx.x : ex.x, y < selected.y ? sx.y : ex.y);
          ctx.lineTo(cross.x, cross.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else {
        const x = seg.x1;
        const misses = x < selected.x - 0.5 || x > selected.x + selected.width + 0.5;
        if (misses) {
          const sy = toS(selected.x, selected.y + selected.height / 2);
          const ey = toS(selected.x + selected.width, selected.y + selected.height / 2);
          const cross = toS(x, selected.y + selected.height / 2);
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(x < selected.x ? sy.x : ey.x, x < selected.x ? sy.y : ey.y);
          ctx.lineTo(cross.x, cross.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const label = formatPageUnits(seg.distance);
    const tw = ctx.measureText(label).width;
    const pw = tw + 10;
    const ph = 16;
    ctx.fillStyle = COLOR;
    roundRect(ctx, mx - pw / 2, my - ph / 2, pw, ph, 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, mx, my);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

void origin;
