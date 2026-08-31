import { animateCamera, cancelCameraAnimation } from "../core/animate-camera";
import { getCamera } from "../core/camera";
import type { Point, Rect } from "../core/types";
import { clientRectToCanvas, isValidRect } from "./geometry";
import { subscribeScreenHotUpdate } from "./hmr";
import { setSpotlightOverlay } from "./overlay-store";
import { createSpotlightRuntime, type SpotlightRuntime } from "./spotlight-runtime";

let active: SpotlightRuntime | null = null;

export function notifySpotlightGesture(): void {
  active?.noteGesture();
}

const IGNORE =
  "[data-notes-host],[data-labels-host],[data-ruler-host],[data-lab-chrome],[data-spotlight-overlay]";

function mutationTarget(node: Node): Element | null {
  if (node.nodeType === Node.TEXT_NODE) return node.parentElement;
  if (node instanceof Element) return node;
  return null;
}

export function attachLabSpotlight(opts: {
  getRoot: () => HTMLElement | null;
  getOrigin: () => Point;
  getViewport: () => { width: number; height: number };
}): () => void {
  const runtime = createSpotlightRuntime({
    nowMs: () => performance.now(),
    isHidden: () => document.hidden,
    prefersReducedMotion: () =>
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    getCamera,
    getViewport: opts.getViewport,
    getOrigin: opts.getOrigin,
    animateCamera,
    cancelCameraAnimation,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => {
      window.clearTimeout(id);
    },
    setOverlay: setSpotlightOverlay,
  });
  active = runtime;

  const unsubHmr = subscribeScreenHotUpdate(() => runtime.noteHmr());

  const onVis = () => {
    if (document.hidden) runtime.noteHidden();
    else runtime.noteVisible();
  };
  document.addEventListener("visibilitychange", onVis);

  const observer = new MutationObserver((records) => {
    const origin = opts.getOrigin();
    const cam = getCamera();
    const rects: Rect[] = [];
    let fallback: Rect | null = null;
    for (const rec of records) {
      const el = mutationTarget(rec.target);
      if (!el) continue;
      if (el.closest(IGNORE)) continue;
      const scroll = el.closest("[data-screen-scroll]");
      if (!scroll) continue;
      const screen = el.closest("[data-screen-id]");
      if (!(screen instanceof HTMLElement)) continue;
      const boxEl = el instanceof HTMLElement ? el : screen;
      const page = clientRectToCanvas(
        boxEl.getBoundingClientRect(),
        cam,
        origin,
      );
      if (isValidRect(page)) rects.push(page);
      const screenPage = clientRectToCanvas(
        screen.getBoundingClientRect(),
        cam,
        origin,
      );
      if (isValidRect(screenPage)) fallback = screenPage;
    }
    if (rects.length === 0 && !fallback) return;
    runtime.noteMutation(
      rects,
      fallback ?? { x: 0, y: 0, width: 1, height: 1 },
    );
  });

  const root = opts.getRoot();
  if (root) {
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  }

  return () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", onVis);
    unsubHmr();
    if (active === runtime) active = null;
    runtime.dispose();
  };
}
