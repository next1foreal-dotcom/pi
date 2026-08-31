import type { Camera } from "./types";
import { luminance, viewportPageBounds } from "./math";

export function paintPixelGrid(
  canvas: HTMLCanvasElement,
  camera: Camera,
  viewport: { width: number; height: number },
  opts: { step: number; alpha: number; canvasHex: string },
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

  const screenPeriod = opts.step * camera.z;
  if (screenPeriod < 8) return;

  const alpha = opts.alpha * Math.min(1, (screenPeriod - 8) / 8);
  const dark = luminance(opts.canvasHex) < 0.5;
  ctx.strokeStyle = dark
    ? `rgba(255,255,255,${alpha})`
    : `rgba(0,0,0,${alpha})`;
  ctx.lineWidth = 1;

  const page = viewportPageBounds(camera, viewport);
  const startX = Math.floor(page.x / opts.step) * opts.step;
  const startY = Math.floor(page.y / opts.step) * opts.step;
  const endX = page.x + page.width;
  const endY = page.y + page.height;

  ctx.beginPath();
  for (let x = startX; x <= endX; x += opts.step) {
    const sx = (x + camera.x) * camera.z + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
  }
  for (let y = startY; y <= endY; y += opts.step) {
    const sy = (y + camera.y) * camera.z + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
  }
  ctx.stroke();
}
