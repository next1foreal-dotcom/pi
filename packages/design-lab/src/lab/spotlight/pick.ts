import { toolbarPlacement } from "../core/page-notes";
import { isTypingTarget } from "../core/math";
import type { Camera, Point } from "../core/types";
import { clientRectToCanvas } from "./geometry";
import styles from "./overlay.module.css";
import { sourceOf, type SourceRef } from "./source-probe";

export type { SourceRef };

/** Hosts that must never be a pick target. */
export const SKIP_HOSTS =
  "[data-notes-host],[data-labels-host],[data-ruler-host],[data-lab-chrome]";

const SPEAK_OFFSET = 16;

export type SpeakNoteInit = {
  x: number;
  y: number;
  source?: SourceRef | null;
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

  const paint = () => {
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
    box.style.transform = `translate(${page.x}px, ${page.y}px)`;
    box.style.width = `${page.width}px`;
    box.style.height = `${page.height}px`;
    box.setAttribute("data-show", "");
    box.toggleAttribute("data-selected", selected !== null);
    if (selected) {
      const source = sourceOf(selected);
      label.textContent = chipLabel(source);
      const screen = selected.getBoundingClientRect();
      const at = toolbarPlacement(
        { top: screen.top, left: screen.left, width: screen.width },
        window.innerWidth,
      );
      box.toggleAttribute("data-flip", at.flip);
      box.toggleAttribute("data-tb-right", at.anchor === "right");
      box.toggleAttribute("data-tb-left", at.anchor === "left");
    }
  };

  const enter = () => {
    if (active) return;
    active = true;
    setRootPick(true);
    paint();
  };

  const exit = () => {
    if (!active) return;
    active = false;
    hover = null;
    selected = null;
    setRootPick(false);
    paint();
  };

  const toggle = () => {
    if (active) exit();
    else enter();
  };

  const onMove = (e: PointerEvent) => {
    if (!active || selected) return;
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
    selected = el;
    hover = el;
    paint();
  };

  const onScroll = () => {
    if (active) paint();
  };

  speak.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
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
      window.removeEventListener("scroll", onScroll, true);
      box.remove();
    },
  };
}
