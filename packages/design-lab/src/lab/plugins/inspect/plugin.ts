/**
 * Point at a thing on the canvas and learn which line of code made it.
 *
 * Selection and location only — this plugin never writes a file. It publishes
 * `selection()` so the tool that *does* edit source can be built on top of it.
 *
 * Two decisions worth knowing before you change anything here:
 *
 * 1. The chord is Shift-click, not Alt-click. Alt is already spoken for: a
 *    shield press runs `startMove(e, id, e.altKey)` (lab-view) and an Alt-drag
 *    duplicates the screen (interaction-lab's `ghost`). Taking Alt would have
 *    traded a working gesture for a new one. Shift-click currently does exactly
 *    what a plain click does, so claiming it costs nothing. Plain, Alt-, Ctrl-
 *    and Meta-clicks all reach the canvas untouched.
 *
 * 2. `e.target` is usually NOT the element you pointed at. Every screen has a
 *    `.shield` covering it (that is what makes screens draggable), and the
 *    shield is a sibling of `[data-screen-scroll]`, not a child, so it swallows
 *    the press. Hit testing therefore goes through `elementsFromPoint`, with
 *    `e.target` used only when it already belongs to a screen — which happens
 *    when the screen has been activated by double-click, and in tests.
 */

import type { LabPlugin, LabPluginContext } from "../../plugin-api";
import type { Camera, Point, Rect } from "../../core/types";
import { locateElement, type SourceProblem } from "./source-location";

/** Chrome that must never be a selection target, including our own overlay. */
export const SKIP_HOSTS =
  "[data-notes-host],[data-labels-host],[data-ruler-host],[data-lab-chrome],[data-inspect-overlay]";

const TEXT_SAMPLE_MAX = 80;

export type InspectProblem = SourceProblem | "node-detached";

export type InspectSelection = {
  /** The screen the element lives in, from its `data-screen-id` ancestor. */
  screenId: string | null;
  /** Repo-relative path of the JSX that made it. Null if unresolved. */
  file: string | null;
  line: number | null;
  column: number | null;
  /** The component that rendered the tag, when the stack frame names one. */
  component: string | null;
  tag: string;
  /** The element's current class attribute, re-read on every call. */
  className: string;
  /** A short collapsed text sample, enough to recognise it in a report. */
  text: string;
  /** False once the node has left the document — a hot reload replaced it. */
  attached: boolean;
  /** Null when this is a complete answer, otherwise what is missing and why. */
  problem: InspectProblem | null;
};

const CSS = `
.li-root{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none}
.li-box{position:absolute;left:0;top:0;box-sizing:border-box;display:none;pointer-events:none;outline:1px solid #1c1c1c;background:rgba(28,28,28,0.06)}
.li-box[data-show]{display:block}
.li-label{position:absolute;left:0;top:0;transform:translateY(-100%);margin-top:-3px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#1c1c1c;color:#f1f1f1;font:500 11px/1.5 Inter,system-ui,sans-serif;padding:2px 6px;border-radius:3px}
`;

let styleRefs = 0;
let styleEl: HTMLStyleElement | null = null;

function acquireStyles(): void {
  if (styleRefs++ === 0) {
    // .forEach, not for..of: this package's lib is ES2023+DOM without
    // DOM.Iterable, so iterating a NodeList is a type error here.
    document.querySelectorAll("style[data-lab-inspect]").forEach((el) => {
      el.remove();
    });
    styleEl = document.createElement("style");
    styleEl.dataset.labInspect = "";
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

function textOf(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, TEXT_SAMPLE_MAX);
}

/** jsdom has no `elementsFromPoint`, so this is a seam and not a direct call. */
function documentElementsAt(x: number, y: number): Element[] {
  if (typeof document === "undefined") return [];
  const fn = document.elementsFromPoint;
  if (typeof fn !== "function") return [];
  return fn.call(document, x, y);
}

export type InspectDeps = {
  /** Topmost-first elements at a CLIENT point. Injected so this is testable. */
  elementsAt(clientX: number, clientY: number): Element[];
};

export class Inspector {
  private getOrigin: () => Point;
  private getCamera: () => Camera;
  private elementsAt: InspectDeps["elementsAt"];
  private root: HTMLDivElement;
  private box: HTMLDivElement;
  private label: HTMLDivElement;
  private selected: Element | null = null;
  private snapshot: InspectSelection | null = null;
  private closed = false;

  constructor(opts: {
    host: HTMLElement;
    getOrigin: () => Point;
    getCamera: () => Camera;
    elementsAt?: InspectDeps["elementsAt"];
  }) {
    this.getOrigin = opts.getOrigin;
    this.getCamera = opts.getCamera;
    this.elementsAt = opts.elementsAt ?? documentElementsAt;
    acquireStyles();
    this.root = document.createElement("div");
    this.root.className = "li-root";
    this.root.setAttribute("data-inspect-overlay", "");
    this.box = document.createElement("div");
    this.box.className = "li-box";
    this.label = document.createElement("div");
    this.label.className = "li-label";
    this.box.appendChild(this.label);
    this.root.appendChild(this.box);
    opts.host.appendChild(this.root);
    window.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("scroll", this.onScroll, true);
  }

  /** Content of a screen, and not the scroller itself or any lab chrome. */
  private qualify(el: Element): Element | null {
    if (el.closest(SKIP_HOSTS)) return null;
    const scroll = el.closest("[data-screen-scroll]");
    if (!scroll || el === scroll) return null;
    return el;
  }

  private pickAt(clientX: number, clientY: number): Element | null {
    for (const el of this.elementsAt(clientX, clientY)) {
      const hit = this.qualify(el);
      if (hit) return hit;
    }
    return null;
  }

  private capture(el: Element): InspectSelection {
    const loc = locateElement(el);
    const screen = el.closest("[data-screen-id]");
    return {
      screenId: screen?.getAttribute("data-screen-id") ?? null,
      file: loc.file,
      line: loc.line,
      column: loc.column,
      component: loc.component,
      tag: el.tagName.toLowerCase(),
      className: el.getAttribute("class") ?? "",
      text: textOf(el),
      attached: true,
      problem: loc.problem,
    };
  }

  private labelText(sel: InspectSelection): string {
    const first = sel.className.trim().split(/\s+/)[0];
    const name = first ? `${sel.tag}.${first}` : sel.tag;
    const where = sel.file
      ? `${sel.file.split("/").pop()}:${sel.line}`
      : `source unknown (${sel.problem})`;
    return `${name} · ${where}`;
  }

  /**
   * Imperative, and called from the lab's rAF after every camera write — so it
   * reads geometry and writes style, and never asks React to do anything.
   * `getBoundingClientRect` is already post-transform, which is why panning and
   * zooming need no camera maths here.
   */
  private paint = (): void => {
    const el = this.selected;
    if (!el || !el.isConnected) {
      this.box.removeAttribute("data-show");
      return;
    }
    const r = el.getBoundingClientRect();
    const o = this.getOrigin();
    this.box.style.transform = `translate(${r.left - o.x}px, ${r.top - o.y}px)`;
    this.box.style.width = `${r.width}px`;
    this.box.style.height = `${r.height}px`;
    this.box.setAttribute("data-show", "");
  };

  private onScroll = (): void => {
    if (this.selected) this.paint();
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
      // Every other press belongs to the canvas. Dropping the outline is the
      // only thing we do, and we do it without touching the event.
      if (this.selected) this.clear();
      return;
    }
    const direct = e.target instanceof Element ? this.qualify(e.target) : null;
    const hit = direct ?? this.pickAt(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    this.selectElement(hit);
  };

  /** Select a node directly. Returns the same payload as `selection()`. */
  selectElement(el: Element): InspectSelection | null {
    if (this.closed) return null;
    if (!this.qualify(el)) return null;
    this.selected = el;
    this.snapshot = this.capture(el);
    this.label.textContent = this.labelText(this.snapshot);
    this.paint();
    return this.selection();
  }

  selectAt(x: number, y: number): InspectSelection | null {
    if (this.closed) return null;
    const cam = this.getCamera();
    const o = this.getOrigin();
    const hit = this.pickAt((x + cam.x) * cam.z + o.x, (y + cam.y) * cam.z + o.y);
    if (!hit) {
      this.clear();
      return null;
    }
    return this.selectElement(hit);
  }

  selection(): InspectSelection | null {
    const el = this.selected;
    const snap = this.snapshot;
    if (!el || !snap) return null;
    // A screen hot-reloads on every source edit, so the node we are holding can
    // be replaced out from under us. Say so; do not describe a detached node as
    // if it were still on screen.
    if (!el.isConnected) return { ...snap, attached: false, problem: "node-detached" };
    return {
      ...snap,
      className: el.getAttribute("class") ?? "",
      text: textOf(el),
      attached: true,
    };
  }

  /** The outline's box in PAGE units, or null when there is nothing to show. */
  outlineRect(): Rect | null {
    const el = this.selected;
    if (!el || !el.isConnected) return null;
    const cam = this.getCamera();
    if (!cam.z) return null;
    const r = el.getBoundingClientRect();
    const o = this.getOrigin();
    return {
      x: (r.left - o.x) / cam.z - cam.x,
      y: (r.top - o.y) / cam.z - cam.y,
      width: r.width / cam.z,
      height: r.height / cam.z,
    };
  }

  clear(): void {
    this.selected = null;
    this.snapshot = null;
    this.label.textContent = "";
    this.box.removeAttribute("data-show");
  }

  onCameraWrite(): void {
    if (this.selected) this.paint();
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

export function createInspect(
  ctx: LabPluginContext,
  deps?: Partial<InspectDeps>,
): Inspector {
  return new Inspector({
    host: ctx.host,
    getOrigin: ctx.getOrigin,
    getCamera: ctx.getCamera,
    ...(deps?.elementsAt ? { elementsAt: deps.elementsAt } : {}),
  });
}

export const plugin: LabPlugin = {
  id: "inspect",
  order: 60,
  describe: [
    {
      name: "selection",
      signature:
        "selection(): { screenId, file, line, column, component, tag, className, text, attached, problem } | null",
      summary:
        "The selected element, or null if nothing is selected. `file` is repo-relative (e.g. packages/design-lab/src/screens/playground/screen.tsx) and `line`/`column` point at the JSX tag that made the node, read from React's dev-only `_debugStack`. When the location cannot be resolved those three are null and `problem` says why: no-react-fiber (not made by React), no-debug-stack (React is a production build, so there is nothing to read), no-project-source-frame (every frame was vendor code). Screens hot-reload, so a selected node can be replaced: then `attached` is false and `problem` is node-detached, and the other fields are the snapshot taken when it was selected, not a live read.",
    },
    {
      name: "selectAt",
      signature: "selectAt(x: number, y: number): selection | null",
      summary:
        "Select the deepest screen element at a PAGE-unit point — the way to drive this without a mouse. Page units, not screen pixels, so the answer does not change when the canvas zooms. Lab chrome, sticky notes, labels, rulers and the scroller itself are never hit. Returns the new selection, or null (and clears) if nothing qualifies there.",
    },
    {
      name: "selectElement",
      signature: "selectElement(el: Element): selection | null",
      summary:
        "Select a node you already have a handle on, skipping hit testing. Returns null and changes nothing if it is not screen content.",
    },
    {
      name: "outlineRect",
      signature: "outlineRect(): { x, y, width, height } | null",
      summary:
        "Where the outline is, in PAGE units — use it to check the highlight really sits on the element. Null when nothing is selected or the node has been detached.",
    },
    {
      name: "clear",
      signature: "clear(): void",
      summary: "Drop the selection and hide the outline. A plain click does this too.",
    },
  ],
  mount(ctx: LabPluginContext) {
    const inspector = createInspect(ctx);
    return {
      onCameraWrite: () => inspector.onCameraWrite(),
      api: inspector,
      destroy: () => inspector.destroy(),
    };
  },
};
