import type { Camera } from "./types";
import { INTERACTIVE_Z_MAX, INTERACTIVE_Z_MIN, clamp } from "./math";

type Listener = () => void;

const coarseListeners = new Set<Listener>();

let camera: Camera = { x: 0, y: 0, z: 1 };
let coarseZ = 1;
let coarseTimer = 0;
let raf = 0;

export type ApplyReason = "gesture" | "idle" | "program";

type Applier = (cam: Camera, reason: ApplyReason) => void;

let applier: Applier | null = null;

export function getCamera(): Camera {
  return camera;
}

export function getCoarseZoom(): number {
  return coarseZ;
}

export function subscribeCoarse(onStoreChange: Listener): () => void {
  coarseListeners.add(onStoreChange);
  return () => {
    coarseListeners.delete(onStoreChange);
  };
}

export function attachCameraApplier(fn: Applier | null): void {
  applier = fn;
}

export function setCameraValue(next: Camera): void {
  camera = {
    x: next.x,
    y: next.y,
    z: clamp(next.z, INTERACTIVE_Z_MIN, INTERACTIVE_Z_MAX),
  };
  scheduleApply("gesture");
  bumpCoarse();
}

/** Programmatic writes (fit, lock-in, animation ticks) skip the interactive z-floor. */
export function setCameraExact(next: Camera, reason: ApplyReason = "program"): void {
  camera = { x: next.x, y: next.y, z: next.z };
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  applier?.(camera, reason);
  bumpCoarse();
}

export function scheduleApply(reason: ApplyReason): void {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    applier?.(camera, reason);
  });
}

function bumpCoarse(): void {
  if (coarseTimer) return;
  coarseTimer = window.setTimeout(() => {
    coarseTimer = 0;
    if (coarseZ === camera.z) return;
    coarseZ = camera.z;
    for (const fn of coarseListeners) fn();
  }, 100);
}

export function seedCamera(next: Camera): void {
  camera = next;
  coarseZ = next.z;
}

export function flushCoarse(): void {
  if (coarseTimer) {
    clearTimeout(coarseTimer);
    coarseTimer = 0;
  }
  if (coarseZ !== camera.z) {
    coarseZ = camera.z;
    for (const fn of coarseListeners) fn();
  }
}
