import type { Rect } from "../core/types";

export type OverlaySnap = {
  rect: Rect | null;
  lastRect: Rect | null;
  fast: boolean;
};

let snap: OverlaySnap = { rect: null, lastRect: null, fast: false };
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function getSpotlightOverlay(): OverlaySnap {
  return snap;
}

export function subscribeSpotlightOverlay(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setSpotlightOverlay(rect: Rect | null, fast: boolean): void {
  snap = {
    rect,
    lastRect: rect ?? snap.rect ?? snap.lastRect,
    fast,
  };
  emit();
}
