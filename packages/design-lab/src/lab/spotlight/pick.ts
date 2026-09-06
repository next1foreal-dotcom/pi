import { toolbarPlacement } from "../core/page-notes";
import { isTypingTarget, pageToScreen } from "../core/math";
import type { Camera, Point, Rect } from "../core/types";
import { clientRectToCanvas } from "./geometry";
import styles from "./overlay.module.css";
import { sourceOf, type SourceRef } from "./source-probe";

export type { SourceRef };

/** Hosts that must never be a pick target. */
export const SKIP_HOSTS =
  "[data-notes-host],[data-labels-host],[data-ruler-host],[data-lab-chrome]";

const SPEAK_OFFSET = 16;
/** Client px of travel before a press is a drag rather than a click. */
const DRAG_MIN = 4;
/** Page px below which a released drag is treated as the click it probably was. */
const REGION_MIN = 8;
/** Slack when asking whether an element contains the region, in client px. */
const CONTAIN_SLACK = 1;

export type SpeakNoteInit = {
  x: number;
  y: number;
  source?: SourceRef | null;
  /** Page-space rect the note is about, when it was drawn rather than clicked. */
  region?: Rect | null;
};

export type PickTool = {
  isActive(): boolean;
  enter(): void;
  exit(): void;
  toggle(): void;
  handleKey(e: KeyboardEvent): boolean;
  onCameraWrite(): void;
  destroy(): void;
};

export function pickableFrom(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(SKIP_HOSTS)) return null;
  const scroll = target.closest("[data-screen-scroll]");
  if (!scroll) return null;
  if (target === scroll) return null;
  return target;
}

function chipLabel(source: SourceRef | null): string {
  if (!source) return "";
  const base = source.file.split("/").pop() ?? source.file;
  const loc = `${base}:${source.line}`;
  return source.component ? `${source.component} · ${loc}` : loc;
}

function pageBox(
  el: Element,
  camera: Camera,
  origin: Point,
): { x: number; y: number; width: number; height: number } | null {
  const page = clientRectToCanvas(el.getBoundingClientRect(), camera, origin);
  if (!(page.width > 0 && page.height > 0)) return null;
  return page;
}

type ClientBox = { left: number; top: number; right: number; bottom: number };

/**
 * The innermost element that holds the WHOLE box.
 *
 * A drawn region is not an element, so the honest thing to name it by is what
 * it was drawn inside. `elementsFromPoint` runs innermost first, so the first
 * one whose own rect swallows the region is the tightest answer; a region that
 * straddles two siblings gets their parent, which is correct rather than a coin
 * flip between the two.
 */
function containerOf(box: ClientBox): Element | null {
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  for (const candidate of document.elementsFromPoint(cx, cy)) {
    const el = pickableFrom(candidate);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (
      r.left <= box.left + CONTAIN_SLACK &&
      r.top <= box.top + CONTAIN_SLACK &&
      r.right >= box.right - CONTAIN_SLACK &&
      r.bottom >= box.bottom - CONTAIN_SLACK
    )
      return el;
  }
  return null;
}

/**
 * Screen-px box for toolbarPlacement. `top` is the smaller of viewport top and
 * offset from the screen frame, so FLIP_CLEAR covers both "off the viewport"
 * and "onto the frame name" without a second threshold.
 */
function placementBox(
  box: ClientBox,
  frame: Element | null,
): { top: number; left: number; width: number } {
  const frameTop = frame ? frame.getBoundingClientRect().top : 0;
  return {
    top: Math.min(box.top, box.top - frameTop),
    left: box.left,
    width: box.right - box.left,
  };
}

export function createPickTool(opts: {
  host: HTMLElement;
  getRoot: () => HTMLElement | null;
  getOrigin: () => Point;
  getCamera: () => Camera;
  spawnNote: (init: SpeakNoteInit) => void;
}): PickTool {
  let active = false;
  let hover: Element | null = null;
  let selected: Element | null = null;
  /** Live drag, in client px. Null between gestures. */
  let drag:
    | { from: Point; to: Point; candidate: Element | null; moved: boolean }
    | null = null;
  /** A released region, in PAGE px — client coords go stale the moment the camera moves. */
  let region: Rect | null = null;
  /** What that region was drawn inside, for the label and the note's source. */
  let host: Element | null = null;

  const box = document.createElement("div");
  box.className = styles.pickBox;
  box.setAttribute("data-pick-overlay", "");
  const chip = document.createElement("div");
  chip.className = styles.pickChip;
  chip.dataset.labChrome = "";
  const label = document.createElement("span");
  const speak = document.createElement("button");
  speak.type = "button";
  speak.className = styles.pickSpeak;
  speak.setAttribute("data-pick-speak", "");
  speak.textContent = "说这里";
  chip.append(label, speak);
  box.appendChild(chip);
  opts.host.appendChild(box);

  const setRootPick = (on: boolean) => {
    const root = opts.getRoot();
    if (!root) return;
    if (on) root.setAttribute("data-pick", "");
    else root.removeAttribute("data-pick");
  };

  // Only a drag that has actually gone somewhere has a box. A press that has
  // not moved is still a click, and painting its zero-size band would blank the
  // chip the press just earned.
  const dragBox = (): ClientBox | null => {
    if (!drag?.moved) return null;
    return {
      left: Math.min(drag.from.x, drag.to.x),
      top: Math.min(drag.from.y, drag.to.y),
      right: Math.max(drag.from.x, drag.to.x),
      bottom: Math.max(drag.from.y, drag.to.y),
    };
  };

  const draw = (page: Rect) => {
    box.style.transform = `translate(${page.x}px, ${page.y}px)`;
    box.style.width = `${page.width}px`;
    box.style.height = `${page.height}px`;
    box.setAttribute("data-show", "");
  };

  /** Place the chip against the box it describes, in client px. */
  const placeChip = (client: ClientBox, frame: Element | null) => {
    const at = placementBox(client, frame);
    const where = toolbarPlacement(at, window.innerWidth);
    box.toggleAttribute("data-flip", where.flip);
    box.toggleAttribute("data-tb-right", where.anchor === "right");
    box.toggleAttribute("data-tb-left", where.anchor === "left");
  };

  const paint = () => {
    // Mid-drag: the rubber band, no chip. Asking "say something about this?"
    // while the pointer is still moving is a question about a box that does
    // not exist yet.
    const live = dragBox();
    if (active && live) {
      draw(clientRectToCanvas(live, opts.getCamera(), opts.getOrigin()));
      box.setAttribute("data-region", "");
      box.removeAttribute("data-selected");
      label.textContent = "";
      return;
    }

    if (active && region) {
      draw(region);
      box.setAttribute("data-region", "");
      box.setAttribute("data-selected", "");
      label.textContent = host ? chipLabel(sourceOf(host)) : "";
      const camera = opts.getCamera();
      const origin = opts.getOrigin();
      const tl = pageToScreen({ x: region.x, y: region.y }, camera, origin);
      const br = pageToScreen(
        { x: region.x + region.width, y: region.y + region.height },
        camera,
        origin,
      );
      placeChip(
        { left: tl.x, top: tl.y, right: br.x, bottom: br.y },
        host?.closest("[data-screen-id]") ?? null,
      );
      return;
    }

    box.removeAttribute("data-region");
    const el = selected ?? hover;
    if (!active || !el) {
      box.removeAttribute("data-show");
      box.removeAttribute("data-selected");
      return;
    }
    const page = pageBox(el, opts.getCamera(), opts.getOrigin());
    if (!page) {
      box.removeAttribute("data-show");
      return;
    }
    draw(page);
    box.toggleAttribute("data-selected", selected !== null);
    if (selected) {
      label.textContent = chipLabel(sourceOf(selected));
      placeChip(
        selected.getBoundingClientRect(),
        selected.closest("[data-screen-id]"),
      );
    }
  };

  const enter = () => {
    if (active) return;
    active = true;
    setRootPick(true);
    paint();
  };

  const clearGesture = () => {
    drag = null;
    region = null;
    host = null;
  };

  const exit = () => {
    if (!active) return;
    active = false;
    hover = null;
    selected = null;
    clearGesture();
    setRootPick(false);
    paint();
  };

  const toggle = () => {
    if (active) exit();
    else enter();
  };

  const onMove = (e: PointerEvent) => {
    if (!active) return;
    if (drag) {
      const far =
        Math.abs(e.clientX - drag.from.x) > DRAG_MIN ||
        Math.abs(e.clientY - drag.from.y) > DRAG_MIN;
      // Once it is a drag it stays one, or letting go back near the start would
      // snap to picking whatever element is under the cursor.
      if (!far && !drag.moved) return;
      drag.moved = true;
      drag.to = { x: e.clientX, y: e.clientY };
      selected = null;
      hover = null;
      region = null;
      host = null;
      paint();
      return;
    }
    if (selected || region) return;
    const next = pickableFrom(e.target);
    if (next === hover) return;
    hover = next;
    paint();
  };

  const onDown = (e: PointerEvent) => {
    if (!active) return;
    if (!(e.target instanceof Element)) return;
    if (chip.contains(e.target)) return;
    const el = pickableFrom(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    // Select it now, the way a press always has -- waiting for the release to
    // draw the outline would make every click feel late. A drag takes it back
    // below, and only if the pointer really leaves.
    const from = { x: e.clientX, y: e.clientY };
    drag = { from, to: from, candidate: el, moved: false };
    region = null;
    host = null;
    selected = el;
    hover = el;
    paint();
  };

  const onUp = () => {
    if (!active || !drag) return;
    const live = dragBox();
    const candidate = drag.candidate;
    drag = null;
    const page = live
      ? clientRectToCanvas(live, opts.getCamera(), opts.getOrigin())
      : null;
    if (live && page && page.width >= REGION_MIN && page.height >= REGION_MIN) {
      region = page;
      host = containerOf(live);
      selected = null;
      hover = null;
    } else {
      // A press that wandered a pixel or two is a click, and always was.
      selected = selected ?? candidate;
      hover = selected;
    }
    paint();
  };

  const onScroll = () => {
    if (active) paint();
  };

  speak.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (region) {
      opts.spawnNote({
        x: region.x + region.width + SPEAK_OFFSET,
        y: region.y,
        source: host ? sourceOf(host) : null,
        region,
      });
      return;
    }
    if (!selected) return;
    const page = pageBox(selected, opts.getCamera(), opts.getOrigin());
    if (!page) return;
    opts.spawnNote({
      x: page.x + page.width + SPEAK_OFFSET,
      y: page.y,
      source: sourceOf(selected),
    });
  });

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("scroll", onScroll, true);

  return {
    isActive: () => active,
    enter,
    exit,
    toggle,
    handleKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
      // "I" for inspect. NOT "P": the coords plugin already owns that, and
      // taking a working shortcut away from an existing tool to feed a new
      // one is a regression, not a trade.
      if (e.code === "KeyI") {
        if (isTypingTarget(e.target)) return false;
        e.preventDefault();
        toggle();
        return true;
      }
      if (e.key === "Escape" && active) {
        if (isTypingTarget(e.target)) return false;
        e.preventDefault();
        // A drawn region is worth one Escape of its own: dropping it and the
        // whole tool on the same key means one stray Escape costs the box you
        // just spent a gesture on.
        if (region || drag) {
          clearGesture();
          selected = null;
          hover = null;
          paint();
          return true;
        }
        exit();
        return true;
      }
      return false;
    },
    onCameraWrite: paint,
    destroy() {
      exit();
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("scroll", onScroll, true);
      box.remove();
    },
  };
}
