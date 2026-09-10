/**
 * Components are a thing on this canvas: pick one and every place it is
 * rendered lights up at once.
 *
 * This plugin does not author anything. It has no palette, nothing is dragged
 * out of it, and it never writes a file — in this project she writes the
 * source and a person judges the result, so the verb here is *know*, not
 * *place*. What it adds is the three answers the canvas could not give:
 * which screens a component reaches, what it takes, and where its instances
 * are.
 *
 * ── how a source location becomes an outline ──────────────────────────────
 * The index (built on the Node side, where the TypeScript compiler is) says a
 * component is rendered at `file:line:column`. React, in dev, hangs an Error
 * on every element it creates whose first non-vendor frame is *that same*
 * `file:line:column` — that is what the inspect plugin reads to answer "which
 * line made this node". So the two halves join on the location itself, and no
 * marker, no id and no build step is needed to relate them.
 *
 * One difference from inspect: it reads the fiber of the node you pointed at,
 * and stops at the first frame it finds. An instance of `<Browse/>` has no DOM
 * node of its own — React makes the nodes Browse *returns* — so this walks the
 * whole fiber chain and matches every owner up the tree. The nearest owner
 * that is in the index is the instance the element belongs to.
 *
 * ── the gesture ──────────────────────────────────────────────────────────
 * Ctrl/Cmd + Shift + click. Alt is drag-duplicate and Shift alone is inspect,
 * and inspect explicitly bows out when ctrl or meta is held, so this chord is
 * free. Every other press is left completely untouched: plain clicks, drags,
 * double-click-to-activate and Alt-duplicate all reach the canvas.
 *
 * Unlike inspect, a plain click does NOT clear the outlines. The point of the
 * view is to pan and zoom around eleven highlighted places; dropping them the
 * moment you grab the canvas would defeat it. Escape, `clear()`, or picking
 * something else is how it ends.
 */

import type { LabPlugin, LabPluginContext } from "../../plugin-api";
import type { Camera, Point, Rect } from "../../core/types";
import {
  fiberOf,
  parseFrame,
  primeSourceLocations,
  resolveFrame,
} from "../inspect/source-location";
import { SKIP_HOSTS } from "../inspect/plugin";
import type {
  ComponentEntry,
  ComponentIndex,
  ComponentInstance,
} from "../../components/types";

/** Chrome that is never a pick target — inspect's list, plus our own boxes. */
const SKIP = `${SKIP_HOSTS},[data-components-overlay]`;

export const INDEX_URL = "/__lab-fs/components.json";

const EMPTY: ComponentIndex = { screens: [], components: [], problems: [] };

/** One row of `list()`: enough to choose from, without the whole index. */
export type ComponentSummary = {
  name: string;
  file: string;
  exported: ComponentEntry["exported"];
  /** Every screen that reaches it. Change it and these are what moved. */
  screens: string[];
  props: number;
  instances: number;
  reach: ComponentEntry["reach"];
};

export type ShowResult = {
  component: ComponentEntry;
  /** How many elements are outlined right now. A `.map()` makes many per site. */
  outlined: number;
};

/**
 * z-index 2 for the same reason the inspector's root is 3, and one below it.
 *
 * The plugin layer is `z-index: auto`, so a root that names no z-index is
 * painted under the screens and can never be seen over one. The inspector's
 * CSS carries the full ladder and the measurement; both are gated in
 * lab-css.test.ts. A selection outlines one element on purpose, a component
 * outline paints every instance at once, so where they overlap the selection
 * is the answer worth reading and goes on top.
 */
const CSS = `
.lc-root{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2}
.lc-box{position:absolute;left:0;top:0;box-sizing:border-box;display:none;pointer-events:none;outline:1px dashed #1c1c1c;background:rgba(28,28,28,0.04)}
.lc-box[data-show]{display:block}
.lc-tag{position:absolute;left:0;top:0;transform:translateY(-100%);margin-top:-3px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#1c1c1c;color:#f1f1f1;font:500 10px/1.5 Inter,system-ui,sans-serif;padding:1px 5px;border-radius:3px}
`;

let styleRefs = 0;
let styleEl: HTMLStyleElement | null = null;

function acquireStyles(): void {
  if (styleRefs++ === 0) {
    // .forEach, not for..of: this package's lib is ES2023+DOM without
    // DOM.Iterable, so iterating a NodeList is a type error here.
    document.querySelectorAll("style[data-lab-components]").forEach((el) => {
      el.remove();
    });
    styleEl = document.createElement("style");
    styleEl.dataset.labComponents = "";
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }
}

function releaseStyles(): void {
  if (--styleRefs === 0) {
    styleEl?.remove();
    styleEl = null;
  }
}

async function fetchIndex(): Promise<ComponentIndex> {
  // Silent on failure, like the rest of the lab's dev-server calls: the canvas
  // has to mount when there is no server behind it.
  try {
    const res = await fetch(INDEX_URL);
    if (!res.ok) return EMPTY;
    const body = (await res.json()) as { ok?: boolean; index?: ComponentIndex };
    return body.ok && body.index ? body.index : EMPTY;
  } catch {
    return EMPTY;
  }
}

// ─────────────────────── source locations from fibers ───────────────────────

type Fiber = NonNullable<ReturnType<typeof fiberOf>>;

/** `_debugStack` is an Error in practice, but has been a string historically. */
function stackText(debugStack: unknown): string | null {
  if (typeof debugStack === "string") return debugStack;
  if (debugStack instanceof Error) return debugStack.stack ?? null;
  if (debugStack && typeof debugStack === "object") {
    const { stack } = debugStack as { stack?: unknown };
    if (typeof stack === "string") return stack;
  }
  return null;
}

function locationKey(file: string, line: number, column: number): string {
  return `${file}:${line}:${column}`;
}

function instanceKey(at: ComponentInstance): string {
  return locationKey(at.file, at.line, at.column);
}

/**
 * The first repo-relative frame of one fiber's creation stack, as a key in the
 * INDEX's coordinates.
 *
 * The index is built by the TypeScript compiler from the file on disk. In the
 * browser the fiber's stack is in the coordinates of the module vite served,
 * and those are different numbers — which is why this join used to outline
 * nothing at all in the running lab while passing every test under vitest,
 * where the stack arrives already mapped. `resolveFrame` is what puts both
 * sides in the same space.
 *
 * A frame whose map has not been read yet has no key. Not the unmapped
 * numbers: a key built from those cannot match, and would look like the
 * component simply is not on screen. `show` and `componentAt` both wait for
 * the maps before they walk, so in practice this only returns null for a node
 * that genuinely has no location.
 */
function frameOf(fiber: Fiber): string | null {
  const text = stackText(fiber._debugStack);
  if (!text) return null;
  for (const raw of text.split("\n")) {
    const frame = parseFrame(raw);
    if (!frame) continue;
    const at = resolveFrame(frame);
    if (at.problem !== null || at.file === null) return null;
    if (at.line === null || at.column === null) return null;
    return locationKey(at.file, at.line, at.column);
  }
  return null;
}

/**
 * The nearest fiber at or above `el` whose JSX tag is one of `keys`, with the
 * key it matched. Nearest, because a Card inside a Card belongs to the inner
 * one; identity of the fiber is what tells two instances of the same tag apart.
 */
function ownerIn(el: Element, keys: Set<string>): { fiber: Fiber; key: string } | null {
  const seen = new Set<Fiber>();
  let cur: Fiber | null | undefined = fiberOf(el);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const key = frameOf(cur);
    if (key && keys.has(key)) return { fiber: cur, key };
    cur = cur.return;
  }
  return null;
}

/** Every location the element's owner chain names, nearest first. */
function ownerKeys(el: Element): string[] {
  const out: string[] = [];
  const seen = new Set<Fiber>();
  let cur: Fiber | null | undefined = fiberOf(el);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const key = frameOf(cur);
    if (key) out.push(key);
    cur = cur.return;
  }
  return out;
}

// ──────────────────────────────── the view ────────────────────────────────

type Shown = { el: Element; box: HTMLDivElement; screenId: string | null };

export class ComponentsView {
  private getOrigin: () => Point;
  private getCamera: () => Camera;
  private load: () => Promise<ComponentIndex>;
  private root: HTMLDivElement;
  private index: ComponentIndex | null = null;
  private pending: Promise<ComponentIndex> | null = null;
  /** location -> component name, so an element can name what it is part of. */
  private byLocation = new Map<string, string>();
  private shownName: string | null = null;
  private boxes: Shown[] = [];
  private closed = false;

  constructor(opts: {
    host: HTMLElement;
    getOrigin: () => Point;
    getCamera: () => Camera;
    /** Injected so tests need neither a dev server nor a fetch stub. */
    load?: () => Promise<ComponentIndex>;
  }) {
    this.getOrigin = opts.getOrigin;
    this.getCamera = opts.getCamera;
    this.load = opts.load ?? fetchIndex;
    acquireStyles();
    this.root = document.createElement("div");
    this.root.className = "lc-root";
    this.root.setAttribute("data-components-overlay", "");
    opts.host.appendChild(this.root);
    window.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("scroll", this.onScroll, true);
  }

  // ── index ──────────────────────────────────────────────────────────────

  private async ready(): Promise<ComponentIndex> {
    if (this.index) return this.index;
    this.pending ??= this.load();
    const loaded = await this.pending;
    this.pending = null;
    if (this.closed) return loaded;
    this.index = loaded;
    this.byLocation.clear();
    for (const c of loaded.components) {
      for (const at of c.instances) this.byLocation.set(instanceKey(at), c.name);
    }
    return loaded;
  }

  /**
   * Read the source maps of every module the live tree came from.
   *
   * This is the half of the join that is not synchronous. The walk itself has
   * to be — it visits every element under every screen — so the maps are read
   * first and the walk then never waits. Repeat calls are cheap: a module
   * already read is skipped, and a hot update mints a new URL, so an edited
   * screen is picked up here without anything having to notice the edit.
   */
  private primeSources(): Promise<void> {
    if (typeof document === "undefined") return Promise.resolve();
    return primeSourceLocations(document);
  }

  /** Fetch the index again. The server recomputes it; nothing here is cached. */
  async reload(): Promise<ComponentIndex> {
    this.index = null;
    this.pending = null;
    this.byLocation.clear();
    return this.ready();
  }

  async list(): Promise<ComponentSummary[]> {
    const index = await this.ready();
    return index.components.map((c) => ({
      name: c.name,
      file: c.file,
      exported: c.exported,
      screens: c.screens,
      props: c.props.length,
      instances: c.instances.length,
      reach: c.reach,
    }));
  }

  private async find(name: string): Promise<ComponentEntry | null> {
    const index = await this.ready();
    const exact = index.components.find(
      (c) => c.name === name || c.aliases.includes(name),
    );
    if (exact) return exact;
    const lower = name.toLowerCase();
    return (
      index.components.find(
        (c) =>
          c.name.toLowerCase() === lower ||
          c.aliases.some((a) => a.toLowerCase() === lower),
      ) ?? null
    );
  }

  async instancesOf(name: string): Promise<ComponentInstance[]> {
    return (await this.find(name))?.instances ?? [];
  }

  /** The component currently outlined, or null. */
  shown(): string | null {
    return this.shownName;
  }

  // ── the propagation view ───────────────────────────────────────────────

  async show(name: string): Promise<ShowResult | null> {
    const [entry] = await Promise.all([this.find(name), this.primeSources()]);
    if (this.closed) return null;
    this.clear();
    if (!entry) return null;
    this.shownName = entry.name;
    const keys = new Set(entry.instances.map(instanceKey));
    for (const el of this.elementsFor(keys)) {
      this.boxes.push({
        el,
        box: this.makeBox(entry.name),
        screenId: el.closest("[data-screen-id]")?.getAttribute("data-screen-id") ?? null,
      });
    }
    this.label();
    this.paint();
    return { component: entry, outlined: this.boxes.length };
  }

  /**
   * The topmost live elements belonging to any of `keys`. Grouped by the owner
   * FIBER, not by the location: a `.map()` renders one tag site many times and
   * every one of them is a separate place on screen.
   */
  private elementsFor(keys: Set<string>): Element[] {
    const groups = new Map<Fiber, Element[]>();
    const scrolls = document.querySelectorAll("[data-screen-scroll]");
    scrolls.forEach((scroll) => {
      scroll.querySelectorAll("*").forEach((el) => {
        if (el.closest(SKIP)) return;
        const owner = ownerIn(el, keys);
        if (!owner) return;
        const list = groups.get(owner.fiber);
        if (list) list.push(el);
        else groups.set(owner.fiber, [el]);
      });
    });
    const out: Element[] = [];
    groups.forEach((els) => {
      // One instance can own several sibling roots (a fragment). Keep those;
      // drop anything an already-kept element contains.
      for (const el of els) {
        if (!els.some((other) => other !== el && other.contains(el))) out.push(el);
      }
    });
    return out;
  }

  /** The indexed component the element belongs to, nearest owner first. */
  async componentAt(el: Element): Promise<string | null> {
    await Promise.all([this.ready(), this.primeSources()]);
    for (const key of ownerKeys(el)) {
      const name = this.byLocation.get(key);
      if (name) return name;
    }
    return null;
  }

  private makeBox(name: string): HTMLDivElement {
    const box = document.createElement("div");
    box.className = "lc-box";
    const tag = document.createElement("div");
    tag.className = "lc-tag";
    tag.textContent = name;
    box.appendChild(tag);
    this.root.appendChild(box);
    return box;
  }

  private label(): void {
    const total = this.boxes.length;
    this.boxes.forEach((shown, i) => {
      const tag = shown.box.firstElementChild;
      if (!tag || !this.shownName) return;
      tag.textContent =
        total > 1 ? `${this.shownName} ${i + 1}/${total}` : this.shownName;
    });
  }

  /**
   * Imperative, and called from the lab's rAF after every camera write, so it
   * reads geometry and writes style and never asks React to do anything.
   * `getBoundingClientRect` is already post-transform: pan and zoom need no
   * arithmetic here, which is exactly why the outlines survive them.
   */
  private paint = (): void => {
    const o = this.getOrigin();
    for (const shown of this.boxes) {
      if (!shown.el.isConnected) {
        shown.box.removeAttribute("data-show");
        continue;
      }
      const r = shown.el.getBoundingClientRect();
      shown.box.style.transform = `translate(${r.left - o.x}px, ${r.top - o.y}px)`;
      shown.box.style.width = `${r.width}px`;
      shown.box.style.height = `${r.height}px`;
      shown.box.setAttribute("data-show", "");
    }
  };

  /** Where the outlines are, in PAGE units. Detached elements are left out. */
  outlineRects(): Rect[] {
    const cam = this.getCamera();
    if (!cam.z) return [];
    const o = this.getOrigin();
    const out: Rect[] = [];
    for (const shown of this.boxes) {
      if (!shown.el.isConnected) continue;
      const r = shown.el.getBoundingClientRect();
      out.push({
        x: (r.left - o.x) / cam.z - cam.x,
        y: (r.top - o.y) / cam.z - cam.y,
        width: r.width / cam.z,
        height: r.height / cam.z,
      });
    }
    return out;
  }

  clear(): void {
    for (const shown of this.boxes) shown.box.remove();
    this.boxes = [];
    this.shownName = null;
  }

  // ── input ──────────────────────────────────────────────────────────────

  /** Screen content, and not the scroller itself or any lab chrome. */
  private qualify(el: Element): Element | null {
    if (el.closest(SKIP)) return null;
    const scroll = el.closest("[data-screen-scroll]");
    if (!scroll || el === scroll) return null;
    return el;
  }

  private pickAt(clientX: number, clientY: number): Element | null {
    if (typeof document === "undefined") return null;
    const fn = document.elementsFromPoint;
    if (typeof fn !== "function") return null;
    for (const el of fn.call(document, clientX, clientY)) {
      const hit = this.qualify(el);
      if (hit) return hit;
    }
    return null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    // Ctrl/Cmd + Shift only. Anything else — including a plain click and a
    // drag — is not touched at all, and does not drop the outlines either.
    if (!e.shiftKey || e.altKey || !(e.ctrlKey || e.metaKey)) return;
    const direct = e.target instanceof Element ? this.qualify(e.target) : null;
    const hit = direct ?? this.pickAt(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    void this.showAt(hit);
  };

  /** Pick the component this element is part of and show all of it. */
  async showAt(el: Element): Promise<ShowResult | null> {
    if (this.closed) return null;
    const name = await this.componentAt(el);
    if (!name) {
      this.clear();
      return null;
    }
    return this.show(name);
  }

  private onScroll = (): void => {
    if (this.boxes.length > 0) this.paint();
  };

  handleKey(e: KeyboardEvent): boolean {
    if (e.key !== "Escape") return false;
    if (this.boxes.length === 0) return false;
    this.clear();
    return true;
  }

  onCameraWrite(): void {
    if (this.boxes.length > 0) this.paint();
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.clear();
    window.removeEventListener("pointerdown", this.onPointerDown, true);
    window.removeEventListener("scroll", this.onScroll, true);
    this.root.remove();
    releaseStyles();
  }
}

export function createComponents(
  ctx: LabPluginContext,
  load?: () => Promise<ComponentIndex>,
): ComponentsView {
  return new ComponentsView({
    host: ctx.host,
    getOrigin: ctx.getOrigin,
    getCamera: ctx.getCamera,
    ...(load ? { load } : {}),
  });
}

export const plugin: LabPlugin = {
  id: "components",
  order: 65,
  describe: [
    {
      name: "list",
      signature:
        "list(): Promise<{ name, file, exported, screens, props, instances, reach }[]>",
      summary:
        "Every component the screens actually render, in reach order. `screens` is the propagation answer: change this component and those are the screens that moved. `exported` is default | named | local — local means it is really rendered but never exported, which is legal and happens. `reach` says how it got here: screen-root (it IS a screen), screen (a screen renders it directly) or component (only another component does), with the chain in `reach.path`. Async because the index is computed by the dev server, where the TypeScript compiler is; without a dev server this resolves to an empty list rather than throwing.",
    },
    {
      name: "show",
      signature: "show(name: string): Promise<{ component, outlined } | null>",
      summary:
        "Outline every live element of one component at once — the propagation view. Returns the full entry (props with their literal values, every instance's file/line/column) and how many elements are outlined. Note the two counts differ on purpose: `component.instances` counts places in the SOURCE, `outlined` counts what is on the canvas, so one tag inside a `.map()` is one instance and eight outlines. Accepts the declared name or a renamed import's tag (LocationPin or LocationIcon). Unknown name: clears and returns null. Outlines survive pan and zoom and are not dropped by a plain click; Escape or clear() ends them.",
    },
    {
      name: "instancesOf",
      signature:
        "instancesOf(name: string): Promise<{ screenId, file, line, column, tag }[]>",
      summary:
        "Where a component is rendered, in source. `file` is repo-relative and `line`/`column` point at the `<` of the tag — the same coordinates the inspect plugin reports, so an editor opened there lands on the tag itself. Empty for an unknown name and for a screen root, which has no tag anywhere because the lab renders it.",
    },
    {
      name: "componentAt",
      signature: "componentAt(el: Element): Promise<string | null>",
      summary:
        "Which indexed component an element belongs to, by walking React's owner chain and matching the JSX that made each ancestor against the index. The NEAREST match wins, so a title inside a row inside a card answers with the row. Null when the element is inside no indexed component (a screen that renders none, or lab chrome).",
    },
    {
      name: "showAt",
      signature: "showAt(el: Element): Promise<{ component, outlined } | null>",
      summary:
        "componentAt + show, in one call: the keyboard-free path is Ctrl/Cmd+Shift+click, and this is what that press does. Clears and returns null when the element belongs to nothing indexed.",
    },
    {
      name: "outlineRects",
      signature: "outlineRects(): { x, y, width, height }[]",
      summary:
        "Where the outlines are, in PAGE units — use it to check the highlights really sit on the elements. Page units, so the numbers do not change when the canvas zooms. Elements detached by a hot reload are left out rather than reported at a stale box.",
    },
    {
      name: "clear",
      signature: "clear(): void",
      summary:
        "Drop the outlines. A plain click deliberately does NOT do this, because panning and zooming around the highlighted places is the point; Escape does.",
    },
    {
      name: "reload",
      signature: "reload(): Promise<index>",
      summary:
        "Fetch the index again after editing a component. The server recomputes it from source on every request, so this never serves a stale answer — a stale index is worse than a slow one, because it sends you to the wrong line.",
    },
  ],
  mount(ctx: LabPluginContext) {
    const view = createComponents(ctx);
    return {
      handleKey: (e) => view.handleKey(e),
      onCameraWrite: () => view.onCameraWrite(),
      api: view,
      destroy: () => view.destroy(),
    };
  },
};
