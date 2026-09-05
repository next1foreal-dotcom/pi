/**
 * Canvas-true rulers & guides for the Interaction Lab.
 *
 * Reference UX (viewport rulers): github.com/timothymaarv/ruler-mode @ f5fa50b —
 * no LICENSE file; read for mechanism, do not vendor.
 * This module is NOT that overlay: ticks and guides are page units, rendered
 * in screen space at `(pos + camera) * z` so they stay glued to canvas content.
 */

import type { Camera, Point } from "./types";
import { clamp, niceTick } from "./math";

export type GuideAxis = "x" | "y";

export type Guide = {
  id: number;
  axis: GuideAxis;
  pos: number;
};

const RULER = 20;
const HIT = 4;
const STORAGE_KEY = "interaction-lab:guides:v1";

type Theme = {
  rulerBg: string;
  rulerBorder: string;
  tick: string;
  tickLabel: string;
  guide: string;
  guideActive: string;
};

const LIGHT: Theme = {
  rulerBg: "#ffffff",
  rulerBorder: "rgba(0, 0, 0, 0.12)",
  tick: "#d4d4d4",
  tickLabel: "#9b9b9b",
  guide: "#f24822",
  guideActive: "#0c8ce9",
};

const DARK: Theme = {
  rulerBg: "#2c2c2c",
  rulerBorder: "rgba(255, 255, 255, 0.13)",
  tick: "#4f4f4f",
  tickLabel: "#8c8c8c",
  guide: "#f24822",
  guideActive: "#0c8ce9",
};

export type RulerDeps = {
  host: HTMLElement;
  getCamera: () => Camera;
  getOrigin: () => Point;
  getViewport: () => { width: number; height: number };
  getAppearance: () => "light" | "dark";
};

export class CanvasRuler {
  private deps: RulerDeps;
  private root: HTMLDivElement;
  private top: HTMLCanvasElement;
  private left: HTMLCanvasElement;
  private guidesLayer: HTMLDivElement;
  private badge: HTMLDivElement;
  private guides: Guide[] = [];
  private els = new Map<number, HTMLDivElement>();
  private nextId = 1;
  private selectedId: number | null = null;
  private enabled = false;
  private hidden = false;
  private saveTimer = 0;
  private raf = 0;

  constructor(deps: RulerDeps) {
    this.deps = deps;
    this.root = document.createElement("div");
    this.root.className = "lab-ruler-root";
    this.root.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:9";
    this.root.style.display = "none";

    this.guidesLayer = document.createElement("div");
    this.guidesLayer.style.cssText = "position:absolute;inset:0;pointer-events:none";

    this.top = document.createElement("canvas");
    this.left = document.createElement("canvas");
    this.top.style.cssText =
      "position:absolute;top:0;left:0;pointer-events:auto;touch-action:none";
    this.left.style.cssText =
      "position:absolute;top:0;left:0;pointer-events:auto;touch-action:none";

    this.top.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const page = this.clientToPage(e.clientX, e.clientY);
      this.beginDrag(e, this.insert("y", page.y));
    });
    this.left.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const page = this.clientToPage(e.clientX, e.clientY);
      this.beginDrag(e, this.insert("x", page.x));
    });

    const corner = document.createElement("div");
    corner.style.cssText = `position:absolute;top:0;left:0;width:${RULER}px;height:${RULER}px;pointer-events:auto`;

    this.badge = document.createElement("div");
    this.badge.style.cssText =
      "position:absolute;top:0;left:0;display:none;pointer-events:none;background:#f24822;color:#fff;font:500 10px/1 Inter,system-ui,sans-serif;padding:3px 5px;border-radius:3px";

    this.root.append(this.guidesLayer, this.top, this.left, corner, this.badge);
    deps.host.appendChild(this.root);
    this.load();
  }

  getGuides(): Guide[] {
    if (!this.enabled) return [];
    return this.guides.map((g) => ({ ...g }));
  }

  handleKey(e: KeyboardEvent): boolean {
    const isR = e.code === "KeyR" || e.key.toLowerCase() === "r";
    if (isR && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (this.enabled) this.setHidden(!this.hidden);
      return true;
    }
    if (isR && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.toggle();
      return true;
    }
    if (!this.enabled || this.hidden || this.selectedId == null) return false;
    const g = this.guides.find((x) => x.id === this.selectedId);
    if (!g) return false;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.remove(g.id);
      return true;
    }
    if (e.key === "Escape") {
      this.select(null);
      return true;
    }
    const step = e.shiftKey ? 10 : 1;
    let delta = 0;
    if (g.axis === "x" && e.key === "ArrowLeft") delta = -step;
    else if (g.axis === "x" && e.key === "ArrowRight") delta = step;
    else if (g.axis === "y" && e.key === "ArrowUp") delta = -step;
    else if (g.axis === "y" && e.key === "ArrowDown") delta = step;
    if (delta === 0) return false;
    e.preventDefault();
    g.pos += delta;
    this.positionEl(g);
    this.refresh();
    this.commit();
    return true;
  }

  refresh(): void {
    if (!this.enabled || this.hidden) return;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
      for (const g of this.guides) this.positionEl(g);
    });
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    window.clearTimeout(this.saveTimer);
    this.root.remove();
  }

  /** Are the rulers on? Chrome that shows tool state has to be able to read it. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** On, but hidden by Ctrl+Shift+R. */
  isHidden(): boolean {
    return this.enabled && this.hidden;
  }

  /** Rulers on/off — the code path for Shift+R. */
  toggle(): void {
    if (this.enabled) {
      this.enabled = false;
      this.root.style.display = "none";
      this.select(null);
      return;
    }
    this.enabled = true;
    this.hidden = false;
    this.root.style.display = "block";
    this.draw();
    for (const g of this.guides) this.positionEl(g);
  }

  /** Hide while staying in ruler mode — Ctrl+Shift+R. No-op when off. */
  setHidden(hidden: boolean): void {
    if (!this.enabled) return;
    this.hidden = hidden;
    this.root.style.display = hidden ? "none" : "block";
    if (!hidden) this.refresh();
  }

  /** Turn rulers on if they are off. */
  enable(): void {
    if (!this.enabled) this.toggle();
  }

  /** Turn rulers off if they are on. */
  disable(): void {
    if (this.enabled) this.toggle();
  }

  /**
   * Place a guide at a page coordinate — what dragging out of a ruler does,
   * without the hand. Allowed while rulers are off (the guide is waiting when
   * you turn them on); `getGuides` still reports only while enabled, so frame
   * snapping behaves exactly as before.
   */
  addGuide(axis: GuideAxis, pos: number): Guide {
    const g = this.insert(axis, pos);
    this.positionEl(g);
    this.draw();
    this.commit();
    return g;
  }

  /** Remove one guide by id. */
  removeGuide(id: number): void {
    this.remove(id);
  }

  /** Remove every guide. */
  clearGuides(): void {
    for (const g of [...this.guides]) this.remove(g.id);
  }

  private theme(): Theme {
    return this.deps.getAppearance() === "dark" ? DARK : LIGHT;
  }

  private clientToPage(clientX: number, clientY: number): Point {
    const origin = this.deps.getOrigin();
    const cam = this.deps.getCamera();
    return {
      x: (clientX - origin.x) / cam.z - cam.x,
      y: (clientY - origin.y) / cam.z - cam.y,
    };
  }

  private pageToScreen(page: Point): Point {
    const cam = this.deps.getCamera();
    return {
      x: (page.x + cam.x) * cam.z,
      y: (page.y + cam.y) * cam.z,
    };
  }

  private insert(axis: GuideAxis, pos: number): Guide {
    const g: Guide = { id: this.nextId++, axis, pos };
    this.guides.push(g);
    this.mount(g);
    return g;
  }

  private mount(g: Guide): void {
    const el = document.createElement("div");
    el.style.cssText =
      g.axis === "x"
        ? `position:absolute;top:0;height:100%;width:${HIT * 2 + 1}px;pointer-events:auto;touch-action:none;cursor:ew-resize`
        : `position:absolute;left:0;width:100%;height:${HIT * 2 + 1}px;pointer-events:auto;touch-action:none;cursor:ns-resize`;
    const line = document.createElement("div");
    line.style.cssText =
      g.axis === "x"
        ? `position:absolute;left:${HIT}px;top:0;width:1px;height:100%;background:var(--lab-ruler-guide,#f24822)`
        : `position:absolute;top:${HIT}px;left:0;height:1px;width:100%;background:var(--lab-ruler-guide,#f24822)`;
    el.appendChild(line);
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const current = this.guides.find((x) => x.id === g.id);
      if (!current) return;
      const target = e.altKey
        ? this.insert(current.axis, current.pos)
        : current;
      this.beginDrag(e, target);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.remove(g.id);
    });
    this.guidesLayer.appendChild(el);
    this.els.set(g.id, el);
    this.positionEl(g);
  }

  private positionEl(g: Guide): void {
    const el = this.els.get(g.id);
    if (!el) return;
    const s = this.pageToScreen({ x: g.pos, y: g.pos });
    el.style.transform =
      g.axis === "x"
        ? `translate3d(${s.x - HIT}px,0,0)`
        : `translate3d(0,${s.y - HIT}px,0)`;
    const line = el.firstElementChild;
    if (line instanceof HTMLElement) {
      line.style.background =
        g.id === this.selectedId ? this.theme().guideActive : this.theme().guide;
    }
  }

  private beginDrag(e: PointerEvent, guide: Guide): void {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    this.select(guide.id);
    this.showBadge(e.clientX, e.clientY, guide.pos);

    const onMove = (ev: PointerEvent) => {
      const page = this.clientToPage(ev.clientX, ev.clientY);
      guide.pos = guide.axis === "x" ? page.x : page.y;
      this.positionEl(guide);
      this.draw();
      this.showBadge(ev.clientX, ev.clientY, guide.pos);
    };
    const onEnd = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onEnd);
      this.badge.style.display = "none";
      const origin = this.deps.getOrigin();
      const screen =
        guide.axis === "x" ? ev.clientX - origin.x : ev.clientY - origin.y;
      if (screen <= RULER) this.remove(guide.id);
      else this.commit();
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onEnd);
  }

  private remove(id: number): void {
    this.guides = this.guides.filter((g) => g.id !== id);
    this.els.get(id)?.remove();
    this.els.delete(id);
    if (this.selectedId === id) this.selectedId = null;
    this.draw();
    this.commit();
  }

  private select(id: number | null): void {
    this.selectedId = id;
    this.draw();
    for (const g of this.guides) this.positionEl(g);
  }

  private showBadge(x: number, y: number, value: number): void {
    const vp = this.deps.getViewport();
    this.badge.style.display = "block";
    this.badge.textContent = String(Math.round(value * 100) / 100);
    const bx = clamp(x - this.deps.getOrigin().x + 12, RULER + 2, vp.width - 52);
    const by = clamp(y - this.deps.getOrigin().y + 16, RULER + 2, vp.height - 26);
    this.badge.style.transform = `translate3d(${bx}px,${by}px,0)`;
  }

  private draw(): void {
    const t = this.theme();
    const cam = this.deps.getCamera();
    const vp = this.deps.getViewport();
    this.root.style.setProperty("--lab-ruler-guide", t.guide);
    this.drawAxis("x", this.top, vp.width, RULER, t, cam, vp);
    this.drawAxis("y", this.left, RULER, vp.height, t, cam, vp);
    const corner = this.root.children[3];
    if (corner instanceof HTMLElement) {
      corner.style.background = t.rulerBg;
      corner.style.boxShadow = `inset -1px -1px 0 ${t.rulerBorder}`;
    }
  }

  private drawAxis(
    axis: GuideAxis,
    canvas: HTMLCanvasElement,
    cssW: number,
    cssH: number,
    t: Theme,
    cam: Camera,
    vp: { width: number; height: number },
  ): void {
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = t.rulerBg;
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.strokeStyle = t.rulerBorder;
    ctx.beginPath();
    if (axis === "x") {
      ctx.moveTo(0, RULER - 0.5);
      ctx.lineTo(cssW, RULER - 0.5);
    } else {
      ctx.moveTo(RULER - 0.5, 0);
      ctx.lineTo(RULER - 0.5, cssH);
    }
    ctx.stroke();

    const step = niceTick(56 / cam.z);
    const pageStart = axis === "x" ? -cam.x : -cam.y;
    const pageEnd =
      axis === "x" ? -cam.x + vp.width / cam.z : -cam.y + vp.height / cam.z;
    const first = Math.floor(pageStart / step) * step;
    ctx.strokeStyle = t.tick;
    ctx.fillStyle = t.tickLabel;
    ctx.font = "9px Inter, system-ui, sans-serif";
    ctx.beginPath();
    for (let p = first; p <= pageEnd + step; p += step) {
      const s = axis === "x" ? (p + cam.x) * cam.z : (p + cam.y) * cam.z;
      if (axis === "x") {
        ctx.moveTo(s + 0.5, RULER - 7);
        ctx.lineTo(s + 0.5, RULER);
      } else {
        ctx.moveTo(RULER - 7, s + 0.5);
        ctx.lineTo(RULER, s + 0.5);
      }
    }
    ctx.stroke();
    for (let p = first; p <= pageEnd + step; p += step) {
      const s = axis === "x" ? (p + cam.x) * cam.z : (p + cam.y) * cam.z;
      const label = String(Math.round(p * 100) / 100);
      if (axis === "x") ctx.fillText(label, s + 4, 9);
      else {
        ctx.save();
        ctx.translate(9, s - 4);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }

    for (const g of this.guides) {
      if (g.axis !== axis) continue;
      const s = this.pageToScreen({ x: g.pos, y: g.pos });
      const at = (axis === "x" ? s.x : s.y) + 0.5;
      ctx.strokeStyle = g.id === this.selectedId ? t.guideActive : t.guide;
      ctx.beginPath();
      if (axis === "x") {
        ctx.moveTo(at, 0);
        ctx.lineTo(at, RULER);
      } else {
        ctx.moveTo(0, at);
        ctx.lineTo(RULER, at);
      }
      ctx.stroke();
    }
  }

  private commit(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            v: 1,
            guides: this.guides.map((g) => ({ a: g.axis, p: g.pos })),
          }),
        );
      } catch {
        // quota
      }
    }, 150);
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { v: number; guides: { a: GuideAxis; p: number }[] };
      if (data.v !== 1 || !Array.isArray(data.guides)) return;
      for (const g of data.guides) {
        if ((g.a === "x" || g.a === "y") && typeof g.p === "number") {
          this.insert(g.a, g.p);
        }
      }
    } catch {
      // corrupt
    }
  }
}
