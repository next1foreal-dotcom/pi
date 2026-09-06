/**
 * Live preview as an ordinary canvas object: one iframe per object, sized in
 * PAGE units so a 390-wide copy and a 1280-wide copy keep their own
 * breakpoints while the camera zooms the layer around them.
 */

import type { LabPlugin, LabPluginContext, LabObjects } from "../../plugin-api";
import type { Rect } from "../../core/types";
import { formatEmbedStatus, type EmbedProbeData } from "./embed-status";

export const STORAGE_KEY = "interaction-lab:preview:v1";
export const DEFAULT_WIDTH = 390;
export const DEFAULT_HEIGHT = 844;
const MIN_EDGE = 200;
const SAVE_MS = 150;

export type PreviewRecord = {
  id: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PreviewInsert = {
  url: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
};

type FrameRefs = {
  el: HTMLDivElement;
  iframe: HTMLIFrameElement;
  shield: HTMLDivElement;
  status: HTMLDivElement;
};

const CSS = `
.lp-root{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none}
.lp-frame{position:absolute;top:0;left:0;pointer-events:auto;overflow:hidden;box-sizing:border-box;background:#f1f1f1;border:1px solid #1c1c1c;touch-action:none}
.lp-frame[data-interactive]{outline:2px solid #1c1c1c;outline-offset:1px}
.lp-iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;pointer-events:none;background:transparent}
.lp-frame[data-interactive] .lp-iframe{pointer-events:auto}
.lp-shield{position:absolute;inset:0;z-index:2;background:transparent;cursor:grab;touch-action:none}
.lp-frame[data-interactive] .lp-shield{display:none}
.lp-status{position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:#f1f1f1;color:#1c1c1c;font:500 13px/1.45 Inter,system-ui,sans-serif;text-align:center;white-space:pre-wrap;word-break:break-all;pointer-events:none}
.lp-status[hidden]{display:none!important}
`;

let styleRefs = 0;
let styleEl: HTMLStyleElement | null = null;

function acquireStyles() {
  if (styleRefs++ === 0) {
    for (const el of document.querySelectorAll("style[data-live-preview]")) el.remove();
    styleEl = document.createElement("style");
    styleEl.dataset.livePreview = "";
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }
}

function releaseStyles() {
  if (--styleRefs === 0) {
    styleEl?.remove();
    styleEl = null;
  }
}

function clampSize(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_EDGE, Math.round(n));
}

function asHttpUrl(raw: string): string {
  const url = raw.trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
  } catch {
    // keep the original so the status can show what they typed
  }
  return url;
}

class LivePreviews {
  private objects: LabObjects;
  private storageKey: string | null;
  private embedderOrigin: string;
  private root: HTMLDivElement;
  private items: PreviewRecord[] = [];
  private refs = new Map<string, FrameRefs>();
  private nextN = 1;
  private interactiveId: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private probeSeq = new Map<string, number>();

  constructor(opts: {
    host: HTMLElement;
    objects: LabObjects;
    storageKey?: string | null;
    embedderOrigin?: string;
  }) {
    this.objects = opts.objects;
    this.storageKey =
      opts.storageKey === undefined ? STORAGE_KEY : opts.storageKey;
    this.embedderOrigin = opts.embedderOrigin ?? (typeof location !== "undefined" ? location.origin : "");
    acquireStyles();
    this.root = document.createElement("div");
    this.root.className = "lp-root";
    opts.host.appendChild(this.root);
    document.addEventListener("pointerdown", this.onDocPointerDown, true);
    this.load();
  }

  insert(init: PreviewInsert): { id: string } {
    const step = (this.items.length % 6) * 24;
    const item: PreviewRecord = {
      id: `preview:${this.nextN++}`,
      url: asHttpUrl(init.url ?? ""),
      x: typeof init.x === "number" && Number.isFinite(init.x) ? init.x : step,
      y: typeof init.y === "number" && Number.isFinite(init.y) ? init.y : step,
      width: clampSize(init.width ?? DEFAULT_WIDTH, DEFAULT_WIDTH),
      height: clampSize(init.height ?? DEFAULT_HEIGHT, DEFAULT_HEIGHT),
    };
    this.items.push(item);
    this.mountFrame(item);
    this.registerFrame(item);
    this.objects.select(item.id);
    this.commit();
    void this.probe(item);
    return { id: item.id };
  }

  remove(id: string): void {
    const i = this.items.findIndex((p) => p.id === id);
    if (i === -1) return;
    this.teardown(id);
    this.items.splice(i, 1);
    this.commit();
  }

  list(): PreviewRecord[] {
    return this.items.map((p) => ({ ...p }));
  }

  setViewport(id: string, width: number, height: number): void {
    const item = this.items.find((p) => p.id === id);
    if (!item) return;
    item.width = clampSize(width, item.width);
    item.height = clampSize(height, item.height);
    this.objects.setLayout(id, {
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    });
    this.commit();
  }

  reload(id: string): void {
    const item = this.items.find((p) => p.id === id);
    const rec = this.refs.get(id);
    if (!item || !rec) return;
    rec.iframe.setAttribute("src", item.url);
    void this.probe(item);
  }

  setInteractive(id: string, on: boolean): void {
    const rec = this.refs.get(id);
    if (!rec) return;
    if (on) {
      if (this.interactiveId && this.interactiveId !== id) {
        this.paintInteractive(this.interactiveId, false);
      }
      this.interactiveId = id;
      this.paintInteractive(id, true);
      this.objects.select(id);
    } else {
      this.paintInteractive(id, false);
      if (this.interactiveId === id) this.interactiveId = null;
    }
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.key !== "Escape") return false;
    if (!this.interactiveId) return false;
    this.setInteractive(this.interactiveId, false);
    return true;
  }

  onCameraWrite(): void {
    // The iframe is created once. Camera motion is the lab layer's transform.
  }

  destroy(): void {
    this.closed = true;
    window.clearTimeout(this.saveTimer);
    document.removeEventListener("pointerdown", this.onDocPointerDown, true);
    for (const item of this.items) {
      this.objects.unregister(item.id);
    }
    this.refs.clear();
    this.items = [];
    this.root.remove();
    releaseStyles();
  }

  private paintInteractive(id: string, on: boolean) {
    const rec = this.refs.get(id);
    if (!rec) return;
    rec.el.toggleAttribute("data-interactive", on);
    rec.shield.hidden = on;
  }

  private onDocPointerDown = (e: PointerEvent) => {
    if (!this.interactiveId) return;
    const rec = this.refs.get(this.interactiveId);
    if (!rec) return;
    const t = e.target;
    if (t instanceof Node && rec.el.contains(t)) return;
    this.setInteractive(this.interactiveId, false);
  };

  private mountFrame(item: PreviewRecord) {
    const el = document.createElement("div");
    el.className = "lp-frame";

    const iframe = document.createElement("iframe");
    iframe.className = "lp-iframe";
    iframe.setAttribute("src", item.url);
    iframe.setAttribute("title", item.url);
    iframe.setAttribute("referrerpolicy", "no-referrer");

    const shield = document.createElement("div");
    shield.className = "lp-shield";
    shield.dataset.previewShield = "";
    shield.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.objects.select(item.id);
      if (e.button !== 0) return;
      this.objects.beginMove(e, item.id);
    });
    shield.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.setInteractive(item.id, true);
    });

    const status = document.createElement("div");
    status.className = "lp-status";
    status.dataset.previewStatus = "";
    status.setAttribute("role", "status");
    status.textContent = `正在连接\n${item.url}`;

    el.append(iframe, shield, status);
    this.root.appendChild(el);
    this.refs.set(item.id, { el, iframe, shield, status });
  }

  private registerFrame(item: PreviewRecord) {
    const rec = this.refs.get(item.id);
    if (!rec) return;
    this.objects.register({
      id: item.id,
      el: rec.el,
      rect: { x: item.x, y: item.y, width: item.width, height: item.height },
      minWidth: MIN_EDGE,
      minHeight: MIN_EDGE,
      resizable: true,
      sizing: "lab",
      onLayout: (rect: Rect) => {
        item.x = rect.x;
        item.y = rect.y;
        item.width = rect.width;
        item.height = rect.height;
        this.commit();
      },
      onSelect: (selected) => {
        if (!selected && this.interactiveId === item.id) {
          this.setInteractive(item.id, false);
        }
      },
      duplicate: (rect) => this.duplicate(item, rect),
    });
  }

  private duplicate(source: PreviewRecord, rect: Rect): void {
    this.insert({
      url: source.url,
      width: source.width,
      height: source.height,
      x: rect.x,
      y: rect.y,
    });
  }

  private teardown(id: string) {
    if (this.interactiveId === id) this.interactiveId = null;
    this.objects.unregister(id);
    this.refs.get(id)?.el.remove();
    this.refs.delete(id);
    this.probeSeq.delete(id);
  }

  private paintStatus(item: PreviewRecord, data: EmbedProbeData) {
    const rec = this.refs.get(item.id);
    if (!rec) return;
    const status = formatEmbedStatus(item.url, data, this.embedderOrigin);
    if (status.ok) {
      rec.status.hidden = true;
      rec.status.textContent = "";
      return;
    }
    rec.status.hidden = false;
    rec.status.textContent = status.text ?? `这个地址没人应答\n${item.url}`;
  }

  private async probe(item: PreviewRecord) {
    const seq = (this.probeSeq.get(item.id) ?? 0) + 1;
    this.probeSeq.set(item.id, seq);
    const rec = this.refs.get(item.id);
    if (rec) {
      rec.status.hidden = false;
      rec.status.textContent = `正在连接\n${item.url}`;
    }
    let data: EmbedProbeData = { reachable: false };
    try {
      const res = await fetch("/__lab-fs/preview-probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: item.url }),
      });
      const body = (await res.json()) as EmbedProbeData & { ok?: boolean };
      data = {
        reachable: Boolean(body.reachable),
        xFrameOptions: body.xFrameOptions,
        csp: body.csp,
      };
    } catch {
      data = { reachable: false };
    }
    if (this.closed || this.probeSeq.get(item.id) !== seq) return;
    this.paintStatus(item, data);
  }

  private commit() {
    if (this.closed || !this.storageKey) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), SAVE_MS);
  }

  private persist() {
    if (this.closed || !this.storageKey) return;
    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({
          v: 1,
          items: this.items.map((p) => ({
            u: p.url,
            x: p.x,
            y: p.y,
            w: p.width,
            h: p.height,
          })),
        }),
      );
    } catch {
      // quota / private mode
    }
  }

  private load() {
    if (!this.storageKey) return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const data = JSON.parse(raw) as {
        v: number;
        items: { u?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown }[];
      };
      if (data.v !== 1 || !Array.isArray(data.items)) return;
      for (const row of data.items) {
        if (typeof row.u !== "string") continue;
        if (typeof row.x !== "number" || typeof row.y !== "number") continue;
        const item: PreviewRecord = {
          id: `preview:${this.nextN++}`,
          url: asHttpUrl(row.u),
          x: row.x,
          y: row.y,
          width: clampSize(typeof row.w === "number" ? row.w : DEFAULT_WIDTH, DEFAULT_WIDTH),
          height: clampSize(typeof row.h === "number" ? row.h : DEFAULT_HEIGHT, DEFAULT_HEIGHT),
        };
        this.items.push(item);
        this.mountFrame(item);
        this.registerFrame(item);
        void this.probe(item);
      }
    } catch {
      // corrupt
    }
  }
}

export const plugin: LabPlugin = {
  id: "preview",
  order: 50,
  hostSelector: "[data-lab-layer]",
  describe: [
    {
      name: "insert",
      signature:
        "insert(init: { url: string; width?: number; height?: number; x?: number; y?: number }): { id: string }",
      summary:
        "Place a live iframe of `url` as a canvas object. x/y/width/height are PAGE units, not screen pixels — they do not change when the canvas zooms. x/y default to a small cascade near the page origin, NOT the viewport centre; pass them or it lands off-screen. `width` is the iframe's layout viewport (the thing CSS breakpoints see), default 390. Cross-origin pages cannot have their DOM read; this is the browser's rule, and this API does not pretend otherwise.",
    },
    {
      name: "remove",
      signature: "remove(id: string): void",
      summary: "Destroy one preview. Unknown ids are a no-op. The iframe is gone; there is no undo of the creation itself (same as a duplicated sticky).",
    },
    {
      name: "list",
      signature:
        "list(): { id: string; url: string; width: number; height: number; x: number; y: number }[]",
      summary:
        "Every preview with its url, PAGE-unit viewport (width/height) and PAGE-unit position. Width is the layout viewport, not the zoomed on-screen size.",
    },
    {
      name: "setViewport",
      signature: "setViewport(id: string, width: number, height: number): void",
      summary:
        "Resize one preview's layout viewport in PAGE units. This is how you make a 390-wide phone next to a 1280-wide desktop of the same url. Floor 200. Does not zoom the canvas and does not recreate the iframe.",
    },
    {
      name: "reload",
      signature: "reload(id: string): void",
      summary:
        "Reload that iframe's document. Same element, same viewport; only the page inside is fetched again. Use this after the target server comes up, not after a camera move.",
    },
    {
      name: "setInteractive",
      signature: "setInteractive(id: string, on: boolean): void",
      summary:
        "true: drop the hit shield so the page eats the mouse (scroll, click, type). You will not be able to drag that object until you leave. false / Esc / a press on empty canvas: shield back, canvas owns the mouse. Double-click the preview to enter. Only one preview is interactive at a time.",
    },
  ],
  mount(ctx: LabPluginContext) {
    const previews = new LivePreviews({
      host: ctx.host,
      objects: ctx.objects,
    });
    return {
      handleKey: (e) => previews.handleKey(e),
      onCameraWrite: () => previews.onCameraWrite(),
      api: previews,
      destroy: () => previews.destroy(),
    };
  },
};
