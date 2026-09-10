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

import type { LabObjects, LabPlugin, LabPluginContext } from "../../plugin-api";
import type { Camera, Point, Rect } from "../../core/types";
import { subscribeScreenHotUpdate } from "../../spotlight/hmr";
import {
  locateElement,
  locateElementSourced,
  primeSourceLocations,
  type SourceProblem,
} from "./source-location";

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

/**
 * The lab's stacking ladder, and why this number is 3.
 *
 * `[data-plugin-layer]` is `z-index: auto`, so it is NOT a stacking context and
 * every plugin's root is compared against the lab's own ladder directly:
 * pixel grid 0, screens 1, chrome 5, snap guides 7, measure 8, rulers 9,
 * HUD 20, toasts 30. A plugin root that names no z-index therefore lands in
 * the auto bucket — BELOW the screens — and an overlay drawn under an opaque
 * screen is an overlay nobody has ever seen.
 *
 * Measured 2026-09-10 on a real page: with an element selected, the stack at
 * the centre of the outline was shield / scroll / frame / group / li-box. The
 * selection outline has been invisible over a screen since it was written, and
 * so has the component outline (`.lc-root`, fixed with it). The screenshot
 * agreed — the h1 that `selection()` reported was drawn with nothing on it.
 *
 * 3 puts it over the screens and under everything meant to be read on top of
 * them: chrome labels, rulers, the properties panel, the HUD. The component
 * outline sits at 2, one below, because a selection is the more specific
 * answer and should win where both are drawn.
 *
 * Gated in lab-css.test.ts — if the plugin layer ever gets a z-index of its
 * own these numbers silently become layer-local, and the gate says so.
 *
 * Both rings are two-tone, and there is no fill.
 *
 * The first version drew ink on ink: `outline: 1px solid #1c1c1c` over a wash
 * of `rgba(28,28,28,0.06)`. That is a fine outline on a white page and no
 * outline at all on a dark one — the screenshot the moment this became
 * visible showed a dark landing page with the ring lost in it. The canvas
 * holds whatever screens the lab is pointed at, light and dark side by side,
 * so no single ink works, and the palette here is black, white and grey by
 * house rule, which rules out the accent colour every other tool reaches for.
 *
 * A white hairline with a dark ring immediately outside it needs no accent and
 * no guess about the content: on dark content the hairline carries it, on
 * light content the dark ring does. The wash is gone with it — a tint that
 * survives both is a tint you cannot see, and the ring already says where the
 * edges are. In screen space (the overlay is not scaled by the camera) these
 * stay one and two real pixels at every zoom.
 */
const CSS = `
.li-root{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:3}
.li-box{position:absolute;left:0;top:0;box-sizing:border-box;display:none;pointer-events:none;outline:1px solid rgba(255,255,255,0.92);box-shadow:0 0 0 2px rgba(0,0,0,0.55)}
.li-box[data-show]{display:block}
.li-bar{position:absolute;left:0;top:0;display:flex;align-items:stretch;max-width:520px;background:#1c1c1c;border-radius:3px 3px 3px 0;overflow:hidden;pointer-events:auto;font:500 11px/1.5 Inter,system-ui,sans-serif}
.li-box[data-flip] .li-bar{border-radius:0 0 3px 3px}
.li-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f1f1f1;padding:2px 7px}
.li-verb{flex:none;appearance:none;border:0;border-left:1px solid rgba(255,255,255,0.16);background:transparent;color:#f1f1f1;font:inherit;padding:2px 8px;cursor:pointer;white-space:nowrap}
.li-verb:hover{background:rgba(255,255,255,0.15)}
.li-verb:active{background:rgba(255,255,255,0.24)}
.li-hover{position:absolute;left:0;top:0;box-sizing:border-box;display:none;pointer-events:none;outline:1px solid rgba(255,255,255,0.6);box-shadow:0 0 0 2px rgba(0,0,0,0.3)}
.li-hover[data-show]{display:block}
.li-tag{position:absolute;left:0;top:0;transform:translateY(-100%);white-space:nowrap;background:rgba(28,28,28,0.86);color:#f1f1f1;font:600 10px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:0 5px;border-radius:3px 3px 3px 0}
.li-hover[data-flip] .li-tag{transform:none;border-radius:0 0 3px 3px}
`;

/**
 * One frame between hit tests.
 *
 * doop pays 40ms for the same gesture because its probe is a postMessage round
 * trip into a sandboxed iframe and back (`doop:hover`); onlook, whose frames
 * are same-origin, uses 16. Ours is a walk over nodes in this very document,
 * so it belongs with onlook.
 */
const HOVER_MS = 16;
/** Under this much room above the box the tag would be drawn off the canvas. */
const TAG_CLEAR_PX = 16;
/**
 * The chrome the toolbar has to get out from behind.
 *
 * Both of these are `position: fixed` at a corner with a z-index above this
 * overlay, which is right — a panel you are reading should not be covered by a
 * label. It does mean the label has to move instead.
 */
const PANEL_SELECTOR = ".ly-panel[data-show]:not([data-folded]),.pp-panel[data-show],.lt-note";
/** How long the copy verb says it worked before going back to its name. */
const COPIED_MS = 1200;

/**
 * The verbs, in the order they are offered.
 *
 * Every one of these already worked before the toolbar existed, behind a
 * gesture nobody had been told about: the comment behind a field in a panel,
 * the text edit behind a double-click that only fires once you are locked into
 * the screen, the location behind reading it off the panel and retyping it.
 * The toolbar adds no capability. It makes three of them findable, which on
 * 2026-09-10 turned out to be the part that was missing — the same evening
 * hover went in for the same reason.
 *
 * doop's bar reads `h1 | Comment | Ask AI | Code | Edit text`. Ours drops
 * "Ask AI", because here that is what leaving a comment IS: the note goes to
 * her with the file and line attached, and a second door to the same room
 * would only make people wonder which one is different.
 */
const VERBS = [
  { id: "say", label: "说" },
  { id: "text", label: "改文字" },
  { id: "code", label: "复制位置" },
] as const;
type VerbId = (typeof VERBS)[number]["id"];

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

/**
 * The deepest descendant of `root` whose box contains the point.
 *
 * An indexed loop, not for..of: this package's lib is ES2023+DOM without
 * DOM.Iterable, so iterating an HTMLCollection is a type error here (the same
 * reason `acquireStyles` uses .forEach).
 */
function deepestAt(root: Element, x: number, y: number): Element | null {
  let best: Element | null = null;
  const visit = (el: Element): void => {
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      if (!kid) continue;
      const r = kid.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        // Assigned in document order, so a later sibling and a deeper child
        // both win — the same way the document's own hit test resolves an
        // overlap, and the same answer it would give if it could see in here.
        best = kid;
      }
      // A box of zero size is not an answer, but its subtree still is. A
      // `display: contents` wrapper, a fragment host, or anything React mounts
      // into measures nothing while holding everything; skipping past it cost
      // the first version of this every element under it.
      visit(kid);
    }
  };
  visit(root);
  return best;
}

/**
 * Put `text` on the clipboard, by whichever of the two ways is allowed here.
 *
 * The async API is the right one and the one to try first. It is also the one
 * that can be switched off: measured 2026-09-10 in this lab's own preview
 * pane, `clipboard-write` came back `denied` and `writeText` threw
 * NotAllowedError on a real click, on a focused document. A verb that only
 * works in some browsers is a verb that reads as broken in the others.
 *
 * So the old way is kept as the fallback: a throwaway textarea, selected, and
 * `execCommand("copy")`, which is deprecated everywhere and implemented
 * everywhere, and which asks no permission because it can only copy what the
 * page already had. The caller's own selection is put back afterwards --
 * borrowing it and not returning it would clear whatever was highlighted on
 * the page.
 *
 * Returns whether it actually happened. Neither branch guesses.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    // Denied, insecure origin, or no clipboard object at all.
  }
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(area);
  const selection = document.getSelection();
  const prior = selection?.rangeCount ? selection.getRangeAt(0) : null;
  let ok = false;
  try {
    area.select();
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  if (prior && selection) {
    selection.removeAllRanges();
    selection.addRange(prior);
  }
  return ok;
}

/** Air between the outline and the label, so they read as two things. */
const BAR_GAP_PX = 3;

export type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Where to put the toolbar so it can actually be read.
 *
 * Its natural place is the top-left corner of the outline, sitting above it.
 * Two things take that away: the edges of the window, and the lab's own panels
 * — the layers tree pinned top-left and the properties panel pinned top-right,
 * both of which paint above this overlay on purpose. In fill mode, which is
 * where elements are worked on now, a design fills the window and those two
 * corners are exactly where headings and navs live.
 *
 * Three moves, in order, each one giving up as little as possible:
 *
 *  1. Slide it along the top of the box until it clears a panel horizontally.
 *     Cheapest — it stays attached to the same edge and stays above the thing
 *     it names.
 *  2. If sliding cannot clear it (the box is narrower than the gap it needs),
 *     drop it below the box, where the panels usually are not.
 *  3. Clamp into the window last, so a bar on a box at the very edge is
 *     trimmed by the window rather than drawn outside it.
 *
 * Nothing is done about a box entirely behind a panel: you cannot see the
 * element either, so there is nothing to label.
 */
export function placeBar(
  box: Box,
  bar: { width: number; height: number },
  panels: Box[],
  view: { width: number; height: number },
): { x: number; y: number; flip: boolean } {
  const hits = (x: number, y: number): boolean => {
    const rect = { left: x, top: y, right: x + bar.width, bottom: y + bar.height };
    return panels.some(
      (p) =>
        rect.left < p.right &&
        rect.right > p.left &&
        rect.top < p.bottom &&
        rect.bottom > p.top,
    );
  };
  const above = box.top - bar.height - BAR_GAP_PX;
  const below = box.bottom + BAR_GAP_PX;
  for (const [y, flip] of [
    [above, false],
    [below, true],
  ] as const) {
    if (y < 0 || y + bar.height > view.height) continue;
    const tries = [box.left];
    for (const p of panels) {
      // Just past its right edge, and just short of its left edge. Both are
      // only offered while they keep the bar somewhere over the box.
      tries.push(p.right, p.left - bar.width);
    }
    for (const x of tries) {
      if (x < 0 || x + bar.width > view.width) continue;
      if (x + bar.width < box.left || x > box.right) continue;
      if (!hits(x, y)) return { x, y, flip };
    }
  }
  // Nowhere clean. Keep it above and inside the window; a bar half under a
  // panel still reads better than one drawn off the canvas.
  const x = Math.max(0, Math.min(box.left, view.width - bar.width));
  const flip = above < 0;
  return { x, y: flip ? below : above, flip };
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
  /** The canvas's own size. The toolbar has to stay inside it. */
  private getViewport: () => { width: number; height: number };
  /** The canvas's object selection, so it can be kept from disagreeing with ours. */
  private objects: LabObjects | null;
  private elementsAt: InspectDeps["elementsAt"];
  private root: HTMLDivElement;
  private box: HTMLDivElement;
  private bar: HTMLDivElement;
  private label: HTMLDivElement;
  private verbs = new Map<VerbId, HTMLButtonElement>();
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverBox: HTMLDivElement;
  private hoverTag: HTMLDivElement;
  private hovered: Element | null = null;
  private lastHover = 0;
  private selected: Element | null = null;
  private snapshot: InspectSelection | null = null;
  private closed = false;
  private primeTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubHmr: (() => void) | null = null;

  constructor(opts: {
    host: HTMLElement;
    getOrigin: () => Point;
    getCamera: () => Camera;
    getViewport?: () => { width: number; height: number };
    objects?: LabObjects;
    elementsAt?: InspectDeps["elementsAt"];
  }) {
    this.objects = opts.objects ?? null;
    this.getOrigin = opts.getOrigin;
    this.getCamera = opts.getCamera;
    this.getViewport =
      opts.getViewport ??
      (() => ({
        width: typeof window === "undefined" ? 0 : window.innerWidth,
        height: typeof window === "undefined" ? 0 : window.innerHeight,
      }));
    this.elementsAt = opts.elementsAt ?? documentElementsAt;
    acquireStyles();
    this.root = document.createElement("div");
    this.root.className = "li-root";
    this.root.setAttribute("data-inspect-overlay", "");
    // Also the lab's own, which is what `\\` hides: an outline and its toolbar
    // are two halves of one thing and should leave together. No behaviour
    // changes — `SKIP_HOSTS` already listed both attributes.
    this.root.dataset.labChrome = "";
    this.box = document.createElement("div");
    this.box.className = "li-box";
    this.bar = document.createElement("div");
    this.bar.className = "li-bar";
    // The one line that makes the buttons clickable, and it is not obvious.
    //
    // A plain left press anywhere the canvas does not recognise starts a pan:
    // `canvas-input` calls `preventDefault()` and takes a pointer capture on
    // the root. preventDefault on a pointerdown suppresses the compatibility
    // mouse events, so `mousedown`, `mouseup` and `click` never happen —
    // measured on 2026-09-10, the button received `pointerdown` and nothing
    // else, and 改文字 did nothing at all while looking perfectly alive.
    //
    // `data-lab-chrome` is how the lab is told a press is spoken for
    // (lab-view's onPointerDown, and the wheel handler with it). The
    // properties panel and the coords chip already wear it; this is the same
    // house pattern and not a new one. The comment at that call site says the
    // same thing about frames: the capture a pan takes retargets the click.
    this.bar.dataset.labChrome = "";
    this.label = document.createElement("div");
    this.label.className = "li-label";
    this.bar.appendChild(this.label);
    for (const verb of VERBS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "li-verb";
      button.dataset.verb = verb.id;
      button.textContent = verb.label;
      button.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.runVerb(verb.id);
      });
      this.verbs.set(verb.id, button);
      this.bar.appendChild(button);
    }
    this.box.appendChild(this.bar);
    this.root.appendChild(this.box);
    this.hoverBox = document.createElement("div");
    this.hoverBox.className = "li-hover";
    this.hoverTag = document.createElement("div");
    this.hoverTag.className = "li-tag";
    this.hoverBox.appendChild(this.hoverTag);
    this.root.appendChild(this.hoverBox);
    opts.host.appendChild(this.root);
    window.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerleave", this.clearHover, true);
    window.addEventListener("scroll", this.onScroll, true);
    // In the browser a location is only as good as the source map that turns
    // the served coordinates back into the file's. Reading those is the one
    // asynchronous step in a synchronous path, so it happens here rather than
    // under the pointer — and again after a hot update, which serves every
    // touched module at a new URL with a new map.
    this.queuePrime();
    this.unsubHmr = subscribeScreenHotUpdate(() => this.queuePrime());
  }

  /**
   * Read the maps the screens on the page need, once the page has them.
   *
   * A macrotask late, deliberately: at construction React has not rendered the
   * screens yet, and the hot-update signal arrives on `vite:beforeUpdate`,
   * which is before the new modules have run. Landing early is not a
   * correctness problem — a lookup that misses starts its own read and says
   * `source-map-pending` — it only costs the first caller a second look.
   */
  private queuePrime(): void {
    if (this.closed || this.primeTimer !== null) return;
    if (typeof document === "undefined") return;
    this.primeTimer = setTimeout(() => {
      this.primeTimer = null;
      if (this.closed) return;
      void primeSourceLocations(document);
    }, 0);
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
    return this.hitByGeometry(clientX, clientY);
  }

  /**
   * Ask the screen, not the document.
   *
   * `elementsFromPoint` cannot see the contents of a screen that has not been
   * activated: the lab makes an inert screen's content `pointer-events: none`,
   * and a hit test skips those. The stack at a point over an inactive screen is
   * shield, scroller, frame, group, root — no content at all. Measured
   * 2026-09-10, and it is why selecting an element has only ever worked after
   * double-clicking into a screen first, Shift-click included.
   *
   * That is backwards for anything meant to teach: the moment you most need to
   * learn an element is addressable is before you know to activate anything.
   *
   * Both references solve it the same way and neither hit-tests from outside.
   * doop posts the point into the frame and lets the frame's own runtime answer
   * (`doop:hover`); onlook asks the frame view directly
   * (`frameData.view.getElementAtLoc(x, y)`). Ours are same-origin nodes in this
   * document, so asking the screen means walking its own subtree by rectangle —
   * and a rectangle knows nothing about `pointer-events`, which is exactly the
   * property that makes this work where the hit test cannot.
   *
   * Deepest wins, the same answer `elementsFromPoint` would give if it could
   * see. Zero-sized boxes are skipped: a wrapper with no area is not a thing you
   * pointed at.
   */
  private hitByGeometry(clientX: number, clientY: number): Element | null {
    if (typeof document === "undefined") return null;
    const scrollers = document.querySelectorAll("[data-screen-scroll]");
    for (let i = 0; i < scrollers.length; i++) {
      const scroll = scrollers[i];
      if (!scroll) continue;
      const box = scroll.getBoundingClientRect();
      if (
        clientX < box.left ||
        clientX > box.right ||
        clientY < box.top ||
        clientY > box.bottom
      )
        continue;
      const found = deepestAt(scroll, clientX, clientY);
      const hit = found ? this.qualify(found) : null;
      if (hit) return hit;
    }
    return null;
  }

  /**
   * The map arrived after the snapshot was taken. Put the real coordinates in
   * rather than leaving a selection that says it is still waiting; a caller
   * reading `selection()` a moment later then gets the answer.
   */
  private resnapWhenMapped(el: Element): void {
    void locateElementSourced(el).then((loc) => {
      if (this.closed || this.selected !== el || !this.snapshot) return;
      if (loc.problem === "source-map-pending") return;
      this.snapshot = {
        ...this.snapshot,
        file: loc.file,
        line: loc.line,
        column: loc.column,
        component: loc.component,
        problem: loc.problem,
      };
      this.label.textContent = this.labelText(this.snapshot);
      // The map arriving is what makes 复制位置 worth offering.
      this.syncVerbs();
    });
  }

  private capture(el: Element): InspectSelection {
    const loc = locateElement(el);
    if (loc.problem === "source-map-pending") this.resnapWhenMapped(el);
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

  /** The file and line, or what is missing — never `file.tsx:null`. */
  private static where(sel: InspectSelection): string {
    const base = sel.file?.split("/").pop();
    if (!base) return `source unknown (${sel.problem})`;
    if (sel.line === null) return `${base} (${sel.problem})`;
    return `${base}:${sel.line}`;
  }

  private labelText(sel: InspectSelection): string {
    const first = sel.className.trim().split(/\s+/)[0];
    const name = first ? `${sel.tag}.${first}` : sel.tag;
    return `${name} · ${Inspector.where(sel)}`;
  }

  /**
   * Imperative, and called from the lab's rAF after every camera write — so it
   * reads geometry and writes style, and never asks React to do anything.
   * `getBoundingClientRect` is already post-transform, which is why panning and
   * zooming need no camera maths here.
   */
  /**
   * The canvas the pointer is over, or null when the pointer is somewhere the
   * lab owns rather than a screen.
   */
  private canvasRoot(): Element | null {
    return this.root.closest("[data-mode]");
  }

  /**
   * Whether a plain click, right now, would select what is under the cursor.
   *
   * Fill mode, and only fill mode. That is the ▶ on a screen's label: camera
   * pinned to z=1, rulers and grid gone, one design filling the window at the
   * size it will really be. Nothing else on the canvas is competing for the
   * pointer there, and it is the one place where an element is big enough to
   * aim at.
   *
   * It was explore at first, on the reasoning that a screen's `.shield` takes
   * the press anyway so the app loses nothing. True, and beside the point: in
   * explore the objects are SCREENS. `startMove` selects the screen you press,
   * which is what puts the ▶ and the size badge on its label -- so a plain
   * press was selecting a screen and an element at once, and at the zoom you
   * actually explore at (14% here) the element under the cursor is two pixels
   * of something. Fei, 2026-09-10: 「现在我不太好选好像」. Two selections
   * answering one press is not a feature with a rough edge, it is two tools
   * fighting.
   *
   * Focus mode (double-click in) keeps its clicks for the app, because that is
   * what focus is for: the counter counts, the field types. Fill is for
   * looking, focus is for using, and Esc steps from one to the other.
   *
   * Shift-click still selects in every mode, live app included. That is the
   * chord for the times you want an element and are not in fill.
   *
   * The point tool owns the pointer outright while it is armed.
   */
  private plainClickSelects(): boolean {
    const root = this.canvasRoot();
    if (!root || root.hasAttribute("data-pick")) return false;
    return root.getAttribute("data-mode") === "fill";
  }

  /**
   * Outline whatever is under the cursor, and name it.
   *
   * The rule is one sentence: **show the outline exactly when a click would
   * take it.** Explore mode, where a plain click selects, so always; locked in,
   * where only Shift-click selects, so only while Shift is down. Nothing else
   * needs to be explained to anyone -- move the mouse and the answer is there.
   *
   * That mattered more than it sounds. Before this the only way to learn that
   * the things on these screens can be pointed at was for someone to tell you
   * the chord, and on 2026-09-10, days in, he asked what the notes were even
   * for. A feature nobody can find is not shipped.
   *
   * The whole overlay is `pointer-events: none` and reads nothing but the
   * cursor position, so it cannot swallow a click, a drag or a scroll.
   */
  private onPointerMove = (e: PointerEvent): void => {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastHover < HOVER_MS) return;
    this.lastHover = now;
    const root = this.canvasRoot();
    // Mid-drag the gesture is about the screen, not about anything inside it,
    // and the point tool paints a box of its own -- two outlines chasing one
    // cursor is noise, not information.
    if (!root || root.hasAttribute("data-dragging") || root.hasAttribute("data-pick")) {
      this.clearHover();
      return;
    }
    if (!e.shiftKey && !this.plainClickSelects()) {
      this.clearHover();
      return;
    }
    // Over the lab's own chrome the canvas does not answer, and does not take
    // back the answer it already gave.
    //
    // Leaving it alone is the whole rule. A row in the layers panel sets this
    // outline on `pointerenter`, and the `pointermove` for the very same
    // motion arrives a moment later with the row as its target -- so clearing
    // here erased the outline the panel had just asked for, every time.
    // Measured 2026-09-10: the badge said `a.wf-link` and the box was hidden.
    //
    // It is also the better behaviour on its own. Moving off an element to
    // read about it in a panel is not letting go of it; keeping the outline
    // while you are over the panel is what a devtools inspector does.
    if (Inspector.overChrome(e.target)) return;
    const hit = this.pickAt(e.clientX, e.clientY);
    // The selection already wears a heavier outline. Drawing the light one on
    // top of it only makes the selected thing look unselected.
    if (!hit || hit === this.selected) {
      this.clearHover();
      return;
    }
    if (hit !== this.hovered) this.hovered = hit;
    this.paintHover();
  };

  /** Our own overlay, toolbar included — never a target and never a miss. */
  private static isOurs(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest("[data-inspect-overlay]") !== null;
  }

  /** Anything the lab drew for itself: our overlay, and every panel and chip. */
  private static overChrome(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      target.closest("[data-inspect-overlay],[data-lab-chrome]") !== null
    );
  }

  private clearHover = (): void => {
    this.hovered = null;
    this.hoverBox.removeAttribute("data-show");
  };

  /** Screen-space, like `paint`: client rects in an untransformed host need no camera maths. */
  private paintHover = (): void => {
    const el = this.hovered;
    if (!el || !el.isConnected) {
      this.clearHover();
      return;
    }
    const r = el.getBoundingClientRect();
    const o = this.getOrigin();
    const top = r.top - o.y;
    this.hoverBox.style.transform = `translate(${r.left - o.x}px, ${top}px)`;
    this.hoverBox.style.width = `${r.width}px`;
    this.hoverBox.style.height = `${r.height}px`;
    this.hoverTag.textContent = Inspector.tagOf(el);
    // Against the top of the canvas the badge would be drawn off it. doop flips
    // the same badge inside the box for the same reason: a label you cannot
    // read is worse than one that overlaps by a few pixels.
    this.hoverBox.toggleAttribute("data-flip", top < TAG_CLEAR_PX);
    this.hoverBox.setAttribute("data-show", "");
  };

  /** `h1`, or `button.cta` -- enough to recognise it without reading the page. */
  private static tagOf(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const first = (el.getAttribute("class") ?? "").trim().split(/\s+/)[0];
    return first ? `${tag}.${first}` : tag;
  }

  /**
   * The other plugins are asked for by name at the moment of use, never
   * imported.
   *
   * `text` imports `SKIP_HOSTS` from this file, so an import the other way
   * would close a cycle; and the toolbar has to work when a plugin is not
   * mounted at all rather than fail to load. This is the same door the
   * properties panel already uses to reach `notes`.
   */
  private static other<T>(id: string): T | undefined {
    return window.lab?.plugin(id) as T | undefined;
  }

  /**
   * Offer only what would actually happen.
   *
   * A button that opens a text editor on a paragraph made of three spans is
   * worse than no button: it flies the camera into the screen and then does
   * nothing. `text.canEdit` answers the same question `begin` answers, minus
   * the mode, so the offer and the action cannot disagree.
   */
  private syncVerbs(): void {
    const el = this.selected;
    const snap = this.snapshot;
    const editor = Inspector.other<{ canEdit(el: Element): boolean }>("text");
    const can: Record<VerbId, boolean> = {
      say: snap !== null,
      text: el !== null && editor?.canEdit(el) === true,
      code: snap?.file !== null && snap?.line !== null,
    };
    for (const [id, button] of this.verbs) button.hidden = !can[id];
  }

  private runVerb(id: VerbId): void {
    if (this.closed) return;
    if (id === "say") {
      Inspector.other<{ say(text?: string): boolean }>("properties")?.say("");
      return;
    }
    if (id === "code") {
      void this.copyLocation();
      return;
    }
    this.editText();
  }

  /**
   * The location, as `file:line:col`, on the clipboard.
   *
   * The panel has shown this string for a while and there has never been a way
   * to get it out except retyping it off the screen. It is the form an editor's
   * go-to-file takes and the form a message to her takes, so it is one string
   * and not three.
   *
   * The button says so afterwards. A copy that leaves no trace is a copy you
   * press twice because you are not sure the first one took.
   */
  private async copyLocation(): Promise<void> {
    const snap = this.snapshot;
    const button = this.verbs.get("code");
    if (!snap?.file || snap.line === null || !button) return;
    const at = `${snap.file}:${snap.line}:${snap.column ?? 0}`;
    const ok = await copyText(at);
    if (this.closed) return;
    if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
    // Both answers are said out loud. A button that looks alive and quietly
    // does nothing is worse than one that admits it could not — you press the
    // silent one again, and again, and never learn why.
    button.textContent = ok ? "已复制" : "复制不了";
    this.copiedTimer = setTimeout(() => {
      this.copiedTimer = null;
      if (this.closed) return;
      button.textContent = "复制位置";
    }, COPIED_MS);
  }

  /**
   * Lock into the screen, then open the editor on the element.
   *
   * `text.begin` refuses in explore mode, and it is right to: a double-click
   * out on the canvas is not an edit. But pressing a button that says 改文字
   * IS, so the camera moves first and the edit follows — the two steps a
   * person would otherwise do in order, done in order.
   *
   * A tick between them, because locking in re-renders the screen slot; the
   * node is re-read from the live selection afterwards rather than trusted,
   * and if the render replaced it, nothing happens instead of an edit landing
   * on a detached node.
   */
  private editText(): void {
    const el = this.selected;
    const screenId = this.snapshot?.screenId;
    if (!el || !screenId) return;
    const canvas = window.lab?.canvas;
    if (canvas && canvas.state().focusedId !== screenId) canvas.lockInto(screenId);
    setTimeout(() => {
      if (this.closed) return;
      const live = this.selected;
      if (!live || !live.isConnected) return;
      Inspector.other<{ begin(el: Element): boolean }>("text")?.begin(live);
    }, 0);
  }

  private paint = (): void => {
    const el = this.selected;
    if (!el || !el.isConnected) {
      this.box.removeAttribute("data-show");
      return;
    }
    const r = el.getBoundingClientRect();
    const o = this.getOrigin();
    const left = r.left - o.x;
    const top = r.top - o.y;
    this.box.style.transform = `translate(${left}px, ${top}px)`;
    this.box.style.width = `${r.width}px`;
    this.box.style.height = `${r.height}px`;
    this.box.setAttribute("data-show", "");
    this.placeToolbar(left, top, r.width, r.height);
  };

  /**
   * Put the toolbar somewhere it can be read, and offset it from the box.
   *
   * The bar is a child of the box, so `placeBar` works in the overlay's own
   * coordinates and the answer comes back as a translate relative to the box's
   * top-left. Measured after the box is shown, because a hidden element has no
   * width and the bar's width is what the whole decision turns on.
   */
  private placeToolbar(left: number, top: number, width: number, height: number): void {
    const view = this.getViewport();
    const bar = this.bar.getBoundingClientRect();
    if (bar.width === 0) return;
    const spot = placeBar(
      { left, top, right: left + width, bottom: top + height },
      { width: bar.width, height: bar.height },
      this.panelBoxes(),
      view,
    );
    this.box.toggleAttribute("data-flip", spot.flip);
    this.bar.style.transform = `translate(${spot.x - left}px, ${spot.y - top}px)`;
  }

  /**
   * The lab's panels, in overlay coordinates.
   *
   * Read from the document rather than wired in: a panel is any chrome that
   * paints above this overlay, the set of them changes as plugins come and go,
   * and none of them is this plugin's business beyond "do not hide behind it".
   * A folded or hidden panel has no box and is skipped by the size test.
   */
  private panelBoxes(): Box[] {
    if (typeof document === "undefined") return [];
    const o = this.getOrigin();
    const out: Box[] = [];
    document.querySelectorAll(PANEL_SELECTOR).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      out.push({
        left: r.left - o.x,
        top: r.top - o.y,
        right: r.right - o.x,
        bottom: r.bottom - o.y,
      });
    });
    return out;
  }

  private onScroll = (): void => {
    if (this.selected) this.paint();
    if (this.hovered) this.paintHover();
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    // A press on our own toolbar is that button's press. Falling through would
    // hit-test the canvas, find our chrome, qualify nothing, and clear the
    // selection the button was about to act on.
    if (Inspector.isOurs(e.target)) return;
    if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const direct = e.target instanceof Element ? this.qualify(e.target) : null;
      const hit = direct ?? this.pickAt(e.clientX, e.clientY);
      if (!hit) {
        // Shift-click on bare canvas is how you let go without leaving the
        // mode you are in. Not swallowed: the canvas may want it too.
        this.clear();
        return;
      }
      // On something: ours outright, in every mode, live app included.
      e.preventDefault();
      e.stopPropagation();
      this.selectElement(hit);
      return;
    }
    if (this.plainClickSelects()) {
      // Fill mode: this press is ours outright, and swallowing it is the point.
      // The screen's content is `pointer-events: auto` in fill the same as in
      // focus, so a click that both selected the heading AND submitted the form
      // under it would be the worst of both -- you would learn to distrust the
      // outline. Nothing here is draggable (the canvas does not pan while
      // locked, and `startMove` returns early outside explore), so there is no
      // gesture left to protect by waiting for the release.
      const direct = e.target instanceof Element ? this.qualify(e.target) : null;
      const hit = direct ?? this.pickAt(e.clientX, e.clientY);
      e.preventDefault();
      e.stopPropagation();
      if (hit) this.selectElement(hit);
      else this.clear();
      return;
    }
    // Every other press is the canvas's -- panning, dragging a screen, using a
    // live app -- and we touch nothing at all, the selection included. Dropping
    // it here is what the first version did, and it meant that panning the
    // canvas, or pressing a screen to drag it, silently emptied the properties
    // panel. Shift-click on bare canvas is the way to let go on purpose.
  };

  /** Select a node directly. Returns the same payload as `selection()`. */
  selectElement(el: Element): InspectSelection | null {
    if (this.closed) return null;
    if (!this.qualify(el)) return null;
    this.selected = el;
    // The heavy ring is about to land exactly here. Leaving the light one
    // under it draws two rings around one element, which reads as neither.
    if (this.hovered === el) this.clearHover();
    this.snapshot = this.capture(el);
    this.followScreen(this.snapshot.screenId);
    this.label.textContent = this.labelText(this.snapshot);
    this.syncVerbs();
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

  /**
   * Move the canvas's own selection to the screen this element is in.
   *
   * Two selections used to be lit at once, in two places, about two different
   * things: a size badge reading `1440 × 2327` over one screen because it was
   * the last one pressed, and an outline with a toolbar over an element in
   * another. Measured 2026-09-10, and Fei's word for it was 「好怪」.
   *
   * They are not two questions. Picking a heading in the layers tree is saying
   * which screen you are working on as much as which element, and the badge
   * and the ▶ on a screen's label should be about the screen you are in.
   * Figma answers the same way: selecting a layer inside a frame does not
   * leave some other frame selected.
   *
   * Only when it differs, because `selectObject` bumps React and there is no
   * reason to do that for every re-selection of the same screen.
   */
  private followScreen(screenId: string | null): void {
    if (!screenId || !this.objects) return;
    if (this.objects.selectedId() === screenId) return;
    this.objects.select(screenId);
  }

  /** The node the outline is on, for a caller that needs the node and not a description of it. */
  selectedElement(): Element | null {
    const el = this.selected;
    return el && el.isConnected ? el : null;
  }

  /**
   * Put the hover outline on a node, or take it off, without a pointer.
   *
   * The cursor is one way to say which element is interesting and it is not
   * the only one: a row in the layers panel means exactly the same thing, and
   * pointing at it should light the same box on the canvas. Same outline, same
   * badge, same rules -- lab chrome is never a target, and the selection keeps
   * its own heavier ring rather than wearing both.
   *
   * The next real pointer move overrules whatever was set here, which is the
   * behaviour you want: the mouse is on the canvas again, so the canvas
   * answers.
   */
  hoverElement(el: Element | null): boolean {
    if (this.closed) return false;
    if (!el) {
      this.clearHover();
      return false;
    }
    if (!this.qualify(el) || el === this.selected) {
      this.clearHover();
      return false;
    }
    this.hovered = el;
    this.paintHover();
    return true;
  }

  /** The hover outline's box in PAGE units, or null when nothing is hovered. */
  hoverRect(): Rect | null {
    const el = this.hovered;
    if (!el || !el.isConnected) return null;
    if (!this.hoverBox.hasAttribute("data-show")) return null;
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
    // The cursor has not moved but the thing under it has. Leaving the outline
    // where it was would draw a box around empty canvas.
    if (this.hovered) this.paintHover();
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.clear();
    if (this.primeTimer !== null) {
      clearTimeout(this.primeTimer);
      this.primeTimer = null;
    }
    this.unsubHmr?.();
    this.unsubHmr = null;
    if (this.copiedTimer !== null) {
      clearTimeout(this.copiedTimer);
      this.copiedTimer = null;
    }
    this.clearHover();
    window.removeEventListener("pointerdown", this.onPointerDown, true);
    window.removeEventListener("pointermove", this.onPointerMove, true);
    window.removeEventListener("pointerleave", this.clearHover, true);
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
    getViewport: ctx.getViewport,
    objects: ctx.objects,
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
        "The selected element, or null if nothing is selected. `file` is repo-relative (e.g. packages/design-lab/src/screens/playground/screen.tsx) and `line`/`column` point at the JSX tag that made the node IN THE SOURCE FILE, read from React's dev-only `_debugStack` and mapped back through the served module's source map — the raw stack is in the coordinates of what vite built, which are different numbers. When the location cannot be resolved `line` and `column` are null and `problem` says why: no-react-fiber (not made by React), no-debug-stack (React is a production build, so there is nothing to read), no-project-source-frame (every frame was vendor code), source-map-pending (the module's map was not read yet — ask once more and it will be), source-map-unavailable (the module was read and its map cannot place this spot). On the two source-map problems `file` and `component` are still real. Screens hot-reload, so a selected node can be replaced: then `attached` is false and `problem` is node-detached, and the other fields are the snapshot taken when it was selected, not a live read.",
    },
    {
      name: "selectAt",
      signature: "selectAt(x: number, y: number): selection | null",
      summary:
        "Select the deepest screen element at a PAGE-unit point — the way to drive this without a mouse. Page units, not screen pixels, so the answer does not change when the canvas zooms. Lab chrome, sticky notes, labels, rulers and the scroller itself are never hit. Returns the new selection, or null (and clears) if nothing qualifies there. By hand the same thing happens on a plain click in FILL mode — the ▶ on a screen's label, where one design fills the window at 1:1 — or on Shift-click in any mode, including a screen that is locked in and live. A selected element also grows a toolbar above its outline carrying its name and location and three verbs — 说 (leave her a comment on this tag), 改文字 (lock into the screen and edit the copy in place), 复制位置 (put file:line:col on the clipboard) — and each one is hidden when it would not work.",
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
      name: "hoverRect",
      signature: "hoverRect(): { x, y, width, height } | null",
      summary:
        "Where the HOVER outline is, in PAGE units, or null when nothing is hovered. The hover outline is the light box that follows the cursor and carries a tag badge (`h1`, `button.cta`); it appears exactly when a click would select what is under the pointer — always in fill mode, and only while Shift is held anywhere else, where plain clicks belong to the canvas or to the live app. It never takes pointer events, so it costs the screens nothing. Use this to check the box really lands on the element without taking a screenshot.",
    },
    {
      name: "selectedElement",
      signature: "selectedElement(): Element | null",
      summary:
        "The selected NODE itself, rather than a description of it. Null when nothing is selected or the node has been detached by a hot reload. For a caller that has to compare it against the DOM — a layers tree deciding which of its rows is the selected one, say. Everything else should read `selection()`.",
    },
    {
      name: "hoverElement",
      signature: "hoverElement(el: Element | null): boolean",
      summary:
        "Put the hover outline on a node without a pointer, or pass null to take it off. Returns false (and clears) for anything that is not screen content, and for the selected element, which keeps its own heavier outline instead of wearing both. The next real mouse move overrules it. This is how a list somewhere else in the lab lights up the thing a row is about.",
    },
    {
      name: "clear",
      signature: "clear(): void",
      summary:
        "Drop the selection and hide the outline. Clicking empty canvas does this too.",
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
