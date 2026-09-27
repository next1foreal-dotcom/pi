import { animateCamera, cancelCameraAnimation } from "../core/animate-camera";
import { getCamera } from "../core/camera";
import type { Point, Rect } from "../core/types";
import { handLabel, watchedScreenId } from "../hand/place";
import { hideHand, pinHandOnWatched } from "../hand/store";
import { currentWork, subscribeWork, workKey } from "../hand/work";
import {
  locateElement,
  primeSourceLocations,
  sourceKeysOf,
} from "../plugins/inspect/source-location";
import { clientRectToCanvas, isValidRect } from "./geometry";
import { subscribeScreenHotUpdate } from "./hmr";
import { setSpotlightOverlay } from "./overlay-store";
import { createSpotlightRuntime, type SpotlightRuntime } from "./spotlight-runtime";

let active: SpotlightRuntime | null = null;

export function notifySpotlightGesture(): void {
  hideHand();
  active?.noteGesture();
}

function canvasLocked(): boolean {
  const canvas = window.lab?.canvas;
  return canvas !== undefined && canvas.state().mode !== "explore";
}

const IGNORE =
  "[data-notes-host],[data-labels-host],[data-ruler-host],[data-lab-chrome],[data-spotlight-overlay],[data-lab-hand]";

function watchingId(): string | null {
  const canvas = window.lab?.canvas;
  if (!canvas) return null;
  const state = canvas.state();
  const mode = state.mode;
  if (mode !== "explore" && mode !== "focus" && mode !== "fill") return null;
  return watchedScreenId({ mode, focusedId: state.focusedId });
}

function labelOf(el: Element): string {
  const loc = locateElement(el);
  return handLabel({
    component: loc.component,
    tag: el.tagName.toLowerCase(),
  });
}

function screenRoot(id: string): ParentNode | null {
  const all = document.querySelectorAll("[data-screen-scroll]");
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].getAttribute("data-screen-scroll") === id) return all[i];
  }
  return null;
}

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
    isLocked: canvasLocked,
    getCamera,
    getViewport: opts.getViewport,
    getOrigin: opts.getOrigin,
    animateCamera,
    cancelCameraAnimation,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => {
      window.clearTimeout(id);
    },
    setOverlay: (rect, fast) => {
      setSpotlightOverlay(rect, fast);
    },
  });
  active = runtime;

  const unsubHmr = subscribeScreenHotUpdate(() => runtime.noteHmr());

  const onVis = () => {
    if (document.hidden) runtime.noteHidden();
    else runtime.noteVisible();
  };
  document.addEventListener("visibilitychange", onVis);

  const pinLiveWork = (): void => {
    const work = currentWork();
    const watch = watchingId();
    if (!work || !watch) return;
    const host = screenRoot(watch);
    if (!host) return;
    const key = workKey(work);
    void primeSourceLocations(host).then(() => {
      if (currentWork() !== work) return;
      const origin = opts.getOrigin();
      const cam = getCamera();
      const marks: {
        screenId: string;
        rect: Rect;
        label: string;
        keys: string[];
      }[] = [];
      host.querySelectorAll("*").forEach((el) => {
        if (el.closest(IGNORE)) return;
        const keys = sourceKeysOf(el);
        if (!keys.includes(key)) return;
        const page = clientRectToCanvas(
          el.getBoundingClientRect(),
          cam,
          origin,
        );
        if (!isValidRect(page)) return;
        marks.push({
          screenId: watch,
          rect: page,
          label: work.label,
          keys,
        });
      });
      pinHandOnWatched(marks, watch, work);
    });
  };
  const unsubWork = subscribeWork(pinLiveWork);

  const observer = new MutationObserver((records) => {
    const origin = opts.getOrigin();
    const cam = getCamera();
    const watch = watchingId();
    const marks: { screenId: string; rect: Rect; label: string; keys: string[] }[] = [];
    let fallback: Rect | null = null;
    for (const rec of records) {
      const el = mutationTarget(rec.target);
      if (!el) continue;
      if (el.closest(IGNORE)) continue;
      const scroll = el.closest("[data-screen-scroll]");
      if (!scroll) continue;
      const screen = el.closest("[data-screen-id]");
      if (!(screen instanceof HTMLElement)) continue;
      const screenId = screen.getAttribute("data-screen-id");
      if (!screenId) continue;
      if (watch && screenId !== watch) continue;
      const boxEl = el instanceof HTMLElement ? el : screen;
      const page = clientRectToCanvas(
        boxEl.getBoundingClientRect(),
        cam,
        origin,
      );
      if (isValidRect(page)) {
        marks.push({
          screenId,
          rect: page,
          label: labelOf(el),
          keys: sourceKeysOf(el),
        });
      }
      const screenPage = clientRectToCanvas(
        screen.getBoundingClientRect(),
        cam,
        origin,
      );
      if (isValidRect(screenPage)) fallback = screenPage;
    }
    if (marks.length === 0 && !fallback) return;
    if (marks.length > 0) {
      pinHandOnWatched(marks, watchingId(), currentWork());
    }
    runtime.noteMutation(
      marks.map((m) => m.rect),
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
    unsubWork();
    if (active === runtime) active = null;
    runtime.dispose();
  };
}
