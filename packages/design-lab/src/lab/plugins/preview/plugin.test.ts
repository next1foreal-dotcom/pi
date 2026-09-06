// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkApiDocs } from "../../plugin-api";
import type { LabObjectInit, LabObjects, LabPluginContext } from "../../plugin-api";
import type { Rect } from "../../core/types";
import { formatEmbedStatus } from "./embed-status";
import { plugin } from "./plugin";

const STORAGE_KEY = "interaction-lab:preview:v1";
const URL_A = "http://127.0.0.1:6191/";
const URL_DOWN = "http://127.0.0.1:59999/";

type FetchReply = {
  reachable?: boolean;
  xFrameOptions?: string | null;
  csp?: string | null;
};

let fetchReply: FetchReply = { reachable: true, xFrameOptions: null, csp: null };
let live: ReturnType<typeof plugin.mount> | null = null;
let host: HTMLElement;

function stubObjects(): LabObjects & { inits: Map<string, LabObjectInit> } {
  const layouts = new Map<string, Rect>();
  const inits = new Map<string, LabObjectInit>();
  let sel: string | null = null;
  return {
    inits,
    register(init) {
      layouts.set(init.id, { ...init.rect });
      inits.set(init.id, init);
      init.el.setAttribute("data-lab-object", init.id);
      init.el.style.transform = `translate(${init.rect.x}px, ${init.rect.y}px)`;
      if (init.sizing !== "content") {
        init.el.style.width = `${init.rect.width}px`;
        init.el.style.height = `${init.rect.height}px`;
      }
    },
    unregister(id) {
      layouts.delete(id);
      inits.delete(id);
    },
    layout: (id) => (layouts.get(id) ? { ...layouts.get(id)! } : undefined),
    setLayout(id, rect) {
      layouts.set(id, { ...rect });
      const entry = inits.get(id);
      if (!entry) return;
      entry.el.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
      if (entry.sizing !== "content") {
        entry.el.style.width = `${rect.width}px`;
        entry.el.style.height = `${rect.height}px`;
      }
      entry.onLayout?.(rect);
    },
    beginMove() {},
    beginResize() {},
    select(id) {
      const prev = sel;
      if (prev === id) return;
      if (prev != null) inits.get(prev)?.onSelect?.(false);
      sel = id;
      if (id != null) inits.get(id)?.onSelect?.(true);
    },
    selectedId: () => sel,
  };
}

function ctxFor(objects: LabObjects, cameraZ = 1): LabPluginContext {
  return {
    host,
    getCamera: () => ({ x: 0, y: 0, z: cameraZ }),
    getOrigin: () => ({ x: 0, y: 0 }),
    getViewport: () => ({ width: 1440, height: 900 }),
    getAppearance: () => "light",
    getZoom: () => cameraZ,
    viewportCenterPage: () => ({ x: 720, y: 450 }),
    screenAt: () => null,
    objects,
  };
}

type PreviewApi = {
  insert(init: {
    url: string;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
  }): { id: string };
  remove(id: string): void;
  list(): {
    id: string;
    url: string;
    width: number;
    height: number;
    x: number;
    y: number;
  }[];
  setViewport(id: string, width: number, height: number): void;
  reload(id: string): void;
  setInteractive(id: string, on: boolean): void;
};

function mount(cameraZ = 1) {
  const objects = stubObjects();
  live = plugin.mount(ctxFor(objects, cameraZ));
  return { objects, api: live?.api as PreviewApi, handle: live! };
}

function frame(id: string): HTMLElement {
  const el = host.querySelector(`[data-lab-object="${id}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`missing frame ${id}`);
  return el;
}

function iframeOf(id: string): HTMLIFrameElement {
  const node = frame(id).querySelector("iframe");
  if (!(node instanceof HTMLIFrameElement)) throw new Error("missing iframe");
  return node;
}

function shieldOf(id: string): HTMLElement {
  const node = frame(id).querySelector("[data-preview-shield]");
  if (!(node instanceof HTMLElement)) throw new Error("missing shield");
  return node;
}

function statusOf(id: string): HTMLElement {
  const node = frame(id).querySelector("[data-preview-status]");
  if (!(node instanceof HTMLElement)) throw new Error("missing status");
  return node;
}

function spySrcWrites(el: HTMLIFrameElement): () => number {
  let n = 0;
  const attr = el.setAttribute.bind(el);
  el.setAttribute = (name: string, value: string) => {
    if (name.toLowerCase() === "src") n++;
    attr(name, value);
  };
  Object.defineProperty(el, "src", {
    configurable: true,
    get: () => el.getAttribute("src") ?? "",
    set: (value: string) => {
      n++;
      attr("src", value);
    },
  });
  return () => n;
}

beforeEach(() => {
  fetchReply = { reachable: true, xFrameOptions: null, csp: null };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => fetchReply,
    })),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  live?.destroy();
  live = null;
  document.body.innerHTML = "";
  localStorage.removeItem(STORAGE_KEY);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("formatEmbedStatus (samantha-ui @ 6191 from 5180)", () => {
  const embedder = "http://localhost:5180";
  const target = URL_A;

  it("unreachable includes the address and does not throw", () => {
    const s = formatEmbedStatus(target, { reachable: false }, embedder);
    expect(s.ok).toBe(false);
    expect(s.text).toContain("这个地址没人应答");
    expect(s.text).toContain(target);
  });

  it("SAMEORIGIN + frame-ancestors self names the headers and the address", () => {
    const s = formatEmbedStatus(
      target,
      {
        reachable: true,
        xFrameOptions: "SAMEORIGIN",
        csp: "base-uri 'self'; frame-ancestors 'self'; object-src 'none'",
      },
      embedder,
    );
    expect(s.ok).toBe(false);
    expect(s.text).toContain("拒绝被嵌入");
    expect(s.text).toContain("frame-ancestors");
    expect(s.text).toContain("X-Frame-Options: SAMEORIGIN");
    expect(s.text).toContain(target);
  });

  it("same origin is allowed even with SAMEORIGIN / 'self'", () => {
    const s = formatEmbedStatus(
      "http://localhost:5180/app",
      {
        reachable: true,
        xFrameOptions: "SAMEORIGIN",
        csp: "frame-ancestors 'self'",
      },
      embedder,
    );
    expect(s.ok).toBe(true);
    expect(s.text).toBeNull();
  });
});

describe("1. camera writes do not rebuild the iframe", () => {
  it("the iframe node is the same instance after camera writes, a move, and a resize", () => {
    const { objects, api, handle } = mount();
    const { id } = api.insert({ url: URL_A, width: 390, height: 844, x: 0, y: 0 });
    const iframe = iframeOf(id);
    const writes = spySrcWrites(iframe);

    handle.onCameraWrite?.();
    handle.onCameraWrite?.();
    handle.onCameraWrite?.();
    objects.setLayout(id, { x: 40, y: 80, width: 390, height: 844 });
    objects.setLayout(id, { x: 40, y: 80, width: 1280, height: 800 });
    handle.onCameraWrite?.();

    expect(iframeOf(id)).toBe(iframe);
    expect(writes()).toBe(0);
    expect(iframe.getAttribute("src")).toBe(URL_A);
  });
});

describe("2. viewport width is the object width, not the zoomed width", () => {
  it("a 390-wide preview stays 390 after the camera is at 2x", () => {
    const { objects, api, handle } = mount(2);
    const { id } = api.insert({ url: URL_A, width: 390, height: 844, x: 10, y: 10 });
    const iframe = iframeOf(id);
    const parent = frame(id);

    handle.onCameraWrite?.();
    objects.setLayout(id, {
      ...(objects.layout(id) ?? { x: 10, y: 10, width: 390, height: 844 }),
    });
    handle.onCameraWrite?.();

    expect(parent.style.width).toBe("390px");
    expect(iframe.style.width === "" || iframe.style.width === "100%").toBe(true);
    expect(iframe.style.width).not.toBe("780px");
    expect(api.list()[0]?.width).toBe(390);
    // The iframe must fill the object, not invent a zoomed layout width.
    expect(iframe.clientWidth === 0 || iframe.clientWidth === parent.clientWidth).toBe(
      true,
    );
  });
});

describe("3. hit shield vs interactive", () => {
  it("default: shield is on (canvas eats events); interactive: shield off; Esc restores", () => {
    const { api, handle } = mount();
    const { id } = api.insert({ url: URL_A, width: 390, height: 844, x: 0, y: 0 });
    const shield = shieldOf(id);
    const box = frame(id);

    expect(box.hasAttribute("data-interactive")).toBe(false);
    expect(shield.hidden).toBe(false);

    shield.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(box.hasAttribute("data-interactive")).toBe(true);
    expect(shieldOf(id).hidden).toBe(true);

    const consumed = handle.handleKey?.(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(consumed).toBe(true);
    expect(frame(id).hasAttribute("data-interactive")).toBe(false);
    expect(shieldOf(id).hidden).toBe(false);
  });

  it("setInteractive(true) then setInteractive(false) is the other direction", () => {
    const { api } = mount();
    const { id } = api.insert({ url: URL_A, width: 390, height: 844, x: 0, y: 0 });
    api.setInteractive(id, true);
    expect(frame(id).hasAttribute("data-interactive")).toBe(true);
    expect(shieldOf(id).hidden).toBe(true);
    api.setInteractive(id, false);
    expect(frame(id).hasAttribute("data-interactive")).toBe(false);
    expect(shieldOf(id).hidden).toBe(false);
  });

  it("a press on empty canvas exits interactive", () => {
    const { api } = mount();
    const { id } = api.insert({ url: URL_A, width: 390, height: 844, x: 0, y: 0 });
    api.setInteractive(id, true);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(frame(id).hasAttribute("data-interactive")).toBe(false);
    expect(shieldOf(id).hidden).toBe(false);
  });
});

describe("4. unreachable target speaks the address", () => {
  it("shows 这个地址没人应答 plus the url, and does not throw", async () => {
    fetchReply = { reachable: false };
    const { api } = mount();
    expect(() => api.insert({ url: URL_DOWN, width: 390, height: 844, x: 0, y: 0 })).not.toThrow();
    const { id } = api.list()[0]!;
    await vi.waitFor(() => {
      const text = statusOf(id).textContent ?? "";
      expect(text).toContain("这个地址没人应答");
      expect(text).toContain(URL_DOWN);
    });
    expect(statusOf(id).hidden).toBe(false);
  });
});

describe("5. insert / list / remove round-trip", () => {
  it("inserts, lists the same record, then remove empties the list", () => {
    const { api } = mount();
    const { id } = api.insert({
      url: URL_A,
      width: 390,
      height: 844,
      x: 12,
      y: 34,
    });
    expect(id).toMatch(/^preview:/);
    expect(api.list()).toEqual([
      { id, url: URL_A, width: 390, height: 844, x: 12, y: 34 },
    ]);
    api.remove(id);
    expect(api.list()).toEqual([]);
    expect(host.querySelector(`[data-lab-object="${id}"]`)).toBeNull();
  });
});

describe("6. describe names are real api methods", () => {
  it("checkApiDocs is clean and every documented name exists", () => {
    const { api } = mount();
    const docs = plugin.describe ?? [];
    expect(docs.length).toBeGreaterThan(0);
    expect(checkApiDocs("preview", api, docs)).toEqual([]);
    const names = docs.map((d) => d.name).sort();
    expect(names).toEqual(
      ["insert", "list", "reload", "remove", "setInteractive", "setViewport"].sort(),
    );
    for (const d of docs) {
      expect(d.signature).toContain(d.name);
      expect(d.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("7. Alt-duplicate keeps url and viewport width", () => {
  it("duplicate() creates a second preview with the same url and width at the new rect", () => {
    const { objects, api } = mount();
    const { id } = api.insert({
      url: URL_A,
      width: 1280,
      height: 800,
      x: 0,
      y: 0,
    });
    const init = objects.inits.get(id);
    expect(init?.duplicate).toBeTypeOf("function");
    init?.duplicate?.({ x: 100, y: 200, width: 1280, height: 800 });
    const listed = api.list();
    expect(listed).toHaveLength(2);
    const copy = listed.find((p) => p.id !== id);
    expect(copy?.url).toBe(URL_A);
    expect(copy?.width).toBe(1280);
    expect(copy?.x).toBe(100);
    expect(copy?.y).toBe(200);
  });
});

describe("sizing: lab (multi-viewport)", () => {
  it("registers with sizing lab so the object width is the viewport width", () => {
    const { objects, api } = mount();
    const { id } = api.insert({ url: URL_A, width: 390, height: 844, x: 0, y: 0 });
    expect(objects.inits.get(id)?.sizing === "lab" || objects.inits.get(id)?.sizing === undefined).toBe(
      true,
    );
    expect(objects.inits.get(id)?.resizable).toBe(true);
    expect(objects.inits.get(id)?.duplicate).toBeTypeOf("function");
  });
});

describe("persistence", () => {
  it("url, viewport and position survive a remount", async () => {
    const first = mount();
    first.api.insert({ url: URL_A, width: 390, height: 844, x: 7, y: 9 });
    await new Promise((r) => setTimeout(r, 220));
    first.handle.destroy();
    live = null;

    const second = mount();
    live = second.handle;
    expect(second.api.list()).toEqual([
      expect.objectContaining({
        url: URL_A,
        width: 390,
        height: 844,
        x: 7,
        y: 9,
      }),
    ]);
  });
});

describe("blocked embed paints the header, not a blank frame", () => {
  it("shows the refusal copy with the url still visible", async () => {
    fetchReply = {
      reachable: true,
      xFrameOptions: "SAMEORIGIN",
      csp: "frame-ancestors 'self'",
    };
    const { api } = mount();
    const { id } = api.insert({ url: URL_A, width: 390, height: 844, x: 0, y: 0 });
    await vi.waitFor(() => {
      const text = statusOf(id).textContent ?? "";
      expect(text).toContain("拒绝被嵌入");
      expect(text).toContain(URL_A);
    });
    expect(statusOf(id).hidden).toBe(false);
  });
});
